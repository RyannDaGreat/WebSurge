/*
 * surge_gui_host.cpp -- runs Surge XT's real GUI in a browser tab.
 *
 * This instantiates the ACTUAL SurgeSynthEditor / SurgeGUIEditor -- the same
 * classes the desktop plugin uses -- attaches them to the WasmComponentPeer in
 * host/surge_wasm/, and hands JavaScript two things:
 *
 *   - a pointer to an RGBA pixel buffer to blit into a <canvas>
 *   - entry points to inject mouse, wheel and keyboard events
 *
 * So the pixels on screen are drawn by Surge's own paint code using Surge's own
 * embedded fonts. Nothing about the interface is reimplemented here.
 *
 * The audio engine lives in surge_host.cpp on the AudioWorklet thread; this
 * file is the main-thread half.
 */

#include "SurgeSynthEditor.h"
#include "SurgeSynthProcessor.h"

#include <surge_wasm/WasmPeerAccess.h>

#include <juce_gui_basics/juce_gui_basics.h>

#include <emscripten/emscripten.h>

#include <cmath>
#include <cstdlib>
#include <cstdint>
#include <memory>
#include <vector>

namespace
{

/*
 * JUCE needs initialising before any Component exists. There is no run loop to
 * enter -- the page's event loop is the run loop -- so surgewasm::pumpMessages()
 * is called from sgui_render() instead.
 */
struct JuceRuntime
{
    JuceRuntime() { juce::initialiseJuce_GUI(); }
    ~JuceRuntime() { juce::shutdownJuce_GUI(); }
};

std::unique_ptr<JuceRuntime> gRuntime;
std::unique_ptr<SurgeSynthProcessor> gProcessor;
std::unique_ptr<juce::AudioProcessorEditor> gEditor;

/*
 * Canvas ImageData is RGBA in memory order; juce::Image::ARGB is a PixelARGB,
 * which is BGRA in memory on a little-endian target. Swizzling here keeps the
 * per-frame byte loop in wasm rather than in JS over a typed array.
 */
std::vector<uint8_t> gRgba;

/* Peer count at the last frame; a change means a popup opened or closed. */
int gLastPeerCount = 0;

/*
 * A timer that does nothing but count, to tell "JUCE timers are not firing"
 * apart from "Surge's editor is declining to refresh". Diagnostics only.
 */
struct TickCounter : juce::Timer
{
    int ticks = 0;
    void timerCallback() override { ++ticks; }
};

std::unique_ptr<TickCounter> gTicker;

} // namespace

extern "C"
{

    /*
     * Command. Builds the real Surge editor and attaches it to a peer.
     * Returns 1 on success, 0 if already initialised or the editor was refused.
     */
    EMSCRIPTEN_KEEPALIVE
    int sgui_init (const char *dataPath)
    {
        if (gEditor)
            return 0;

        /*
         * Point Surge at the mounted resource tree BEFORE the synth exists.
         *
         * SurgeStorage scans for patches and wavetables in its own constructor,
         * so setting this afterwards would be too late -- the lists would stay
         * empty and the patch browser and jog buttons would do nothing.
         *
         * SurgeSynthProcessor takes no data-path argument, but SurgeStorage
         * honours SURGE_DATA_HOME (SurgeStorage.cpp:1950), which is the only
         * hook available without patching Surge.
         */
        if (dataPath != nullptr && *dataPath != '\0')
            setenv ("SURGE_DATA_HOME", dataPath, 1);

        gRuntime = std::make_unique<JuceRuntime>();
        gProcessor = std::make_unique<SurgeSynthProcessor>();

        // createEditor() is the call a DAW makes. Going through it rather than
        // constructing SurgeSynthEditor directly keeps all of Surge's own wiring.
        gEditor.reset (gProcessor->createEditor());
        if (gEditor == nullptr)
            return 0;

        // Tell JUCE the display is exactly the editor, BEFORE it goes on the
        // desktop. Popup menus are positioned to fit the display, so this is
        // what keeps them from being placed off-canvas and clipped.
        surgewasm::setDisplaySize (gEditor->getWidth(), gEditor->getHeight());

        // addToDesktop is what creates a ComponentPeer -- ours. Without it the
        // component tree exists but nothing ever paints.
        gEditor->addToDesktop (0);
        gEditor->setVisible (true);
        surgewasm::invalidateAll();

        gTicker = std::make_unique<TickCounter>();
        gTicker->startTimer (1000 / 60);

        return 1;
    }

    /*
     * Query. How many patches Surge itself found by scanning its data path.
     *
     * This is the honest test of whether the resource tree is mounted. Zero here
     * means the Category/Patch jog buttons will do nothing and Surge's own patch
     * browser will be empty, however well the sidebar works -- the sidebar is a
     * separate JS index and proves nothing about what Surge knows.
     */
    EMSCRIPTEN_KEEPALIVE
    int sgui_patch_count()
    {
        return gProcessor ? (int) gProcessor->surge->storage.patch_list.size() : 0;
    }

    /* Query. How many wavetables Surge found. Same reasoning as above. */
    EMSCRIPTEN_KEEPALIVE
    int sgui_wt_count()
    {
        return gProcessor ? (int) gProcessor->surge->storage.wt_list.size() : 0;
    }

    /* Query. Editor width in LOGICAL pixels, as Surge itself sized it. */
    EMSCRIPTEN_KEEPALIVE
    int sgui_width() { return gEditor ? gEditor->getWidth() : 0; }

    /* Query. Editor height in LOGICAL pixels. */
    EMSCRIPTEN_KEEPALIVE
    int sgui_height() { return gEditor ? gEditor->getHeight() : 0; }

    /*
     * Query. Canvas size in PHYSICAL pixels -- logical size times the render
     * scale. This is what the canvas backing store must be, and how many bytes
     * sgui_pixels() holds. Confusing it with the logical size is the classic
     * HiDPI bug in both directions.
     */
    EMSCRIPTEN_KEEPALIVE
    int sgui_canvas_width()
    {
        return gEditor ? (int) lround (gEditor->getWidth() * surgewasm::getScaleFactor()) : 0;
    }

    EMSCRIPTEN_KEEPALIVE
    int sgui_canvas_height()
    {
        return gEditor ? (int) lround (gEditor->getHeight() * surgewasm::getScaleFactor()) : 0;
    }

    /*
     * Command. Pumps JUCE's timers/messages and repaints if anything is dirty.
     *
     * Returns 1 if the pixel buffer changed and should be uploaded to the
     * canvas, 0 if the frame is unchanged and the upload can be skipped.
     */
    EMSCRIPTEN_KEEPALIVE
    int sgui_render()
    {
        if (! gEditor)
            return 0;

        surgewasm::pumpMessages();

        /*
         * Execute anything the UI queued for the audio thread -- above all, patch
         * loads.
         *
         * jogPatch() and the patch browser do not load a patch; they set
         * patchid_queue and expect process() to pick it up. This instance never
         * calls process() (the engine in the worklet does the audio), so without
         * this pump the Category/Patch jog buttons visibly depress and then
         * nothing happens. Surge provides this exact entry point for hosts where
         * the audio thread is not running.
         */
        if (gProcessor)
            gProcessor->surge->processAudioThreadOpsWhenAudioEngineUnavailable();

        const bool painted = surgewasm::renderAllDirty();

        // A menu opening or closing changes the stack without necessarily
        // dirtying anything, so recomposite whenever the peer count moves.
        const int peers = surgewasm::peerCount();
        const bool stackChanged = (peers != gLastPeerCount);
        gLastPeerCount = peers;

        if (! painted && ! stackChanged)
            return 0;

        // ALWAYS canvas-sized. The buffer must match what JS uploads: sizing it
        // to the front peer instead is what let a small popup's image be read as
        // if it were a full frame, smearing heap bytes across the panel.
        const int w = sgui_canvas_width();
        const int h = sgui_canvas_height();
        if (w <= 0 || h <= 0)
            return 0;

        gRgba.resize ((size_t) w * h * 4);
        surgewasm::compositeInto (gRgba.data(), w, h);
        return 1;
    }

    /* Query. Pointer to the RGBA buffer filled by sgui_render. */
    EMSCRIPTEN_KEEPALIVE
    uint8_t *sgui_pixels() { return gRgba.data(); }

    /*
     * Command. Sets the rendering scale: user zoom multiplied by device pixel
     * ratio. 1.0 is Surge's native 913x569.
     *
     * The editor's reported size changes with this, so JS must resize the canvas
     * to sgui_width()/sgui_height() afterwards.
     */
    EMSCRIPTEN_KEEPALIVE
    void sgui_set_scale (float scale)
    {
        if (! gEditor || scale <= 0.0f)
            return;

        surgewasm::setScaleFactor (scale);

        // The display must track the scaled canvas, or popup menus get fitted to
        // the wrong bounds and land off-screen again.
        surgewasm::setDisplaySize (gEditor->getWidth(), gEditor->getHeight());
    }

    /* Query. The current rendering scale. */
    EMSCRIPTEN_KEEPALIVE
    float sgui_get_scale() { return surgewasm::getScaleFactor(); }

    /* Command. Forces a full repaint. */
    EMSCRIPTEN_KEEPALIVE
    void sgui_invalidate() { surgewasm::invalidateAll(); }

    //== input =================================================================

    /* Command. Delivers a mouse event. kind: 0 move, 1 down, 2 up. */
    EMSCRIPTEN_KEEPALIVE
    void sgui_mouse (int kind, float x, float y, int buttons, int shift, int ctrl, int alt)
    {
        surgewasm::mouseEvent (kind, x, y, buttons, shift != 0, ctrl != 0, alt != 0);
    }

    /* Command. Delivers a scroll-wheel event. */
    EMSCRIPTEN_KEEPALIVE
    void sgui_wheel (float x, float y, float dx, float dy, int shift, int ctrl, int alt)
    {
        surgewasm::wheelEvent (x, y, dx, dy, shift != 0, ctrl != 0, alt != 0);
    }

    /* Command. Delivers a key event. Returns 1 if Surge consumed it. */
    EMSCRIPTEN_KEEPALIVE
    int sgui_key (int isDown, int keyCode, int textChar, int shift, int ctrl, int alt)
    {
        return surgewasm::keyEvent (isDown != 0, keyCode, textChar,
                                    shift != 0, ctrl != 0, alt != 0)
                   ? 1
                   : 0;
    }

    /* Command. Notifies the editor that the page gained or lost focus. */
    EMSCRIPTEN_KEEPALIVE
    void sgui_focus (int gained) { surgewasm::setFocus (gained != 0); }

    //== parameter bridge to the audio thread ==================================
    /*
     * The GUI runs on the main thread with its own SurgeSynthesizer, and the
     * audio engine runs in an AudioWorklet with a second one. They are the same
     * Surge build, so parameter indices match exactly -- but they are separate
     * objects, and without a bridge turning a knob would move the picture and
     * not the sound.
     *
     * The GUI's synth is the source of truth: Surge's own widgets edit it, with
     * all of Surge's snapping, bipolar and tempo-sync behaviour intact. Each
     * frame JS reads the value block below, diffs it, and posts only what moved
     * to the worklet. 766 floats per frame is nothing next to the repaint.
     */

    /* Query. Number of parameters, matching the audio engine's indexing. */
    EMSCRIPTEN_KEEPALIVE
    int sgui_param_count()
    {
        if (! gProcessor)
            return 0;
        return (int) gProcessor->surge->storage.getPatch().param_ptr.size();
    }

    /*
     * Command. Writes every parameter's normalized value into `out`.
     *
     * out must have room for sgui_param_count() floats.
     */
    EMSCRIPTEN_KEEPALIVE
    void sgui_read_params (float *out)
    {
        if (! gProcessor || out == nullptr)
            return;

        auto &patch = gProcessor->surge->storage.getPatch();
        const int n = (int) patch.param_ptr.size();
        for (int i = 0; i < n; ++i)
            out[i] = patch.param_ptr[i] != nullptr ? patch.param_ptr[i]->get_value_f01() : 0.0f;
    }

    /*
     * Query. Pointer to the GUI synth, so patch loading can go through the same
     * instance the editor is displaying.
     */
    EMSCRIPTEN_KEEPALIVE
    int sgui_load_patch_path (const char *path, const char *name)
    {
        if (! gProcessor || path == nullptr)
            return 0;

        auto *synth = gProcessor->surge.get();

        // Look the path up in Surge's own list first, exactly as
        // SurgeSynthesizer does for a queued path load.
        //
        // This is not a nicety. SurgeGUIEditor decides a patch changed by
        // comparing patchSelector->sel_id against synth->patchid, and
        // loadPatchByPath never touches patchid -- so a load that goes straight
        // there leaves the name in the panel reading the PREVIOUS patch even
        // though the sound has changed. Going through loadPatch() also keeps the
        // Category/Patch jog buttons stepping from where the user actually is.
        int ptid = -1, ct = 0;

        for (const auto &p : synth->storage.patch_list)
        {
            if (path_to_string (p.path) == path)
            {
                ptid = ct;
                break;
            }
            ct++;
        }

        if (ptid >= 0)
        {
            synth->loadPatch (ptid);
            synth->storage.lastLoadedPatch = synth->storage.patch_list[ptid].path;
            return 1;
        }

        // Not in the list: a patch fetched on demand, which Surge never scanned.
        // There is no patchid change for the editor to notice, so ask it to
        // rebuild explicitly or the panel keeps the old name.
        if (! synth->loadPatchByPath (path, -1, name ? name : "Patch"))
            return 0;

        synth->refresh_editor = true;
        return 1;
    }

    /**
     * Diagnostics for the browser tests. Not used by the app.
     *
     * refresh_editor is the interesting one: SurgeGUIEditor clears it the first
     * time its idle() reaches the rebuild branch, so a value that stays 1 after
     * a patch load proves idle() is either not running or bailing out of its
     * `editor_open && frame && !halt_engine` guard.
     */
    /*
     * Command. MIDI pitch bend, on the GUI's own synth.
     *
     * Sound comes from the engine in the worklet, so why send it here too?
     * Because this instance owns the parameter state that the panel draws and
     * that gets diffed to the worklet every frame. A controller that moved only
     * the engine would be invisible in the modulation display, and any macro it
     * drove would be fought over by the next parameter diff.
     *
     * Same reasoning as patch loads, which also go to both.
     */
    EMSCRIPTEN_KEEPALIVE
    void sgui_pitch_bend (int channel, int value)
    {
        if (! gProcessor)
            return;
        gProcessor->surge->pitchBend (static_cast<char> (channel), value);
    }

    /* Command. MIDI continuous controller, on the GUI's own synth. */
    EMSCRIPTEN_KEEPALIVE
    void sgui_cc (int channel, int cc, int value)
    {
        if (! gProcessor)
            return;
        gProcessor->surge->channelController (static_cast<char> (channel), cc, value);
    }

    /*
     * Command. Sets macro `i` to `value` in 0..1.
     *
     * This is the real way to move a macro, and it is NOT a MIDI CC. An earlier
     * version sent CC 41-48 on the assumption that Surge maps those by default;
     * it does not. Nothing was mapped, so the knobs moved and no parameter
     * changed -- measured as 0 of 766 parameters differing.
     *
     * Macros are what a hardware synth's assignable knobs are: per-patch named
     * modulation sources (see sgui_macro_name), routed by the patch's own
     * modulation matrix.
     */
    EMSCRIPTEN_KEEPALIVE
    void sgui_set_macro (int i, float value)
    {
        if (! gProcessor || i < 0 || i >= n_customcontrollers)
            return;
        gProcessor->surge->setMacroParameter01 (i, value);
    }

    /*
     * Query. Macro `i`'s TARGET value, 0..1.
     *
     * The target, not getMacroParameter01(). That one returns the modulation
     * source's smoothed OUTPUT, which only advances while the synth processes
     * audio -- and this instance never calls process(), the engine in the worklet
     * does. So the output here sits at 0 forever no matter what is set, and
     * reading it made a freshly-set macro read back as 0.000.
     *
     * The target is what the knob was moved to, available immediately, and is
     * what should be both displayed and forwarded. The engine smooths toward it.
     */
    EMSCRIPTEN_KEEPALIVE
    float sgui_get_macro (int i)
    {
        if (! gProcessor || i < 0 || i >= n_customcontrollers)
            return 0.0f;
        return gProcessor->surge->getMacroParameterTarget01 (i);
    }

    /*
     * Query. The patch's own name for macro `i`, or "" if out of range.
     *
     * Patches rename these -- a loaded patch shows "How Messy?" rather than
     * "Macro 3" -- which is exactly the per-preset knob assignment a hardware
     * synth gives you. Exposed so the browser chrome can label real controls
     * instead of numbering them.
     */
    EMSCRIPTEN_KEEPALIVE
    const char *sgui_macro_name (int i)
    {
        if (! gProcessor || i < 0 || i >= n_customcontrollers)
            return "";
        return gProcessor->surge->storage.getPatch().CustomControllerLabel[i];
    }

    /* Query. How many macros this Surge build has. */
    EMSCRIPTEN_KEEPALIVE
    int sgui_macro_count() { return n_customcontrollers; }

    EMSCRIPTEN_KEEPALIVE
    int sgui_dbg_refresh_pending()
    {
        return (gProcessor && gProcessor->surge->refresh_editor) ? 1 : 0;
    }

    EMSCRIPTEN_KEEPALIVE
    int sgui_dbg_patchid() { return gProcessor ? gProcessor->surge->patchid : -999; }

    EMSCRIPTEN_KEEPALIVE
    int sgui_dbg_ticks() { return gTicker ? gTicker->ticks : -1; }

    EMSCRIPTEN_KEEPALIVE
    int sgui_dbg_halt() { return (gProcessor && gProcessor->surge->halt_engine) ? 1 : 0; }

    EMSCRIPTEN_KEEPALIVE
    int sgui_dbg_headless() { return juce::Desktop::getInstance().isHeadless() ? 1 : 0; }

    EMSCRIPTEN_KEEPALIVE
    const char *sgui_dbg_patch_name()
    {
        return gProcessor ? gProcessor->surge->storage.getPatch().name.c_str() : "";
    }

} // extern "C"
