/*
 * juce_Windowing_wasm.cpp -- JUCE's native windowing layer for WebAssembly.
 *
 * WHAT THIS IS FOR
 * ----------------
 * Surge's interface is a tree of juce::Components rooted at SurgeGUIEditor.
 * JUCE draws that tree entirely in software (LowLevelGraphicsSoftwareRenderer),
 * so nothing about it needs OpenGL, X11 or a real window -- it only needs
 * somewhere to put pixels and a source of input events. That "somewhere" is a
 * ComponentPeer, and JUCE picks one per platform via a #elif chain in
 * juce_gui_basics.cpp which has no WASM branch. This file is that branch.
 *
 * The peer owns an ARGB image. Surge paints into it exactly as it would paint
 * into a window on the desktop; JavaScript reads those bytes straight into a
 * <canvas> ImageData and pushes mouse/key events back in. The result is Surge's
 * own pixels -- real fonts, real menus, real LFO display, real hover states --
 * not a reimplementation.
 *
 * This file is deliberately kept in the dump rather than inside the vendored
 * JUCE tree, so it is reviewable and versioned here; patches/juce-emscripten.patch
 * only adds the three-line include hook.
 *
 * MANY PEERS, ONE SURFACE
 * -----------------------
 * A browser tab is one surface, but JUCE still creates a separate top-level
 * Component -- and therefore a separate peer -- for every popup menu, tooltip
 * and dialog. Each paints into its own image at its own screen bounds, and
 * compositeInto() flattens the whole stack back-to-front into the single canvas
 * buffer.
 *
 * An earlier version handed JS only the front-most peer's image. Opening any
 * dropdown then replaced the entire editor with the menu, and because the menu's
 * image is much smaller than the canvas, JS read past the end of it and smeared
 * heap garbage across the top of the panel. Compositing the stack is not an
 * optimisation here; it is the only correct behaviour.
 */

#include <emscripten/emscripten.h>

#include <cstring>
#include <set>

namespace juce
{

/*
 * Supersampling factor: physical pixels per logical pixel. 1.0 is Surge's
 * native 913x569. Drives both user zoom and HiDPI.
 */
float gRenderScale = 1.0f;

//==============================================================================
class WasmComponentPeer final : public ComponentPeer
{
  public:
    WasmComponentPeer (Component &comp, int flags)
        : ComponentPeer (comp, flags)
    {
        peers().add (this);
        // A peer with no size never allocates a buffer and would silently draw
        // nothing; take the component's size, which JUCE has already set.
        setBounds (comp.getBounds(), false);
    }

    ~WasmComponentPeer() override
    {
        peers().removeFirstMatchingValue (this);

        // A closing popup leaves a hole in the composite. Nothing else knows to
        // repaint that region, so mark every surviving peer fully dirty; without
        // this the menu's pixels stay on screen after it closes.
        for (auto *p : peers())
            if (p != nullptr)
                p->repaint (p->getBounds().withZeroOrigin());
    }

    /* Query. All live peers, front-most last. */
    static Array<WasmComponentPeer *> &peers()
    {
        static Array<WasmComponentPeer *> p;
        return p;
    }

    //== geometry ==============================================================

    void *getNativeHandle() const override { return const_cast<WasmComponentPeer *> (this); }

    void setBounds (const Rectangle<int> &newBounds, bool /*isNowFullScreen*/) override
    {
        if (bounds == newBounds && image.isValid())
            return;

        bounds = newBounds;
        rebuildImageForScale();
        handleMovedOrResized();
    }

    Rectangle<int> getBounds() const override { return bounds; }

    Point<float> localToGlobal (Point<float> p) override
    {
        return p + bounds.getPosition().toFloat();
    }
    Point<float> globalToLocal (Point<float> p) override
    {
        return p - bounds.getPosition().toFloat();
    }
    using ComponentPeer::localToGlobal;
    using ComponentPeer::globalToLocal;

    // A browser surface has no decorations and no separate screen coordinates.
    OptionalBorderSize getFrameSizeIfPresent() const override
    {
        return OptionalBorderSize { BorderSize<int>() };
    }
    BorderSize<int> getFrameSize() const override { return {}; }

    bool contains (Point<int> localPos, bool) const override
    {
        return bounds.withZeroOrigin().contains (localPos);
    }

    //== window state (all no-ops in a tab) ====================================

    void setVisible (bool shouldBeVisible) override { visible = shouldBeVisible; }
    void setTitle (const String &) override {}
    void setMinimised (bool) override {}
    bool isMinimised() const override { return false; }
    bool isShowing() const override { return visible; }
    void setFullScreen (bool) override {}
    bool isFullScreen() const override { return false; }
    void setIcon (const Image &) override {}
    bool setAlwaysOnTop (bool) override { return true; }
    void setAlpha (float) override {}

    void toFront (bool takeKeyboardFocus) override
    {
        peers().removeFirstMatchingValue (this);
        peers().add (this);
        if (takeKeyboardFocus)
            grabFocus();
        // Bringing a peer forward changes what JS composites, so the whole
        // surface must be redrawn, not just this peer's old dirty region.
        dirty = bounds.withZeroOrigin();
    }

    void toBehind (ComponentPeer *other) override
    {
        if (auto *o = dynamic_cast<WasmComponentPeer *> (other))
        {
            peers().removeFirstMatchingValue (this);
            peers().insert (peers().indexOf (o), this);
        }
    }

    bool isFocused() const override { return focused; }

    void grabFocus() override
    {
        if (! focused)
        {
            focused = true;
            handleFocusGain();
        }
    }

    void loseFocus()
    {
        if (focused)
        {
            focused = false;
            handleFocusLoss();
        }
    }

    // Text input is handled by the page, not by JUCE; Surge's text fields are
    // drawn components, so there is no native IME to summon.
    void textInputRequired (Point<int>, TextInputTarget &) override {}

    StringArray getAvailableRenderingEngines() override
    {
        return StringArray ("Software Renderer");
    }

    //== painting ==============================================================

    void repaint (const Rectangle<int> &area) override
    {
        dirty = dirty.isEmpty() ? area : dirty.getUnion (area);
    }

    /*
     * Command. Renders any pending repaint into the backing image.
     *
     * Returns true if pixels changed, so JS can skip uploading an unchanged
     * frame to the canvas.
     */
    bool renderIfDirty()
    {
        if (dirty.isEmpty() || ! image.isValid())
            return false;

        const auto area = dirty.getIntersection (bounds.withZeroOrigin());
        dirty = {};

        if (area.isEmpty())
            return false;

        // `area` is logical; the image is physical. Expand outwards so a
        // fractional scale never leaves a seam of stale pixels at the edge.
        const auto phys = (area.toFloat() * gRenderScale).getSmallestIntegerContainer()
                              .getIntersection ({ 0, 0, image.getWidth(), image.getHeight() });
        if (phys.isEmpty())
            return false;

        // Clear first: without it, translucent Surge widgets composite over the
        // previous frame and smear. Image::clear does this directly rather than
        // going through a Graphics fill, which would blend instead of replace.
        image.clear (phys, Colours::transparentBlack);

        LowLevelGraphicsSoftwareRenderer renderer (image);
        renderer.clipToRectangle (phys);
        // Clip in physical, then scale so Surge keeps painting in logical
        // coordinates -- this is what re-rasterizes the SVGs at full density
        // instead of magnifying pixels.
        renderer.addTransform (AffineTransform::scale (gRenderScale));
        handlePaint (renderer);
        return true;
    }

    void performAnyPendingRepaintsNow() override { renderIfDirty(); }

    Image &getImage() { return image; }
    bool hasPendingPaint() const { return ! dirty.isEmpty(); }

    /*
     * Command. (Re)allocates the backing image at the current supersampling
     * factor. Bounds stay logical; only the pixel buffer grows.
     */
    void rebuildImageForScale()
    {
        if (bounds.getWidth() <= 0 || bounds.getHeight() <= 0)
            return;

        const int pw = jmax (1, roundToInt (bounds.getWidth() * gRenderScale));
        const int ph = jmax (1, roundToInt (bounds.getHeight() * gRenderScale));

        if (image.isValid() && image.getWidth() == pw && image.getHeight() == ph)
            return;

        image = Image (Image::ARGB, pw, ph, true);
        dirty = bounds.withZeroOrigin();
    }

  private:
    Rectangle<int> bounds;
    Rectangle<int> dirty;
    Image image;
    bool visible = true;
    bool focused = false;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (WasmComponentPeer)
};

//==============================================================================
ComponentPeer *Component::createNewPeer (int styleFlags, void *)
{
    return new WasmComponentPeer (*this, styleFlags);
}

//==============================================================================
JUCE_API bool JUCE_CALLTYPE Process::isForegroundProcess() { return true; }
JUCE_API void JUCE_CALLTYPE Process::makeForegroundProcess() {}
JUCE_API void JUCE_CALLTYPE Process::hide() {}

//==============================================================================
void Desktop::setKioskComponent (Component *, bool, bool) {}

/*
 * The canvas IS the display, and its size must be reported honestly.
 *
 * JUCE positions popup menus to fit within the display, flipping or shifting
 * them when they would overflow. Claiming a display larger than the canvas
 * makes it place menus in a region that does not exist, and compositeInto then
 * clips them -- menus near the right or bottom edge came out cut off.
 *
 * The fallback below is only used before setDisplaySize() runs; it is
 * deliberately small so that a missing call shows up as visibly wrong menu
 * placement rather than silently working on a big screen and failing elsewhere.
 */
static Rectangle<int> wasmDisplayArea { 0, 0, 913, 569 };

void Displays::findDisplays (const Desktop &)
{
    Displays::Display d;
    d.totalArea = wasmDisplayArea;
    d.userArea = wasmDisplayArea;
    d.isMain = true;
    d.scale = 1.0;
    d.dpi = 96.0;

    displays.clear();
    displays.add (d);
    updateToLogical();
}

bool Desktop::canUseSemiTransparentWindows() noexcept { return true; }

class Desktop::NativeDarkModeChangeDetectorImpl
{
  public:
    NativeDarkModeChangeDetectorImpl() = default;
};

std::unique_ptr<Desktop::NativeDarkModeChangeDetectorImpl>
Desktop::createNativeDarkModeChangeDetectorImpl()
{
    return std::make_unique<NativeDarkModeChangeDetectorImpl>();
}

// Surge ships its own skin colours, so the OS dark-mode hint is irrelevant here.
bool Desktop::isDarkModeActive() const { return true; }

void Desktop::setScreenSaverEnabled (bool) {}
bool Desktop::isScreenSaverEnabled() { return true; }

double Desktop::getDefaultMasterScale() { return 1.0; }
Desktop::DisplayOrientation Desktop::getCurrentOrientation() const { return upright; }
void Desktop::allowedOrientationsChanged() {}

//==============================================================================
bool detail::MouseInputSourceList::addSource()
{
    if (sources.isEmpty())
    {
        addSource (0, MouseInputSource::InputSourceType::mouse);
        return true;
    }
    return false;
}

bool detail::MouseInputSourceList::canUseTouch() const { return false; }

/* Last position JS reported; there is no OS cursor to query. */
Point<float> wasmMousePosition { 0.0f, 0.0f };

Point<float> MouseInputSource::getCurrentRawMousePosition() { return wasmMousePosition; }

// A page cannot warp the pointer. Recording the request keeps JUCE's internal
// bookkeeping consistent even though the visible cursor does not move.
void MouseInputSource::setRawMousePosition (Point<float> p) { wasmMousePosition = p; }

//==============================================================================
/*
 * Cursors are set on the canvas element from JS via a CSS cursor name, so the
 * handle only has to remember which standard cursor was requested.
 */
class MouseCursor::PlatformSpecificHandle
{
  public:
    explicit PlatformSpecificHandle (const MouseCursor::StandardCursorType type)
        : cursorType (type)
    {
    }

    explicit PlatformSpecificHandle (const detail::CustomMouseCursorInfo &)
        : cursorType (MouseCursor::NormalCursor)
    {
    }

    static void showInWindow (PlatformSpecificHandle *handle, ComponentPeer *)
    {
        currentCursor = handle != nullptr ? handle->cursorType : MouseCursor::NormalCursor;
    }

    static MouseCursor::StandardCursorType current() { return currentCursor; }

  private:
    MouseCursor::StandardCursorType cursorType;
    static MouseCursor::StandardCursorType currentCursor;
};

MouseCursor::StandardCursorType MouseCursor::PlatformSpecificHandle::currentCursor =
    MouseCursor::NormalCursor;

//==============================================================================
bool WindowUtils::areThereAnyAlwaysOnTopWindows() { return false; }

//==============================================================================
/*
 * Keys currently held.
 *
 * JUCE asks the OS on other platforms; a browser only tells us about
 * transitions, so the peer keeps the set itself. Surge queries this for
 * modifier-style behaviour (ctrl-drag for fine adjustment, and so on), and
 * getting it wrong means those gestures silently stop working.
 */
std::set<int> &heldKeys()
{
    static std::set<int> keys;
    return keys;
}

bool KeyPress::isKeyCurrentlyDown (int keyCode)
{
    return heldKeys().count (keyCode) > 0;
}

//==============================================================================
/*
 * There are no OS file icons to fetch in a browser. Returning a null Image is
 * what JUCE's file browser expects when a platform cannot supply one; it falls
 * back to its own generic file/folder glyphs.
 */
Image detail::WindowingHelpers::createIconForFile (const File &) { return {}; }

/*
 * Message boxes go through JUCE's own AlertWindow rather than anything native.
 * That is not a compromise here -- AlertWindow is a juce::Component, so it
 * renders through this very peer and looks exactly as it does on the desktop,
 * and unlike a native dialog it cannot block the browser's event loop.
 */
std::unique_ptr<detail::ScopedMessageBoxInterface>
detail::ScopedMessageBoxInterface::create (const MessageBoxOptions &options)
{
    return detail::AlertWindowHelpers::create (options);
}

/*
 * The system "beep". A page has no access to one, and synthesising a tone here
 * would be actively wrong in a synthesizer -- it would come out of the same
 * speakers as the instrument.
 */
void LookAndFeel::playAlertSound() {}

//==============================================================================
/*
 * Clipboard.
 *
 * The browser's async Clipboard API cannot satisfy JUCE's synchronous
 * getTextFromClipboard(), and reading the real clipboard requires a permission
 * prompt. So we keep an internal clipboard that works perfectly for copy/paste
 * *within* Surge -- which is what it is actually used for here (copying
 * modulation routings, patch comments, tuning data) -- and additionally push
 * copies out to the system clipboard on a best-effort basis so that pasting
 * into another application works.
 */
static String &internalClipboard()
{
    static String text;
    return text;
}

void SystemClipboard::copyTextToClipboard (const String &text)
{
    internalClipboard() = text;

    // Best effort: fails silently if the page lacks permission, which is why
    // the internal copy above is the one Surge actually reads back.
    EM_ASM ({
        const s = UTF8ToString ($0);
        if (globalThis.navigator && navigator.clipboard)
            navigator.clipboard.writeText (s).catch (() => {});
    }, text.toRawUTF8());
}

String SystemClipboard::getTextFromClipboard() { return internalClipboard(); }

//==============================================================================
/*
 * A page cannot start a drag into another application. Returning false tells
 * JUCE the drag did not begin, which is accurate -- reporting success would
 * leave the caller waiting for a drop that can never arrive.
 */
bool DragAndDropContainer::performExternalDragDropOfFiles (const StringArray &,
                                                           bool,
                                                           Component *,
                                                           std::function<void()> callback)
{
    NullCheckedInvocation::invoke (callback);
    return false;
}

bool DragAndDropContainer::performExternalDragDropOfText (const String &,
                                                          Component *,
                                                          std::function<void()> callback)
{
    NullCheckedInvocation::invoke (callback);
    return false;
}

} // namespace juce

//==============================================================================
// Bridge to surge_gui_host.cpp. See host/surge_wasm/WasmPeerAccess.h for why
// this indirection exists: WasmComponentPeer is only visible inside JUCE's
// translation unit, so the host talks to it through these free functions.
//==============================================================================

#include <surge_wasm/WasmPeerAccess.h>

namespace surgewasm
{

static juce::WasmComponentPeer *front()
{
    auto &p = juce::WasmComponentPeer::peers();
    return p.isEmpty() ? nullptr : p.getLast();
}

void pumpMessages()
{
    // JUCE_MODAL_LOOPS_PERMITTED is off, so runDispatchLoopUntil is unavailable,
    // and it would be wrong anyway -- a browser must never block. Instead drain
    // the FIFO defined in juce_Messaging_wasm.cpp.
    juce::pumpWasmMessageQueue();

    /*
     * Tick JUCE's timers.
     *
     * This is separate from the message queue and easy to miss: JUCE normally
     * runs timers off a dedicated thread that posts into a native run loop, and
     * we have neither. Surge drives its ENTIRE editor from one
     * (SurgeSynthEditor.cpp:285 starts a 60 Hz timer calling sge->idle()), so
     * without this the interface renders once and then never updates anything
     * idle-driven -- the patch name after a jog, VU meters, value readouts.
     *
     * The symptom is subtle rather than obvious: the GUI looks fine and responds
     * to clicks, it just quietly fails to refresh things it did not draw itself.
     */
    juce::Timer::callPendingTimersSynchronously();
}

bool renderIfDirty()
{
    auto *p = front();
    return p != nullptr && p->renderIfDirty();
}

const juce::Image *frontImage()
{
    auto *p = front();
    if (p == nullptr || ! p->getImage().isValid())
        return nullptr;
    return &p->getImage();
}

bool compositeInto (uint8_t *rgba, int canvasW, int canvasH)
{
    if (rgba == nullptr || canvasW <= 0 || canvasH <= 0)
        return false;

    // Opaque black underneath: the editor covers the whole canvas, but starting
    // from a known state means a peer that closes cannot leave its pixels behind.
    std::memset (rgba, 0, (size_t) canvasW * canvasH * 4);

    for (auto *p : juce::WasmComponentPeer::peers()) // back to front
    {
        if (p == nullptr || ! p->getImage().isValid())
            continue;

        auto &img = p->getImage();

        // Peer bounds are logical; the canvas and the peer's image are physical.
        // Scale the origin to match, or peers land in the wrong place the moment
        // the scale is not 1.
        const int ox = juce::roundToInt (p->getBounds().getX() * juce::gRenderScale);
        const int oy = juce::roundToInt (p->getBounds().getY() * juce::gRenderScale);

        juce::Image::BitmapData src (img, juce::Image::BitmapData::readOnly);

        const int x0 = juce::jmax (0, ox);
        const int y0 = juce::jmax (0, oy);
        const int x1 = juce::jmin (canvasW, ox + img.getWidth());
        const int y1 = juce::jmin (canvasH, oy + img.getHeight());

        for (int y = y0; y < y1; ++y)
        {
            const auto *s = src.getLinePointer (y - oy);
            auto *d = rgba + ((size_t) y * canvasW + x0) * 4;

            for (int x = x0; x < x1; ++x, d += 4)
            {
                const auto *px = s + (x - ox) * 4;
                // juce::Image::ARGB is BGRA in memory on little-endian, and is
                // premultiplied -- so src-over is a plain add after scaling the
                // destination, with no divide.
                const uint32_t a = px[3];
                if (a == 0)
                    continue;

                if (a == 255)
                {
                    d[0] = px[2];
                    d[1] = px[1];
                    d[2] = px[0];
                    d[3] = 255;
                }
                else
                {
                    const uint32_t ia = 255 - a;
                    d[0] = (uint8_t) (px[2] + ((d[0] * ia) / 255));
                    d[1] = (uint8_t) (px[1] + ((d[1] * ia) / 255));
                    d[2] = (uint8_t) (px[0] + ((d[2] * ia) / 255));
                    d[3] = (uint8_t) (a + ((d[3] * ia) / 255));
                }
            }
        }
    }
    return true;
}

bool renderAllDirty()
{
    bool any = false;
    // Copy the list first: painting can create or destroy peers (a menu closing
    // during its own repaint), and mutating while iterating would be undefined.
    auto snapshot = juce::WasmComponentPeer::peers();
    for (auto *p : snapshot)
        if (juce::WasmComponentPeer::peers().contains (p) && p->renderIfDirty())
            any = true;
    return any;
}

int peerCount() { return juce::WasmComponentPeer::peers().size(); }

void invalidateAll()
{
    if (auto *p = front())
        p->repaint (p->getBounds().withZeroOrigin());
}

static juce::ModifierKeys makeMods (int buttons, bool shift, bool ctrl, bool alt)
{
    int f = 0;
    if (buttons & 1) f |= juce::ModifierKeys::leftButtonModifier;
    if (buttons & 2) f |= juce::ModifierKeys::rightButtonModifier;
    if (buttons & 4) f |= juce::ModifierKeys::middleButtonModifier;
    if (shift) f |= juce::ModifierKeys::shiftModifier;
    if (ctrl) f |= juce::ModifierKeys::ctrlModifier;
    if (alt) f |= juce::ModifierKeys::altModifier;
    return juce::ModifierKeys (f);
}

/*
 * Query. The peer that should receive a click at this canvas position.
 *
 * Front-most first, so an open menu wins over the editor beneath it. Falling
 * back to the front peer when the point is outside everything is deliberate:
 * clicking away from an open popup must still reach a peer, or JUCE's modal
 * manager never gets the event that dismisses the menu.
 */
static juce::WasmComponentPeer *peerAt (float x, float y)
{
    auto &peers = juce::WasmComponentPeer::peers();
    const juce::Point<int> pt ((int) x, (int) y);

    for (int i = peers.size(); --i >= 0;)
        if (auto *p = peers[i])
            if (p->getBounds().contains (pt))
                return p;

    return front();
}

void mouseEvent (int, float x, float y, int buttons, bool shift, bool ctrl, bool alt)
{
    auto *p = peerAt (x, y);
    if (p == nullptr)
        return;

    const auto mods = makeMods (buttons, shift, ctrl, alt);

    // JUCE derives press/release from the modifier state rather than an event
    // kind, so the current button mask is the whole story. Keeping the global
    // ModifierKeys in step matters: widgets read it during drags.
    juce::ModifierKeys::currentModifiers = mods;

    // Screen position, for MouseInputSource::getCurrentRawMousePosition. The
    // canvas IS the screen here, so canvas coordinates are screen coordinates.
    juce::wasmMousePosition = juce::Point<float> (x, y);

    // handleMouseEvent wants the position WITHIN THE PEER, not on the screen.
    // For the editor those are the same because its bounds start at (0,0), but
    // a popup menu sits at an offset -- so passing canvas coordinates made every
    // menu read the mouse as being off by exactly its own position, highlighting
    // and selecting the wrong item.
    const auto origin = p->getBounds().getPosition().toFloat();

    p->handleMouseEvent (juce::MouseInputSource::InputSourceType::mouse,
                         juce::Point<float> (x, y) - origin,
                         mods,
                         juce::MouseInputSource::defaultPressure,
                         juce::MouseInputSource::defaultOrientation,
                         juce::Time::currentTimeMillis());
}

void wheelEvent (float x, float y, float dx, float dy, bool shift, bool ctrl, bool alt)
{
    auto *p = front();
    if (p == nullptr)
        return;

    juce::MouseWheelDetails w;
    // Browsers report scroll as pixels, positive downward; JUCE wants a small
    // signed fraction, positive upward.
    constexpr float pixelsPerUnit = 120.0f;
    w.deltaX = -dx / pixelsPerUnit;
    w.deltaY = -dy / pixelsPerUnit;
    w.isReversed = false;
    w.isSmooth = true;
    w.isInertial = false;

    juce::ModifierKeys::currentModifiers = makeMods (0, shift, ctrl, alt);

    p->handleMouseWheel (juce::MouseInputSource::InputSourceType::mouse,
                         juce::Point<float> (x, y),
                         juce::Time::currentTimeMillis(),
                         w);
}

bool keyEvent (bool isDown, int keyCode, int textChar, bool shift, bool ctrl, bool alt)
{
    auto *p = front();
    if (p == nullptr)
        return false;

    const auto mods = makeMods (0, shift, ctrl, alt);
    juce::ModifierKeys::currentModifiers = mods;

    // Keep the held-key set in step; KeyPress::isKeyCurrentlyDown reads it.
    if (isDown)
        juce::heldKeys().insert (keyCode);
    else
        juce::heldKeys().erase (keyCode);

    p->handleKeyUpOrDown (isDown);

    if (! isDown)
        return false;

    return p->handleKeyPress (juce::KeyPress (keyCode, mods, (juce::juce_wchar) textChar));
}

/*
 * Command. Sets the supersampling factor for every peer.
 *
 * NOT Desktop::setGlobalScaleFactor -- that leaves the peer's backing image at
 * logical size, so the canvas ends up the same resolution and merely displayed
 * smaller. Measured: at dpr 2 it gave a 913x569 buffer shown at 457x285 CSS
 * pixels, i.e. blurrier than doing nothing.
 *
 * Instead JUCE stays entirely in logical coordinates -- layout, hit testing and
 * popup fitting all keep working untouched -- and only the peer's image becomes
 * physical, painted through a scale transform. Surge's SVG skin and its fonts
 * are then genuinely re-rasterized at the higher density.
 */
void setScaleFactor (float scale)
{
    if (scale <= 0.0f || scale == juce::gRenderScale)
        return;

    juce::gRenderScale = scale;

    // Each peer must reallocate at the new physical size.
    for (auto *p : juce::WasmComponentPeer::peers())
        if (p != nullptr)
            p->rebuildImageForScale();
}

float getScaleFactor() { return juce::gRenderScale; }

void setDisplaySize (int width, int height)
{
    if (width <= 0 || height <= 0)
        return;

    const juce::Rectangle<int> area { 0, 0, width, height };
    if (area == juce::wasmDisplayArea)
        return;

    juce::wasmDisplayArea = area;

    // Desktop caches its display list, so it has to be told to re-ask; without
    // this the new size is ignored and menus keep using the stale bounds.
    // getDisplays() hands back a const reference but refresh() is a public,
    // non-const member -- casting is the only route JUCE offers here.
    const_cast<juce::Displays &> (juce::Desktop::getInstance().getDisplays()).refresh();
}

void setFocus (bool gained)
{
    if (auto *p = front())
    {
        if (gained)
            p->grabFocus();
        else
            p->loseFocus();
    }
}

} // namespace surgewasm

// Key-code constants, generated by tools/gen_keycodes.py.
#include <surge_wasm/juce_KeyCodes_wasm.cpp>
