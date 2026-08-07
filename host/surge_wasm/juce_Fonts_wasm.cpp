/*
 * juce_Fonts_wasm.cpp -- JUCE's font backend for WebAssembly.
 *
 * JUCE's FreeType typeface machinery (juce_Fonts_freetype.cpp) is already
 * platform-neutral and compiles for wasm unchanged. What each platform must
 * still supply is the part that answers "where do system fonts live, and what
 * is the default one" -- juce_Fonts_linux.cpp does that with fontconfig.
 *
 * A browser has no system fonts and no fontconfig. That is fine here, because
 * Surge does not rely on them: it embeds Lato, IndieFlower and FiraMono in
 * SurgeXTBinary and installs them itself (see RuntimeFont.cpp). So the honest
 * implementation reports no font directories and no platform default, and lets
 * Surge's own typefaces do the work.
 *
 * Included from juce_graphics.cpp's JUCE_WASM branch.
 */

namespace juce
{

/*
 * Query. Directories to scan for system fonts.
 *
 * Empty: MEMFS contains only what we mount, and we mount patches and
 * wavetables, not fonts. Returning a plausible-looking path that holds nothing
 * would just make font enumeration silently slow and still empty.
 */
StringArray FTTypefaceList::getDefaultFontDirectories() { return {}; }

/* Command. Adds any fonts in `folder` to the typeface list. */
void Typeface::scanFolderForFonts (const File &folder)
{
    FTTypefaceList::getInstance()->scanFontPaths (StringArray (folder.getFullPathName()));
}

/* Query. Families known to the typeface list -- i.e. whatever Surge registered. */
StringArray Font::findAllTypefaceNames()
{
    return FTTypefaceList::getInstance()->findAllFamilyNames();
}

/* Query. Styles available within one family. */
StringArray Font::findAllTypefaceStyles (const String &family)
{
    return FTTypefaceList::getInstance()->findAllTypefaceStyles (family);
}

/*
 * Query. The platform's default typeface for a given font.
 *
 * There is none. Returning nullptr makes JUCE fall through to whatever typeface
 * has actually been registered, which is exactly what we want: Surge installs
 * its embedded fonts at startup and names them explicitly everywhere.
 */
Typeface::Ptr Font::Native::getDefaultPlatformTypefaceForFont (const Font &) { return nullptr; }

} // namespace juce
