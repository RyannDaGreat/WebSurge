/*
 * juce_FileChooser_wasm.cpp -- file dialogs for the WebAssembly target.
 *
 * A browser has no native file dialog that can browse an Emscripten MEMFS path,
 * and the real picker can only be summoned from a user gesture. Surge reaches
 * for these when importing a patch or wavetable.
 *
 * Rather than fake one, this reports honestly that no platform dialog exists.
 * That is the load-bearing part: JUCE then falls back to its OWN cross-platform
 * FileChooser, which is built from juce::Components and so renders through the
 * same peer as the rest of Surge, browsing the Emscripten filesystem where
 * Surge's data is mounted. The user gets a working browser, drawn by JUCE.
 *
 * Included from juce_gui_basics.cpp's JUCE_WASM branch.
 */

namespace juce
{

/*
 * Query. Whether a native (OS) file dialog is available.
 *
 * Always false here, which routes JUCE to its built-in FileChooser component.
 */
bool FileChooser::isPlatformDialogAvailable()
{
    return false;
}

std::shared_ptr<FileChooser::Pimpl> FileChooser::showPlatformDialog (FileChooser &,
                                                                     int,
                                                                     FilePreviewComponent *)
{
    // Unreachable: JUCE only calls this when isPlatformDialogAvailable() is
    // true. Assert rather than returning silently, because arriving here would
    // mean that contract changed and the user would get a dialog that never
    // appears -- a silent failure.
    jassertfalse;
    return nullptr;
}

} // namespace juce
