/*
 * WasmPeerAccess.h -- the seam between the WASM ComponentPeer and our host.
 *
 * WasmComponentPeer is defined inside juce_Windowing_wasm.cpp, which is
 * #included into juce_gui_basics.cpp and therefore compiled as part of JUCE's
 * translation unit. Nothing outside that TU can see the class. Rather than leak
 * the definition into a header (which would drag JUCE internals along with it),
 * this declares a handful of free functions that the peer implements and
 * surge_gui_host.cpp calls.
 *
 * Keeping the surface this small also means the host never has to know how
 * painting works -- only "is there a new frame, and where are the pixels".
 */

#pragma once

#include <juce_graphics/juce_graphics.h>

namespace surgewasm
{

/*
 * Command. Runs JUCE's pending messages and timers once.
 *
 * Surge's meters, LFO displays and value readouts are driven by juce::Timer.
 * Without pumping, the GUI paints once and then appears frozen.
 */
void pumpMessages();

/*
 * Command. Repaints the front-most peer if anything is dirty.
 * Returns true if pixels changed.
 */
bool renderIfDirty();

/* Query. The front-most peer's backing image, or nullptr if there is none. */
const juce::Image *frontImage();

/* Command. Marks the whole front-most peer dirty. */
void invalidateAll();

/* Command. Routes a mouse event to the front-most peer. kind: 0 move, 1 down, 2 up. */
void mouseEvent (int kind, float x, float y, int buttons, bool shift, bool ctrl, bool alt);

/* Command. Routes a scroll-wheel event. Deltas are browser pixels. */
void wheelEvent (float x, float y, float deltaX, float deltaY, bool shift, bool ctrl, bool alt);

/* Command. Routes a key event. Returns true if JUCE consumed it. */
bool keyEvent (bool isDown, int keyCode, int textChar, bool shift, bool ctrl, bool alt);

/* Command. Tells the front-most peer the page gained or lost focus. */
void setFocus (bool gained);

} // namespace surgewasm

namespace juce
{
/*
 * Defined in host/surge_wasm/juce_Messaging_wasm.cpp, which is compiled into
 * juce_events. Declared here because juce_Windowing_wasm.cpp (compiled into
 * juce_gui_basics, a different translation unit) drives the pump.
 */
void pumpWasmMessageQueue();
} // namespace juce
