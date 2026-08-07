/*
 * juce_Network_wasm.cpp -- JUCE's socket layer for WebAssembly.
 *
 * A web page cannot open raw TCP or UDP sockets. That is a hard sandbox
 * boundary, not a gap we can shim: there is no browser API that would let this
 * work, and pretending otherwise would be worse than failing.
 *
 * Surge only needs sockets for OSC -- remote control from another application
 * on the network -- which is meaningless for a synth running inside a tab. But
 * juce_osc and SurgeSynthProcessor still reference the classes, so they must
 * link.
 *
 * Every operation therefore fails cleanly: bind returns false, read/write
 * return -1, and nothing ever reports itself as connected. Surge's OSC layer
 * already handles a socket that will not bind (it reports "could not start
 * listening"), so the user gets a truthful message instead of silence.
 *
 * Included from juce_core.cpp's JUCE_WASM branch.
 */

namespace juce
{

//==============================================================================
// The SocketOptions constructors are defined inline in juce_Socket.h, so only
// the out-of-line members belong here.

StreamingSocket::StreamingSocket (const String &host, int port, int h,
                                  const SocketOptions &optionsIn)
    : options (optionsIn), hostName (host), portNumber (port), handle (h)
{
}

StreamingSocket::~StreamingSocket() = default;

bool StreamingSocket::bindToPort (int) { return false; }
bool StreamingSocket::bindToPort (int, const String &) { return false; }
int StreamingSocket::getBoundPort() const noexcept { return -1; }
bool StreamingSocket::connect (const String &, int, int) { return false; }
void StreamingSocket::close() {}
bool StreamingSocket::isLocal() const noexcept { return false; }

// -1 is JUCE's "error", distinct from 0 ("timed out") -- callers must not spin
// waiting for a socket that can never become ready.
int StreamingSocket::waitUntilReady (bool, int) { return -1; }
int StreamingSocket::read (void *, int, bool) { return -1; }
int StreamingSocket::write (const void *, int) { return -1; }

bool StreamingSocket::createListener (int, const String &) { return false; }
StreamingSocket *StreamingSocket::waitForNextConnection() const { return nullptr; }

//==============================================================================
DatagramSocket::DatagramSocket (bool, const SocketOptions &optionsIn) : options (optionsIn) {}
// (the bool-only constructor delegates to this one inline in the header)

DatagramSocket::~DatagramSocket() = default;

void DatagramSocket::shutdown() {}

bool DatagramSocket::bindToPort (int) { return false; }
bool DatagramSocket::bindToPort (int, const String &) { return false; }
int DatagramSocket::getBoundPort() const noexcept { return -1; }

int DatagramSocket::waitUntilReady (bool, int) { return -1; }
int DatagramSocket::read (void *, int, bool) { return -1; }
int DatagramSocket::read (void *, int, bool, String &, int &) { return -1; }
int DatagramSocket::write (const String &, int, const void *, int) { return -1; }

bool DatagramSocket::joinMulticast (const String &) { return false; }
bool DatagramSocket::leaveMulticast (const String &) { return false; }
bool DatagramSocket::setMulticastLoopbackEnabled (bool) { return false; }
bool DatagramSocket::setEnablePortReuse (bool) { return false; }

//==============================================================================
// IPAddress::findAllAddresses and MACAddress::getAllAddresses are NOT defined
// here: juce_IPAddress_posix.h and juce_MACAddress.cpp already provide them,
// and juce_core.cpp includes the posix one for every non-Windows target.

bool JUCE_CALLTYPE Process::openEmailWithAttachments (const String &, const String &,
                                                      const String &, const StringArray &)
{
    return false;
}

} // namespace juce
