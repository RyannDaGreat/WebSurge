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
 * SINGLE WINDOW BY DESIGN
 * -----------------------
 * A browser tab is one surface. Desktop JUCE opens real OS windows for menus
 * and dialogs; here every peer draws into its own buffer and JS composites the
 * topmost one. Surge's popup menus are Components too, so they come along for
 * free as additional peers.
 */

#include <emscripten/emscripten.h>

namespace juce
{

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

    ~WasmComponentPeer() override { peers().removeFirstMatchingValue (this); }

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
        if (bounds.getWidth() > 0 && bounds.getHeight() > 0)
        {
            image = Image (Image::ARGB, bounds.getWidth(), bounds.getHeight(), true);
            dirty = bounds.withZeroOrigin();
        }
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

        // Clear first: without it, translucent Surge widgets composite over the
        // previous frame and smear. Image::clear does this directly rather than
        // going through a Graphics fill, which would blend instead of replace.
        image.clear (area, Colours::transparentBlack);

        LowLevelGraphicsSoftwareRenderer renderer (image);
        renderer.clipToRectangle (area);
        handlePaint (renderer);
        return true;
    }

    void performAnyPendingRepaintsNow() override { renderIfDirty(); }

    Image &getImage() { return image; }
    bool hasPendingPaint() const { return ! dirty.isEmpty(); }

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
 * The canvas is the display. Its size is supplied by JS at startup rather than
 * probed, since there is no screen to ask.
 */
static Rectangle<int> wasmDisplayArea { 0, 0, 1280, 800 };

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
static Point<float> wasmMousePosition { 0.0f, 0.0f };

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

} // namespace juce
