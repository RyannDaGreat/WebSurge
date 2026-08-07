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

} // namespace

extern "C"
{

    /*
     * Command. Builds the real Surge editor and attaches it to a peer.
     * Returns 1 on success, 0 if already initialised or the editor was refused.
     */
    EMSCRIPTEN_KEEPALIVE
    int sgui_init()
    {
        if (gEditor)
            return 0;

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

        return 1;
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
        return gProcessor->surge->loadPatchByPath (path, -1, name ? name : "Patch") ? 1 : 0;
    }

} // extern "C"
