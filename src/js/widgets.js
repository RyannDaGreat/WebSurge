/**
 * widgets.js -- renders Surge XT's real controls in the browser.
 *
 * Every number in this file comes from Surge's own source, not from measuring
 * screenshots:
 *   - control positions from layout.json, dumped from Surge's Connector registry
 *   - artwork from the classic-skin SVGs, referenced by the same numeric
 *     BACKGROUND id the desktop skin uses (id N -> bmp00N.svg)
 *   - slider geometry from ModulatableSlider.cpp
 *
 * A parameter finds its control the same way desktop Surge does: by looking up
 * its `ui_identifier` in the connector table.
 */

'use strict';

export const PANEL_WIDTH = 913; // globals.h BASE_WINDOW_SIZE_X
export const PANEL_HEIGHT = 569; // globals.h BASE_WINDOW_SIZE_Y

const SKIN_DIR = 'skin';

/*
 * Slider metrics, from ModulatableSlider.cpp setupSize().
 * `range` is the travel of the handle centre; the tray is drawn at an offset
 * from the connector origin, which is why trayDx/trayDy exist.
 */
const SLIDER = {
  horizontal: {
    trayW: 133, trayH: 14, range: 112, trayDx: 2, trayDy: 5,
    handleW: 20, handleH: 15,
    trayImage: 154, handleImage: 153,
  },
  vertical: {
    trayW: 16, trayH: 75, range: 56, trayDx: 2, trayDy: 2,
    handleW: 15, handleH: 20,
    trayImage: 105, handleImage: 157,
  },
};

/** Vertical sliders place the handle centre this far down before travel begins. */
const VERTICAL_HANDLE_Y0 = 9;

/** Fallback footprint for controls whose connector gives no explicit size. */
const DEFAULT_W = 133;
const DEFAULT_H = 20;

/**
 * Pure function. Resolves a connector's absolute position on the panel.
 *
 * Connectors inside a group carry coordinates relative to that group, so the
 * parent chain must be walked. Surge nests at most one level today, but the
 * loop costs nothing and will not silently misplace controls if that changes.
 *
 * @param {object} conn - connector record from layout.json
 * @param {Map<string, object>} byId - all connectors keyed by id
 * @returns {{x: number, y: number}} absolute panel coordinates
 *
 * @example
 * // "scene.volume" is at (0,0) inside group "scene.output.panel" at (606,78)
 * absolutePosition(volumeConn, byId) // { x: 606, y: 78 }
 */
export function absolutePosition(conn, byId) {
  let x = conn.x;
  let y = conn.y;
  let parent = conn.parent;
  const guard = new Set();

  while (parent && byId.has(parent) && !guard.has(parent)) {
    guard.add(parent);
    const p = byId.get(parent);
    x += p.x;
    y += p.y;
    parent = p.parent;
  }
  return { x, y };
}

/**
 * Pure function. URL of a classic-skin asset by its numeric id.
 *
 * @param {number|string} id
 * @returns {string}
 *
 * @example skinUrl(145) // "skin/bmp00145.svg"
 */
export function skinUrl(id) {
  return `${SKIN_DIR}/bmp${String(id).padStart(5, '0')}.svg`;
}

/**
 * Pure function. Which slider orientation a connector requests.
 *
 * Surge encodes this in control style flags rather than the component type.
 *
 * @param {object} conn
 * @returns {"horizontal"|"vertical"}
 *
 * @example sliderOrientation({style: {vertical: true}}) // "vertical"
 */
export function sliderOrientation(conn) {
  return conn.style?.vertical ? 'vertical' : 'horizontal';
}

/**
 * Creates a slider element bound to one parameter.
 *
 * Command: builds DOM and wires pointer handlers that call back into the engine.
 *
 * Dragging uses pointer capture and relative motion rather than absolute
 * position, so a drag that leaves the control still tracks -- matching how the
 * desktop plugin behaves.
 *
 * @param {object} param - parameter metadata from the engine
 * @param {object} conn - its connector
 * @param {(index: number, value: number) => void} onChange
 * @returns {HTMLElement}
 */
function makeSlider(param, conn, onChange) {
  const o = sliderOrientation(conn);
  const g = SLIDER[o];

  const el = document.createElement('div');
  el.className = `w slider slider-${o}`;
  el.style.width = `${g.trayW}px`;
  el.style.height = `${g.trayH}px`;
  el.style.marginLeft = `${g.trayDx}px`;
  el.style.marginTop = `${g.trayDy}px`;

  /*
   * Both tray and handle are SPRITE SHEETS, not single images -- drawing them
   * whole is what produced a wall of stretched diagonal bars on the first
   * attempt. Surge selects a cell by clipping to the control size and
   * translating by (-typeX*trayw, -typeY*trayh) [ModulatableSlider::paint];
   * background-position is the direct CSS equivalent.
   *
   * trayTypeY picks the tray variant, per updateLocationState():
   *   horizontal: 0 normal, 1 bipolar, 2 semitone, +3 when light ("white") style
   *   vertical:   0 normal, 1 bipolar, 2 mini
   * trayTypeX is the modulation state; unmodulated is column 0.
   */
  let trayTypeY = param.bipolar ? 1 : 0;
  if (o === 'horizontal' && conn.style?.white) trayTypeY += 3;

  const tray = document.createElement('div');
  tray.className = 'slider-tray';
  tray.style.width = `${g.trayW}px`;
  tray.style.height = `${g.trayH}px`;
  tray.style.backgroundImage = `url("${skinUrl(g.trayImage)}")`;
  // No background-size: the SVG's intrinsic size is the full sheet, which is
  // exactly what the offset math assumes.
  tray.style.backgroundPosition = `0px ${-trayTypeY * g.trayH}px`;

  // The handle sheet also holds modulation variants; the base handle is drawn
  // at a (-1,-1) offset from the handle rect [see the "Draw the handles" block].
  const handle = document.createElement('div');
  handle.className = 'slider-handle';
  handle.style.width = `${g.handleW}px`;
  handle.style.height = `${g.handleH}px`;
  handle.style.backgroundImage = `url("${skinUrl(g.handleImage)}")`;
  handle.style.backgroundPosition = '-1px -1px';

  el.append(tray, handle);

  /** Command. Moves the handle to reflect `v` (0..1). */
  const place = (v) => {
    if (o === 'horizontal') {
      handle.style.left = `${g.range * v + (g.trayW - g.range) / 2 - g.handleW / 2}px`;
      handle.style.top = `${(g.trayH - g.handleH) / 2}px`;
    } else {
      handle.style.left = `${(g.trayW - g.handleW) / 2}px`;
      handle.style.top = `${(1 - v) * g.range + VERTICAL_HANDLE_Y0 - g.handleH / 2}px`;
    }
  };

  let value = param.value;
  place(value);

  // Fine drag: holding shift scales motion down for precise edits, as in Surge.
  const FINE_DIVISOR = 8;

  let dragging = false;
  let last = 0;

  el.addEventListener('pointerdown', (e) => {
    dragging = true;
    last = o === 'horizontal' ? e.clientX : e.clientY;
    el.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const cur = o === 'horizontal' ? e.clientX : e.clientY;
    let delta = (cur - last) / g.range;
    if (o === 'vertical') delta = -delta;
    if (e.shiftKey) delta /= FINE_DIVISOR;
    last = cur;

    value = Math.max(0, Math.min(1, value + delta));
    place(value);
    onChange(param.index, value);
  });

  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    el.releasePointerCapture?.(e.pointerId);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);

  // Double click restores the parameter's default, as the desktop plugin does.
  el.addEventListener('dblclick', () => {
    value = param.defaultValue ?? 0.5;
    place(value);
    onChange(param.index, value);
  });

  el.setValue = (v) => {
    if (dragging) return; // never fight the user's hand
    value = v;
    place(v);
  };

  return el;
}

/**
 * Creates a sprite-sheet switch (Surge's CHSwitch2 / CSwitchControl).
 *
 * Command: builds DOM and wires click handling.
 *
 * Surge packs every state of a switch into one image as a grid of FRAMES cells
 * laid out in ROWS x COLUMNS. The element shows one cell by offsetting the
 * background, exactly as the desktop skin engine does.
 *
 * @param {object} param
 * @param {object} conn
 * @param {(index: number, value: number) => void} onChange
 * @returns {HTMLElement}
 */
function makeSwitch(param, conn, onChange) {
  const props = conn.properties || {};
  const frames = parseInt(props.FRAMES ?? '2', 10);
  const rows = parseInt(props.ROWS ?? '1', 10);
  const cols = parseInt(props.COLUMNS ?? String(frames), 10);
  const bg = props.BACKGROUND;

  const w = conn.w > 0 ? conn.w : DEFAULT_W;
  const h = conn.h > 0 ? conn.h : DEFAULT_H;

  const el = document.createElement('div');
  el.className = 'w switch';
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;

  if (bg) {
    // As with sliders, this is a sprite sheet whose intrinsic size already
    // equals cols*w x rows*h. Overriding background-size would rescale it and
    // throw every frame offset off.
    el.style.backgroundImage = `url("${skinUrl(bg)}")`;
  } else {
    el.classList.add('switch-noart');
  }

  /** Command. Shows the sprite cell for normalized value `v`. */
  const place = (v) => {
    const frame = Math.max(0, Math.min(frames - 1, Math.round(v * (frames - 1))));
    const col = frame % cols;
    const row = Math.floor(frame / cols);
    el.style.backgroundPosition = `${-col * w}px ${-row * h}px`;
    el.dataset.frame = String(frame);
  };

  let value = param.value;
  place(value);

  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (frames <= 1) return;

    // Multi-cell switches select by horizontal position (they are segmented
    // controls); two-state switches simply toggle.
    if (frames > 2 && cols > 1) {
      const rect = el.getBoundingClientRect();
      const seg = Math.floor(((e.clientX - rect.left) / rect.width) * frames);
      value = Math.max(0, Math.min(frames - 1, seg)) / (frames - 1);
    } else {
      value = value > 0.5 ? 0 : 1;
    }
    place(value);
    onChange(param.index, value);
  });

  el.setValue = (v) => { value = v; place(v); };
  return el;
}

/**
 * Creates a text readout control (number fields, menus, labels).
 *
 * Command: builds DOM. Drag adjusts the value; the element shows Surge's own
 * formatted display text, so units and scaling always match the plugin.
 *
 * @param {object} param
 * @param {object} conn
 * @param {(index: number, value: number) => void} onChange
 * @returns {HTMLElement}
 */
function makeReadout(param, conn, onChange) {
  const w = conn.w > 0 ? conn.w : DEFAULT_W;
  const h = conn.h > 0 ? conn.h : DEFAULT_H;

  const el = document.createElement('div');
  el.className = 'w readout';
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
  el.textContent = param.display ?? '';
  el.title = param.fullname || param.name;

  /** Pixels of vertical drag for a full 0..1 sweep. */
  const DRAG_RANGE_PX = 150;

  let value = param.value;
  let dragging = false;
  let last = 0;

  el.addEventListener('pointerdown', (e) => {
    dragging = true;
    last = e.clientY;
    el.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    value = Math.max(0, Math.min(1, value - (e.clientY - last) / DRAG_RANGE_PX));
    last = e.clientY;
    onChange(param.index, value);
  });
  const end = (e) => { dragging = false; el.releasePointerCapture?.(e.pointerId); };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);

  el.setValue = (v) => { value = v; };
  el.setDisplay = (text) => { el.textContent = text; };
  return el;
}

/**
 * Chooses and builds the right widget for a parameter.
 *
 * Command: creates DOM positioned absolutely on the panel.
 *
 * Component types come from Surge's own skin model. Anything not explicitly
 * handled falls back to a readout rather than being dropped, so no parameter
 * silently disappears from the interface.
 *
 * @param {object} param - engine parameter metadata
 * @param {object} conn - connector for param.uiid
 * @param {Map<string, object>} byId
 * @param {(index: number, value: number) => void} onChange
 * @returns {HTMLElement}
 */
export function createWidget(param, conn, byId, onChange) {
  let el;
  switch (conn.component) {
    case 'CSurgeSlider':
      el = makeSlider(param, conn, onChange);
      break;
    case 'CHSwitch2':
    case 'CSwitchControl':
    case 'FilterSelector':
    case 'WaveShaperSelector':
      el = makeSwitch(param, conn, onChange);
      break;
    default:
      el = makeReadout(param, conn, onChange);
      break;
  }

  const { x, y } = absolutePosition(conn, byId);
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.dataset.uiid = conn.id;
  el.dataset.index = String(param.index);
  if (!el.title) el.title = `${param.fullname || param.name}`;

  return el;
}
