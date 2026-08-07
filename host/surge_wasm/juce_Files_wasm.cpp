/*
 * juce_Files_wasm.cpp -- JUCE's filesystem backend for WebAssembly.
 *
 * Emscripten gives us a POSIX API over MEMFS, so most of juce_File is already
 * satisfied by juce_SharedCode_posix.h. But upstream wraps one block of that
 * file in `#if ! JUCE_WASM` -- memory mapping, volume geometry, and
 * juce_getExecutableFile (which needs dladdr and an executable on disk, neither
 * of which exists in a browser). juce_Files_linux.cpp then depends on exactly
 * those, so it cannot be reused. This file supplies wasm-appropriate versions.
 *
 * The guiding rule: report honestly rather than invent. There is no volume, so
 * volume queries return 0; there is no shell, so openDocument fails. What Surge
 * genuinely needs -- reading its patches and wavetables out of MEMFS -- works,
 * because that part is plain POSIX and already handled.
 *
 * Included from juce_core.cpp's JUCE_WASM branch.
 */

#include <emscripten/emscripten.h>

#include <sched.h>

/*
 * POSIX scheduler and affinity calls that the Emscripten sysroot declares but
 * does not implement. JUCE's shared POSIX code calls them while working out
 * thread priorities.
 *
 * A browser gives a page no control over thread scheduling or CPU affinity --
 * there is genuinely nothing to set. Returning a degenerate range (0..0) makes
 * JUCE's priority arithmetic collapse to "one priority", which is the truth,
 * rather than leaving the symbols undefined at link time.
 */
extern "C"
{
    int sched_get_priority_min (int) { return 0; }
    int sched_get_priority_max (int) { return 0; }

    int pthread_setaffinity_np (pthread_t, size_t, const cpu_set_t *) { return 0; }
    int pthread_getaffinity_np (pthread_t, size_t, cpu_set_t *) { return 0; }
}

namespace juce
{

// updateStatInfoForFile is NOT redefined here. It lives in an anonymous
// namespace in juce_SharedCode_posix.h; upstream had it inside a
// `#if ! JUCE_WASM` block whose only genuinely incompatible member is
// juce_doStatFS (statfs). patches/juce-emscripten.patch narrows that guard
// instead, so the original implementation is used rather than a copy of it.

//==============================================================================
// Memory mapping. Emscripten's mmap over MEMFS cannot share pages with a file
// the way a real OS does, so JUCE's contract (a window onto the file's bytes)
// is honoured by simply reading the range into an owned buffer.
//==============================================================================

void MemoryMappedFile::openInternal (const File &file, AccessMode mode, bool /*exclusive*/)
{
    jassert (mode == readOnly || mode == readWrite);

    if (range.getStart() < 0)
    {
        jassertfalse;
        range = Range<int64>();
        return;
    }

    FileInputStream in (file);
    if (in.failedToOpen())
        return;

    if (range.getLength() <= 0)
        range = Range<int64> (0, file.getSize());

    const auto length = (size_t) range.getLength();
    if (length == 0)
        return;

    address = std::malloc (length);
    if (address == nullptr)
    {
        range = Range<int64>();
        return;
    }

    in.setPosition (range.getStart());
    const auto got = in.read (address, (int) length);
    if (got < (int) length)
        std::memset (static_cast<char *> (address) + got, 0, length - (size_t) got);
}

MemoryMappedFile::~MemoryMappedFile()
{
    // Writes are not flushed back: nothing in Surge maps a file for writing,
    // and silently discarding changes would be worse than not supporting it.
    jassert (address == nullptr || fileHandle == 0);
    std::free (address);
}

//==============================================================================
/*
 * There is no executable file in a browser. Callers use this only to derive a
 * directory to search, and Surge is given its data path explicitly, so a
 * synthetic path at the root keeps getParentDirectory() well defined.
 */
File juce_getExecutableFile();
File juce_getExecutableFile() { return File ("/surge-xt.wasm"); }

//==============================================================================
// No volumes to report on. Zero is the honest answer, and JUCE treats it as
// "unknown" rather than "full".
//==============================================================================

int64 File::getBytesFreeOnVolume() const { return 0; }
int64 File::getVolumeTotalSize() const { return 0; }
String File::getVolumeLabel() const { return {}; }
int File::getVolumeSerialNumber() const { return 0; }

//==============================================================================
// isSymbolicLink, getNativeLinkedTarget, copyInternal, moveInternal,
// replaceInternal, isHidden, findFileSystemRoots and DirectoryIterator's
// NativeIterator are NOT defined here. juce_CommonFile_linux.cpp and
// juce_SharedCode_posix.h already provide them, and both are plain POSIX that
// works over MEMFS -- they only needed <dirent.h> and <fnmatch.h>, which
// juce_BasicNativeHeaders.h pulls in for Linux but not for wasm.

//==============================================================================
/*
 * Standard locations inside MEMFS. Emscripten creates /tmp and /home/web_user
 * at startup; the rest are given sensible paths under those so that anything
 * JUCE writes lands somewhere valid rather than failing.
 */
File File::getSpecialLocation (const SpecialLocationType type)
{
    switch (type)
    {
    case userHomeDirectory:
    case userDocumentsDirectory:
    case userMusicDirectory:
    case userMoviesDirectory:
    case userPicturesDirectory:
    case userDesktopDirectory:
    case userApplicationDataDirectory:
    case commonApplicationDataDirectory:
    case commonDocumentsDirectory:
        return File ("/home/web_user");

    case tempDirectory:
        return File ("/tmp");

    case globalApplicationsDirectory:
        return File ("/");

    case invokedExecutableFile:
    case currentExecutableFile:
    case currentApplicationFile:
    case hostApplicationPath:
        return juce_getExecutableFile();

    default:
        jassertfalse;
        break;
    }

    return {};
}

//==============================================================================
/*
 * A page cannot launch an external application. Returning false is the truthful
 * answer and lets callers surface "could not open" rather than appearing to
 * succeed and doing nothing.
 *
 * Surge reaches this when the user clicks a documentation link; the URL is
 * handed to the page so the browser can open a tab, which is the closest real
 * equivalent.
 */
bool Process::openDocument (const String &fileName, const String & /*parameters*/)
{
    if (fileName.startsWith ("http:") || fileName.startsWith ("https:"))
    {
        EM_ASM ({ globalThis.open (UTF8ToString ($0), '_blank'); }, fileName.toRawUTF8());
        return true;
    }
    return false;
}

// Process::setPriority is NOT defined here: juce_Threads_linux.cpp, which we
// also compile for wasm, already provides it.

//==============================================================================
// findFileSystemRoots and isHidden are NOT defined here: juce_CommonFile_linux.cpp,
// which we also compile for wasm, already provides both.

bool File::isOnCDRomDrive() const { return false; }
bool File::isOnHardDisk() const { return true; }
bool File::isOnRemovableDrive() const { return false; }

/*
 * "Show in file manager". There is no file manager, and MEMFS is not visible to
 * the user's operating system anyway, so this cannot do anything meaningful.
 * Surge offers it from menus next to its data folders.
 */
void File::revealToUser() const {}

} // namespace juce
