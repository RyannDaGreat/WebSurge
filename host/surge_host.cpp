/*
 * surge_host.cpp -- WebAssembly host for the Surge XT synthesis engine.
 *
 * This is the seam between Surge's C++ engine and the browser. It owns a single
 * SurgeSynthesizer instance and exposes a flat C API that Emscripten exports to
 * JavaScript.
 *
 * WHY A DIRECT SurgeSynthesizer HOST (and not CLAP, and not JUCE)
 * ---------------------------------------------------------------
 * Surge's GUI is JUCE, which has no Emscripten target. But Surge deliberately
 * supports building its engine with no JUCE at all -- that is how it embeds in
 * VCV Rack (CMake's SURGE_SKIP_JUCE_FOR_RACK). Surge's own Python bindings
 * drive the engine exactly this way: construct SurgeSynthesizer, call process(),
 * read storage.getPatch().param_ptr. We do the same. No plugin ABI in between.
 *
 * HOW THE GUI BINDS
 * -----------------
 * Every Surge Parameter carries a `ui_identifier` such as "filter.cutoff_1".
 * Desktop Surge places each control by looking that string up:
 *     Connector::connectorByID(p->ui_identifier)      [SurgeGUIEditor.cpp]
 * src/layout.json is a dump of that same connector registry, so the browser GUI
 * performs the identical lookup. Same ids, same coordinates, same artwork --
 * the layout is not approximated.
 *
 * THREADING
 * ---------
 * Single-threaded by design. A -pthread build would need SharedArrayBuffer and
 * therefore COOP/COEP headers, which would break "serve the folder statically".
 */

#include "SurgeSynthesizer.h"
#include "SurgeStorage.h"
#include "Parameter.h"

#include <emscripten/emscripten.h>

#include <cstdio>
#include <cstring>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

namespace
{

/*
 * SurgeSynthesizer reports parameter and macro edits back to its host so a DAW
 * can update its own automation view. The browser GUI polls instead, so these
 * are intentionally empty -- not stubs hiding an error, just an unused channel.
 */
class BrowserPluginLayer : public SurgeSynthesizer::PluginLayer
{
  public:
    void surgeParameterUpdated(const SurgeSynthesizer::ID &, float) override {}
    void surgeMacroUpdated(long, float) override {}
};

std::unique_ptr<BrowserPluginLayer> gLayer;
std::unique_ptr<SurgeSynthesizer> gSynth;

/*
 * Surge renders in fixed blocks of BLOCK_SIZE (32) frames. An AudioWorklet asks
 * for 128, which divides evenly -- but relying on that would break the moment a
 * caller asks for anything else. Instead we keep whatever a block produced past
 * the end of a request and hand it out first next time.
 */
std::vector<float> gCarryL, gCarryR;
size_t gCarryPos = 0;

/* Scratch storage for strings handed back to JS. Valid until the next call. */
std::string gScratch;

/*
 * TEMPO -- why a host that ignores it is not merely incomplete but wrong.
 *
 * Every tempo-synced time in Surge (delay times, LFO rates, temposynced
 * envelope segments) is scaled by storage.temposyncratio, which
 * SurgeSynthesizer::processControl() recomputes on every 32-frame block as
 *
 *     temposyncratio     = time_data.tempo / 120
 *     temposyncratio_inv = 1 / temposyncratio
 *
 * unconditionally -- there is no "no tempo" branch on that path. A host that
 * never writes time_data.tempo leaves it at 0, so the ratio is 0 and its
 * reciprocal is +inf. sst::effects::Delay then computes
 *
 *     timeL = sampleRate * temposyncratio_inv * 2^(time param)   -> +inf
 *
 * and clamps it to its 262144-sample buffer: a 5.46 s echo at 48 kHz that
 * exists in no patch. Temposynced LFOs and envelopes get the mirror-image
 * problem, a rate multiplied by 0, and freeze.
 *
 * Desktop Surge never reaches this state. In a DAW the playhead supplies a
 * tempo; in the standalone build SurgeSynthProcessor falls back to a fixed
 * 120 BPM (its `standaloneTempo` member) and calls resetStateFromTimeData()
 * every block. The browser is the standalone case, so we do the same.
 *
 * Not replicated: SurgeSynthProcessor also adopts storage.unstreamedTempo on
 * patch load. That is gated on the `overrideTempoOnPatchLoad` user preference,
 * which is off by default and makes unstreamedTempo -1, so default desktop
 * behaviour is to ignore the patch's saved tempo. We ignore it too.
 */
constexpr double kDefaultTempoBPM = 120.0;
double gTempoBPM = kDefaultTempoBPM;

/*
 * Command. Pushes gTempoBPM into the synth and recomputes the derived tempo
 * state (temposyncratio, songpos, isPlaying). Requires gSynth to exist.
 *
 * Mirrors SurgeSynthProcessor::processBlockPlayhead()'s standalone branch.
 */
void applyTempo()
{
    gSynth->time_data.tempo = gTempoBPM;
    gSynth->time_data.timeSigNumerator = 4;
    gSynth->time_data.timeSigDenominator = 4;
    // Standalone Surge always reports the transport as running, so modulators
    // that key off song position advance instead of sitting frozen at bar zero.
    gSynth->time_data.isPlaying = true;
    gSynth->resetStateFromTimeData();
}

/* Pure function. Escapes a string for embedding in JSON. */
std::string jsonEscape(const std::string &s)
{
    std::string out;
    for (char c : s)
    {
        switch (c)
        {
        case '"': out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        default:
            if (static_cast<unsigned char>(c) < 0x20)
                continue; // drop other control characters rather than emit invalid JSON
            out += c;
        }
    }
    return out;
}

} // namespace

extern "C"
{

    /*
     * Command. Creates the synth at the given sample rate.
     *
     * dataPath is where Surge should look for its factory resources inside the
     * Emscripten filesystem (patches, wavetables, impulses). It must be passed
     * explicitly: on the Linux code path Surge otherwise derives an install
     * directory from its own shared-object location, which does not exist in a
     * WebAssembly module. Pass "" only if no resources are mounted.
     *
     * Returns 1 on success, 0 if already initialized.
     */
    EMSCRIPTEN_KEEPALIVE
    int sh_init(float sampleRate, const char *dataPath)
    {
        if (gSynth)
            return 0;

        gLayer = std::make_unique<BrowserPluginLayer>();
        gSynth = std::make_unique<SurgeSynthesizer>(gLayer.get(), dataPath ? dataPath : "");
        gSynth->setSamplerate(sampleRate);

        gSynth->time_data.ppqPos = 0.0;
        applyTempo();

        gCarryL.clear();
        gCarryR.clear();
        gCarryPos = 0;
        return 1;
    }

    /* Query. Number of exposed parameters, or 0 before sh_init. */
    EMSCRIPTEN_KEEPALIVE
    int sh_param_count()
    {
        if (!gSynth)
            return 0;
        return static_cast<int>(gSynth->storage.getPatch().param_ptr.size());
    }

    /*
     * Query. Full parameter table as JSON, including each parameter's
     * `ui_identifier` -- the key that binds it to a connector in layout.json.
     *
     * Called once at startup; the GUI is built from the result. Names and
     * ui_identifiers can change when an oscillator or FX type changes, so the
     * GUI re-reads this after such edits rather than caching forever.
     *
     * The returned pointer is owned by the host and is valid until the next
     * call into any sh_* function that returns a string.
     */
    EMSCRIPTEN_KEEPALIVE
    const char *sh_metadata_json()
    {
        if (!gSynth)
        {
            gScratch = "{\"error\": \"sh_init has not been called\"}";
            return gScratch.c_str();
        }

        auto &patch = gSynth->storage.getPatch();
        std::ostringstream o;
        o << "{\"params\":[";

        for (size_t i = 0; i < patch.param_ptr.size(); ++i)
        {
            auto *p = patch.param_ptr[i];
            if (!p)
                continue;
            if (i)
                o << ",";
            o << "{"
              << "\"index\":" << i << ","
              << "\"id\":" << p->id << ","
              << "\"uiid\":\"" << jsonEscape(p->ui_identifier) << "\","
              << "\"name\":\"" << jsonEscape(p->name) << "\","
              << "\"dispname\":\"" << jsonEscape(p->dispname) << "\","
              << "\"fullname\":\"" << jsonEscape(p->fullname) << "\","
              << "\"scene\":" << p->scene << ","
              << "\"ctrltype\":" << p->ctrltype << ","
              << "\"ctrlstyle\":" << p->ctrlstyle << ","
              << "\"ctrlgroup\":" << static_cast<int>(p->ctrlgroup) << ","
              << "\"ctrlgroup_entry\":" << p->ctrlgroup_entry << ","
              << "\"valtype\":" << p->valtype << ","
              << "\"modulateable\":" << (p->modulateable ? "true" : "false") << ","
              << "\"bipolar\":" << (p->is_bipolar() ? "true" : "false") << ","
              << "\"value\":" << p->get_value_f01() << ","
              << "\"display\":\"" << jsonEscape(p->get_display()) << "\""
              << "}";
        }
        o << "]}";

        gScratch = o.str();
        return gScratch.c_str();
    }

    /*
     * Query. Normalized (0..1) value of a parameter by synth-side index.
     *
     * The raw long-indexed overloads of get/setParameter01 are private; the
     * public API is keyed by SurgeSynthesizer::ID, which fromSynthSideId builds.
     * Going through ID is also what keeps us honest about invalid indices.
     */
    EMSCRIPTEN_KEEPALIVE
    float sh_get_param(int index)
    {
        if (!gSynth)
            return 0.f;
        SurgeSynthesizer::ID id;
        if (!gSynth->fromSynthSideId(index, id))
            return 0.f;
        return gSynth->getParameter01(id);
    }

    /* Command. Sets a parameter from a normalized (0..1) value. */
    EMSCRIPTEN_KEEPALIVE
    void sh_set_param(int index, float value)
    {
        if (!gSynth)
            return;
        SurgeSynthesizer::ID id;
        if (!gSynth->fromSynthSideId(index, id))
            return;
        gSynth->setParameter01(id, value, true);
    }

    /*
     * Query. Human-readable value text for a parameter, e.g. "440.00 Hz".
     * Pointer valid until the next string-returning sh_* call.
     */
    EMSCRIPTEN_KEEPALIVE
    const char *sh_param_display(int index)
    {
        gScratch.clear();
        if (!gSynth)
            return gScratch.c_str();

        auto &patch = gSynth->storage.getPatch();
        if (index < 0 || index >= static_cast<int>(patch.param_ptr.size()))
            return gScratch.c_str();

        auto *p = patch.param_ptr[index];
        if (p)
            gScratch = p->get_display();
        return gScratch.c_str();
    }

    /* Command. Note on. Velocity 0 is treated as note off by Surge convention. */
    EMSCRIPTEN_KEEPALIVE
    void sh_note_on(int channel, int key, int velocity)
    {
        if (!gSynth)
            return;
        gSynth->playNote(static_cast<char>(channel), static_cast<char>(key),
                         static_cast<char>(velocity), 0);
    }

    /* Command. Note off. */
    EMSCRIPTEN_KEEPALIVE
    void sh_note_off(int channel, int key, int velocity)
    {
        if (!gSynth)
            return;
        gSynth->releaseNote(static_cast<char>(channel), static_cast<char>(key),
                            static_cast<char>(velocity));
    }

    /* Command. Pitch bend; value is the raw 14-bit signed offset Surge expects. */
    EMSCRIPTEN_KEEPALIVE
    void sh_pitch_bend(int channel, int value)
    {
        if (!gSynth)
            return;
        gSynth->pitchBend(static_cast<char>(channel), value);
    }

    /* Command. MIDI continuous controller. */
    EMSCRIPTEN_KEEPALIVE
    void sh_cc(int channel, int cc, int value)
    {
        if (!gSynth)
            return;
        gSynth->channelController(static_cast<char>(channel), cc, value);
    }

    /* Command. Silences every sounding voice. Used on focus loss. */
    EMSCRIPTEN_KEEPALIVE
    void sh_all_notes_off()
    {
        if (!gSynth)
            return;
        gSynth->allNotesOff();
    }

    /*
     * Command. Loads a patch from a .fxp file already present in the Emscripten
     * filesystem.
     *
     * Surge's own loader parses the fxp wrapper, so the browser never
     * reimplements the format -- JS fetches the bytes, writes them to MEMFS, and
     * calls this. Returns 1 on success, 0 on failure.
     */
    EMSCRIPTEN_KEEPALIVE
    int sh_load_patch_path(const char *path, const char *displayName)
    {
        if (!gSynth || !path)
            return 0;
        return gSynth->loadPatchByPath(path, -1, displayName ? displayName : "Patch") ? 1 : 0;
    }

    /*
     * Command. Renders `nframes` of stereo audio into outL/outR.
     *
     * Surge produces fixed 32-frame blocks; leftovers are carried between calls
     * so any nframes is valid. Returns frames written.
     *
     * outL, outR: caller-owned float buffers of at least nframes.
     */
    EMSCRIPTEN_KEEPALIVE
    int sh_render(float *outL, float *outR, int nframes)
    {
        if (!gSynth || !outL || !outR || nframes <= 0)
            return 0;

        int written = 0;

        while (written < nframes)
        {
            // Drain anything left over from the previous block first.
            if (gCarryPos < gCarryL.size())
            {
                const size_t avail = gCarryL.size() - gCarryPos;
                const size_t want = static_cast<size_t>(nframes - written);
                const size_t n = avail < want ? avail : want;

                std::memcpy(outL + written, gCarryL.data() + gCarryPos, n * sizeof(float));
                std::memcpy(outR + written, gCarryR.data() + gCarryPos, n * sizeof(float));
                gCarryPos += n;
                written += static_cast<int>(n);
                continue;
            }

            gSynth->process();

            const int block = gSynth->getBlockSize();

            // Advance the transport exactly as SurgeSynthProcessor does after
            // each engine block, so song-position-driven modulation keeps time.
            gSynth->time_data.ppqPos += static_cast<double>(block) * gSynth->time_data.tempo /
                                        (60.0 * gSynth->storage.samplerate);

            gCarryL.assign(gSynth->output[0], gSynth->output[0] + block);
            gCarryR.assign(gSynth->output[1], gSynth->output[1] + block);
            gCarryPos = 0;
        }

        return written;
    }

    /*
     * Command. Sets the tempo every tempo-synced parameter is measured against.
     *
     * There is no host transport in a browser tab, so this is the only way the
     * tempo can ever change; without it the engine stays at kDefaultTempoBPM.
     * Returns 1 on success, 0 if the synth does not exist or bpm is not
     * positive -- a non-positive tempo is precisely the bug this exists to
     * prevent, so it is refused loudly rather than clamped.
     */
    EMSCRIPTEN_KEEPALIVE
    int sh_set_tempo(float bpm)
    {
        if (!gSynth)
        {
            std::fprintf(stderr, "sh_set_tempo: sh_init has not been called\n");
            return 0;
        }
        if (!(bpm > 0.f))
        {
            std::fprintf(stderr, "sh_set_tempo: refusing non-positive tempo %f BPM\n",
                         static_cast<double>(bpm));
            return 0;
        }
        gTempoBPM = bpm;
        applyTempo();
        return 1;
    }

    /* Query. Current tempo in BPM. */
    EMSCRIPTEN_KEEPALIVE
    float sh_get_tempo() { return static_cast<float>(gTempoBPM); }

    /* Query. Surge's internal block size (32). */
    EMSCRIPTEN_KEEPALIVE
    int sh_block_size() { return gSynth ? gSynth->getBlockSize() : 0; }

    /*
     * Query. Path Surge resolved as its factory data root.
     * Useful for confirming the mounted resource tree is where Surge expects.
     */
    EMSCRIPTEN_KEEPALIVE
    const char *sh_data_path()
    {
        gScratch.clear();
        if (gSynth)
            gScratch = gSynth->storage.datapath.u8string();
        return gScratch.c_str();
    }

} // extern "C"
