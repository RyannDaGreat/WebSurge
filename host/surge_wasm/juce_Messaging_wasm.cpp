/*
 * juce_Messaging_wasm.cpp -- JUCE's message queue for WebAssembly.
 *
 * JUCE posts asynchronous work (repaints, timer callbacks, async updaters) to a
 * platform message queue that a native run loop drains. A browser tab has no
 * such loop to hand to JUCE -- the page's own event loop owns the thread, and
 * blocking it is fatal.
 *
 * So the queue here is a plain FIFO, and surgewasm::pumpMessages() drains it
 * once per animation frame from the page. That inverts the usual relationship
 * (we pump JUCE rather than JUCE pumping us) but is otherwise faithful:
 * messages still run on the message thread, in order, exactly once.
 *
 * Included from juce_events.cpp's JUCE_WASM branch.
 */

#include <deque>

namespace juce
{

namespace
{
/*
 * Owned by the message thread only. Emscripten is single threaded here (no
 * -pthread), so no lock is needed; adding one would imply a concurrency that
 * does not exist and hide that assumption.
 */
std::deque<MessageManager::MessageBase::Ptr> &messageQueue()
{
    static std::deque<MessageManager::MessageBase::Ptr> q;
    return q;
}

/*
 * A runaway message storm would otherwise hang the tab forever inside one
 * pump. Draining at most this many per frame keeps the page responsive and
 * lets the remainder run on the next frame.
 */
constexpr int maxMessagesPerPump = 4096;
} // namespace

void MessageManager::doPlatformSpecificInitialisation() {}

void MessageManager::doPlatformSpecificShutdown() { messageQueue().clear(); }

bool MessageManager::postMessageToSystemQueue (MessageManager::MessageBase *const message)
{
    messageQueue().push_back (message);
    return true;
}

void MessageManager::broadcastMessage (const String &)
{
    // Inter-process broadcast has no meaning for a single tab; there is no
    // second process to hear it.
}

/*
 * Command. Runs one queued message.
 *
 * Returns true if a message was run, so callers can loop until the queue is
 * empty. Named to match what JUCE's own platform backends expose.
 */
bool dispatchNextWasmMessage()
{
    auto &q = messageQueue();
    if (q.empty())
        return false;

    auto msg = q.front();
    q.pop_front();

    if (msg != nullptr)
        msg->messageCallback();

    return true;
}

/*
 * Command. Drains the queue, bounded.
 *
 * Messages posted *while* draining are picked up in the same pass, which is
 * what makes a repaint triggered by a timer land in the same frame.
 */
void pumpWasmMessageQueue()
{
    for (int i = 0; i < maxMessagesPerPump; ++i)
        if (! dispatchNextWasmMessage())
            return;
}

} // namespace juce
