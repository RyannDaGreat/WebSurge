/**
 * themes.js -- the skins.
 *
 * A skin is not a palette. Each one is a table of Tailwind utility classes, one
 * entry per REGION of the page chrome, and applying it rewrites that region's
 * class attribute outright. That is why skins can differ in layout -- sidebar
 * left or right, toolbar flush or floating, dense or airy, mono or serif -- and
 * not only in hue. There is no stylesheet to override because there is no
 * stylesheet: Tailwind's browser build compiles whatever classes it finds in the
 * live DOM, so swapping these strings recompiles the page.
 *
 * Every region's final class attribute is:
 *
 *     MARKERS[region] + BASE[region] + THEMES[name].classes[region] + sticky
 *
 * BASE is the layout plumbing a skin must not break (a scroll container has to
 * scroll). MARKERS are the class names other modules query by -- patches.js
 * finds rows with '.patch', so that class survives being dressed. Sticky
 * classes are runtime state ('selected', 'held', 'indeterminate') that skins
 * style through the arbitrary variant '[&.selected]:...'; they are re-applied
 * last so a skin change cannot drop them.
 *
 * The single generated file in the project. Regenerate with
 * node .frenzy/build_themes.mjs after editing a skin.
 */

'use strict';

/** Every styleable region, in the order applyTheme walks them. */
export const REGIONS = ["html", "body", "toolbar", "brand", "status", "progress", "chip", "chipWarn", "ctl", "select", "checkbox", "button", "errorBar", "main", "sidebar", "sidebarCount", "sidebarFilter", "bankSummary", "catSummary", "patchRow", "stage", "decor", "canvasWrap", "canvas", "footer", "piano", "keyWhite", "keyBlack", "overlay", "overlayBox", "startBtn"];

/**
 * Where each region lives. Every match is dressed, so the thousands of patch
 * rows and 128 piano keys are covered by one entry each.
 */
const SELECTORS = {
  html: 'html',
  body: 'body',
  toolbar: '#toolbar',
  brand: '#brand',
  status: '#status',
  progress: '#progress',
  chip: '#kb-state, #scale-info',
  chipWarn: '#unplaced',
  ctl: '#toolbar label.ctl',
  select: '#zoom-select, #theme-select, #mode-select',
  checkbox: '#retina-toggle',
  button: '#panic-btn',
  errorBar: '#error-bar',
  main: '#main',
  sidebar: '#patch-list',
  sidebarCount: '#patch-list .patch-count',
  sidebarFilter: '#patch-list .patch-filter',
  bankSummary: '#patch-list .bank > summary',
  catSummary: '#patch-list .category > summary',
  patchRow: '#patch-list .patch',
  stage: '#stage',
  decor: '#decor',
  canvasWrap: '#canvas-wrap',
  canvas: '#surge-canvas',
  footer: '#footer',
  piano: '#piano',
  keyWhite: '#piano .key.white',
  keyBlack: '#piano .key.black',
  // The shortcut legend is dressed as an overlay too, so it inherits each
  // skin's veil, panel and type without any skin knowing it exists.
  overlay: '#overlay, #shortcut-key',
  overlayBox: '#overlay-box, #shortcut-key-box',
  startBtn: '#start-btn',
};

/**
 * Layout plumbing. A skin is appended after this and so can override any of it,
 * but breaking these breaks the app rather than the look.
 *
 * Two subtleties worth stating, because both are silent failures:
 *   - '[&[hidden]]:hidden' is needed wherever a skin sets a display: the UA
 *     rule for [hidden] loses to an author 'display: block', so filtered-out
 *     patch rows and the dismissed overlay would stay visible without it.
 *   - the piano's note labels are an ::after carrying content: attr(data-label).
 *     Keys without the attribute render an empty box, which is invisible, so the
 *     variant does not need to be conditional.
 */
const BASE = {
  html: '',
  body: 'm-0 h-screen flex flex-col overflow-hidden',
  toolbar: 'flex items-center gap-3 shrink-0',
  brand: 'm-0',
  // min-w-40, not min-w-0. With min-w-0 the status is the only flexible item in
  // the toolbar, so it absorbs every overflow and collapses to zero -- the
  // status read "r.." on the two skins with the largest type. A floor makes it
  // refuse, which forces a wrapping toolbar to wrap and a fixed one to clip
  // something less important instead.
  status: 'flex-1 min-w-40 truncate',
  progress: "relative overflow-hidden shrink-0 [&[hidden]]:hidden after:content-[''] after:absolute after:inset-0 after:origin-left after:scale-x-[var(--progress,0)] after:transition-transform [&.indeterminate]:after:scale-x-100 [&.indeterminate]:after:w-2/5 [&.indeterminate]:after:animate-sweep",
  chip: 'shrink-0 whitespace-nowrap',
  chipWarn: 'shrink-0 whitespace-nowrap',
  ctl: 'flex items-center gap-1 shrink-0',
  select: 'shrink-0',
  checkbox: '',
  button: 'shrink-0 cursor-pointer disabled:opacity-45 disabled:cursor-default',
  errorBar: 'shrink-0 [&[hidden]]:hidden',
  main: 'flex flex-1 min-h-0',
  sidebar: 'shrink-0 overflow-y-auto',
  sidebarCount: '',
  sidebarFilter: 'w-full outline-none',
  bankSummary: 'cursor-pointer',
  catSummary: 'cursor-pointer',
  patchRow: 'block w-full text-left cursor-pointer [&[hidden]]:hidden',
  stage: 'flex-1 min-w-0 overflow-auto relative',
  decor: 'pointer-events-none absolute inset-0',
  canvasWrap: 'relative w-fit',
  canvas: 'block outline-none touch-none cursor-default',
  footer: 'relative max-w-[57rem]',
  piano: 'relative shrink-0 overflow-hidden touch-none select-none',
  keyWhite: "absolute top-0 h-full box-border after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0.5 after:text-center after:text-[8px] after:content-[attr(data-label)]",
  keyBlack: 'absolute top-0 h-[62%] box-border z-20',
  overlay: 'fixed inset-0 z-50 flex items-center justify-center [&[hidden]]:hidden',
  // max-w-md and centring suit the start gate. The legend sets its own width
  // and alignment, so BASE only carries what both need.
  overlayBox: 'max-w-[min(56rem,92vw)]',
  startBtn: 'cursor-pointer disabled:opacity-45',
};

/** Class names other modules select by, which dressing must not remove. */
const MARKERS = {
  ctl: 'ctl',
  sidebarCount: 'patch-count',
  sidebarFilter: 'patch-filter',
  patchRow: 'patch',
  piano: 'piano',
  keyWhite: 'key white',
  keyBlack: 'key black',
};

/** Runtime state classes, re-applied after dressing so a skin change keeps them. */
const STICKY = ['selected', 'held', 'indeterminate'];

/** Regions built by patches.js and piano.js, i.e. absent until Surge starts. */
const GENERATED = [
  'sidebarCount', 'sidebarFilter', 'bankSummary', 'catSummary', 'patchRow',
  'piano', 'keyWhite', 'keyBlack',
];

export const DEFAULT_THEME = 'glass';
const STORAGE_KEY = 'websurge.skin';

export const THEMES = {
  /* Frosted Glass */
  glass: {
    label: "Frosted Glass",
    classes: {
      html: "font-sans scheme-dark",
      body: "bg-slate-950 text-slate-200 antialiased bg-fixed bg-[radial-gradient(ellipse_90%_55%_at_50%_-10%,rgba(99,102,241,0.30),transparent_70%),radial-gradient(ellipse_60%_50%_at_88%_105%,rgba(56,189,248,0.18),transparent_70%),repeating-linear-gradient(45deg,rgba(255,255,255,0.035)_0px,rgba(255,255,255,0.035)_1px,transparent_1px,transparent_9px)]",
      toolbar: "m-3 mb-0 h-14 px-6 rounded-full bg-white/5 backdrop-blur-xl ring-1 ring-white/10 shadow-2xl shadow-slate-950/70 text-slate-200",
      brand: "text-base font-semibold tracking-tight text-white",
      status: "text-xs font-medium text-slate-400",
      progress: "w-40 h-1.5 rounded-full bg-white/10 ring-1 ring-white/10 after:bg-sky-400 after:rounded-full",
      chip: "text-xs font-mono tabular-nums text-slate-400",
      chipWarn: "text-xs font-mono tabular-nums text-amber-300",
      ctl: "text-xs tracking-wide text-slate-400",
      select: "rounded-full bg-white/5 px-3 py-1 text-xs text-slate-100 ring-1 ring-white/15 backdrop-blur-md transition-colors hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-sky-400/70",
      checkbox: "size-4 accent-sky-400",
      button: "rounded-full bg-rose-500/15 px-4 py-1.5 text-xs font-semibold text-rose-100 ring-1 ring-rose-400/30 backdrop-blur-md shadow-lg shadow-rose-950/40 transition hover:bg-rose-500/30 hover:text-white active:scale-95 active:bg-rose-500/45",
      errorBar: "mx-3 mt-2 rounded-2xl bg-rose-500/15 px-5 py-2.5 text-sm font-semibold text-rose-100 ring-1 ring-rose-400/30 backdrop-blur-md",
      main: "gap-3 p-3",
      sidebar: "w-80 rounded-2xl bg-white/5 backdrop-blur-md ring-1 ring-white/10 shadow-2xl shadow-slate-950/60",
      sidebarCount: "sticky top-0 z-10 rounded-t-2xl bg-slate-950/70 px-4 py-3 backdrop-blur-xl text-[11px] font-semibold uppercase tracking-[0.2em] text-sky-300/80",
      sidebarFilter: "mx-3 mt-3 mb-2 w-[calc(100%-1.5rem)] rounded-xl bg-white/5 px-3 py-2 text-sm text-slate-100 ring-1 ring-white/10 backdrop-blur-md transition placeholder:text-slate-500 focus:ring-2 focus:ring-sky-400/70",
      bankSummary: "mx-2 my-1 rounded-xl bg-white/5 px-4 py-2.5 text-xs font-semibold uppercase tracking-widest text-slate-100 marker:text-sky-400 transition-colors hover:bg-white/10",
      catSummary: "mx-2 rounded-lg py-1.5 pl-8 pr-4 text-xs text-slate-400 marker:text-slate-500 transition-colors hover:bg-white/5 hover:text-sky-200",
      patchRow: "mx-2 w-[calc(100%-1rem)] rounded-lg py-1 pl-12 pr-4 text-[13px] text-slate-400 transition-colors hover:bg-white/10 hover:text-white [&.selected]:bg-sky-400/20 [&.selected]:text-sky-50 [&.selected]:font-semibold [&.selected]:ring-1 [&.selected]:ring-sky-300/30",
      stage: "p-8 bg-[radial-gradient(ellipse_70%_60%_at_50%_0%,rgba(56,189,248,0.10),transparent_70%)]",
      decor: "opacity-70 mix-blend-screen bg-[repeating-linear-gradient(45deg,rgba(255,255,255,0.05)_0px,rgba(255,255,255,0.05)_1px,transparent_1px,transparent_10px),radial-gradient(ellipse_55%_45%_at_30%_15%,rgba(129,140,248,0.16),transparent_70%)] [mask-image:radial-gradient(ellipse_at_center,black,transparent_78%)]",
      canvasWrap: "rounded-2xl overflow-hidden ring-1 ring-white/15 bg-white/5 p-2 backdrop-blur-md shadow-[0_25px_60px_-15px_rgba(2,6,23,0.9),0_0_90px_-30px_rgba(99,102,241,0.75)]",
      canvas: "rounded-xl",
      footer: "mt-8 rounded-2xl bg-slate-950/50 p-5 ring-1 ring-white/10 backdrop-blur-md text-xs leading-relaxed text-slate-300 [&_a]:text-sky-300 [&_a]:underline [&_a]:underline-offset-2 [&_a]:decoration-sky-400/40 hover:[&_a]:text-sky-200 [&_kbd]:rounded-md [&_kbd]:bg-white/10 [&_kbd]:px-1.5 [&_kbd]:py-0.5 [&_kbd]:font-mono [&_kbd]:text-[11px] [&_kbd]:text-slate-100 [&_kbd]:ring-1 [&_kbd]:ring-white/15",
      piano: "h-24 mx-3 mb-3 rounded-t-2xl rounded-b-xl bg-white/5 backdrop-blur-xl ring-1 ring-white/10 shadow-2xl shadow-slate-950/70",
      keyWhite: "bg-slate-200/85 border border-slate-950/40 rounded-b-md transition-colors hover:bg-white after:text-[9px] after:text-slate-500 [&.held]:bg-sky-300 [&.held]:shadow-[inset_0_0_14px_rgba(2,132,199,0.65)]",
      keyBlack: "bg-slate-950/95 border border-white/10 rounded-b-md transition-colors hover:bg-slate-800 [&.held]:bg-indigo-400 [&.held]:border-indigo-200/40",
      overlay: "bg-slate-950/80 backdrop-blur-2xl bg-[radial-gradient(ellipse_60%_50%_at_50%_40%,rgba(99,102,241,0.25),transparent_70%),repeating-linear-gradient(45deg,rgba(255,255,255,0.04)_0px,rgba(255,255,255,0.04)_1px,transparent_1px,transparent_9px)]",
      overlayBox: "rounded-3xl bg-white/5 p-10 ring-1 ring-white/15 backdrop-blur-xl shadow-2xl shadow-slate-950/80 text-slate-300 [&_h2]:mb-3 [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-white [&_p]:text-sm [&_p]:leading-relaxed [&_p]:text-slate-400",
      startBtn: "mt-6 rounded-full bg-linear-to-r from-sky-400 to-indigo-500 px-8 py-3 text-base font-semibold text-slate-950 ring-1 ring-white/25 shadow-[0_12px_45px_-10px_rgba(56,189,248,0.8)] transition hover:from-sky-300 hover:to-indigo-400 hover:scale-105 active:scale-95",
    },
  },

  /* Brutalist */
  brutalist: {
    label: "Brutalist",
    classes: {
      html: "font-mono scheme-light",
      body: "bg-yellow-300 bg-[repeating-linear-gradient(45deg,#00000014_0_18px,transparent_18px_36px)] text-black selection:bg-black selection:text-yellow-300",
      toolbar: "h-14 px-4 m-0 rounded-none border-b-4 border-black bg-yellow-400 shadow-none backdrop-blur-none",
      brand: "text-xl font-black uppercase tracking-tighter text-black",
      status: "text-xs font-bold uppercase tracking-widest text-black",
      progress: "w-28 h-3 rounded-none border-2 border-black bg-white after:bg-black after:rounded-none",
      chip: "rounded-none border-2 border-black bg-white px-1.5 py-0.5 font-mono text-[11px] font-bold uppercase tracking-wider tabular-nums text-black",
      chipWarn: "rounded-none border-2 border-black bg-red-600 px-1.5 py-0.5 font-mono text-[11px] font-black uppercase tracking-wider text-white",
      ctl: "text-[11px] font-bold uppercase tracking-widest text-black",
      select: "rounded-none border-2 border-black bg-white px-2 py-1 text-xs font-bold uppercase tracking-wide text-black transition-none hover:bg-yellow-200 focus:bg-yellow-300 focus:outline-none",
      checkbox: "size-4 accent-red-600",
      button: "rounded-none border-2 border-black bg-red-500 px-3 py-1 text-xs font-black uppercase tracking-widest text-white shadow-[4px_4px_0_0_#000] transition-none hover:bg-red-400 active:translate-x-[3px] active:translate-y-[3px] active:shadow-none",
      errorBar: "border-y-4 border-black bg-red-600 px-4 py-2 text-sm font-black uppercase tracking-widest text-white",
      main: "flex-row-reverse",
      sidebar: "w-80 m-0 rounded-none border-l-4 border-black bg-white shadow-none",
      sidebarCount: "sticky top-0 z-10 border-b-4 border-black bg-black px-3 py-2 text-xs font-black uppercase tracking-[0.2em] text-yellow-300",
      sidebarFilter: "rounded-none border-b-4 border-black bg-yellow-200 px-3 py-2 text-sm font-bold uppercase tracking-wide text-black placeholder:font-bold placeholder:text-black/50 focus:bg-yellow-300",
      bankSummary: "border-b-2 border-black bg-yellow-400 px-3 py-2 text-sm font-black uppercase tracking-widest text-black transition-none marker:text-black hover:bg-yellow-300",
      catSummary: "border-b border-black/30 py-1.5 pl-6 pr-3 text-xs font-bold uppercase tracking-wide text-black transition-none marker:text-red-600 hover:bg-yellow-100",
      patchRow: "py-1 pl-10 pr-3 text-xs font-medium text-black transition-none hover:bg-black hover:text-yellow-300 [&.selected]:bg-red-500 [&.selected]:font-black [&.selected]:uppercase [&.selected]:tracking-wide [&.selected]:text-white",
      stage: "p-8 bg-yellow-300 bg-[repeating-linear-gradient(45deg,#00000012_0_22px,transparent_22px_44px)]",
      decor: "bottom-auto h-20 border-b-4 border-black bg-[repeating-linear-gradient(45deg,#000_0_20px,transparent_20px_40px)]",
      canvasWrap: "rounded-none border-4 border-black bg-black overflow-hidden shadow-[12px_12px_0_0_#000]",
      canvas: "",
      footer: "mt-10 rounded-none border-4 border-black bg-white p-4 text-xs leading-relaxed text-black shadow-[6px_6px_0_0_#000] [&_a]:font-black [&_a]:text-red-600 [&_a]:underline [&_a]:underline-offset-2 [&_a:hover]:bg-yellow-300 [&_kbd]:inline-block [&_kbd]:rounded-none [&_kbd]:border-2 [&_kbd]:border-black [&_kbd]:bg-yellow-300 [&_kbd]:px-1.5 [&_kbd]:py-0.5 [&_kbd]:font-mono [&_kbd]:text-[11px] [&_kbd]:font-black [&_kbd]:uppercase [&_kbd]:shadow-[2px_2px_0_0_#000]",
      piano: "h-24 m-0 rounded-none border-t-4 border-black bg-black shadow-none",
      keyWhite: "rounded-none border-2 border-black bg-white transition-none hover:bg-yellow-200 after:text-[9px] after:font-black after:uppercase after:tracking-widest after:text-black [&.held]:bg-red-500",
      keyBlack: "rounded-none border-2 border-black bg-black transition-none hover:bg-neutral-700 [&.held]:bg-red-500",
      overlay: "bg-yellow-300 bg-[repeating-linear-gradient(45deg,#000_0_24px,transparent_24px_48px)] backdrop-blur-none",
      overlayBox: "rounded-none border-4 border-black bg-white p-8 text-black shadow-[14px_14px_0_0_#000] [&_h2]:m-0 [&_h2]:text-3xl [&_h2]:font-black [&_h2]:uppercase [&_h2]:tracking-tighter [&_h2]:text-black [&_p]:mt-3 [&_p]:text-sm [&_p]:font-bold [&_p]:uppercase [&_p]:tracking-wide [&_p]:text-black",
      startBtn: "mt-6 rounded-none border-4 border-black bg-yellow-400 px-10 py-4 text-2xl font-black uppercase tracking-tighter text-black shadow-[8px_8px_0_0_#000] transition-none hover:bg-red-500 hover:text-white active:translate-x-[8px] active:translate-y-[8px] active:shadow-none",
    },
  },

  /* Synthwave */
  synthwave: {
    label: "Synthwave",
    classes: {
      html: "font-sans scheme-dark",
      body: "bg-slate-950 text-slate-200 bg-[radial-gradient(120%_80%_at_50%_-10%,rgba(217,70,239,0.18),transparent_60%),repeating-linear-gradient(45deg,rgba(168,85,247,0.06)_0px,rgba(168,85,247,0.06)_1px,transparent_1px,transparent_10px)]",
      toolbar: "relative h-14 px-4 bg-slate-950/80 backdrop-blur-md shadow-[0_12px_40px_-16px_rgba(217,70,239,0.65)] after:content-[''] after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-gradient-to-r after:from-fuchsia-500 after:via-cyan-400 after:to-violet-500",
      brand: "text-lg font-black uppercase tracking-[0.25em] whitespace-nowrap bg-gradient-to-r from-fuchsia-400 via-pink-300 to-cyan-300 bg-clip-text text-transparent drop-shadow-[0_0_12px_rgba(217,70,239,0.55)]",
      status: "text-xs font-mono tracking-wide text-cyan-200",
      progress: "w-40 h-1.5 rounded-full overflow-hidden bg-violet-950 ring-1 ring-fuchsia-500/40 after:rounded-full after:bg-gradient-to-r after:from-fuchsia-500 after:via-pink-400 after:to-cyan-400",
      chip: "text-[11px] font-mono tabular-nums uppercase tracking-[0.15em] text-violet-200",
      chipWarn: "text-[11px] font-mono font-semibold uppercase tracking-[0.15em] text-amber-300 drop-shadow-[0_0_8px_rgba(252,211,77,0.5)]",
      ctl: "text-[11px] uppercase tracking-[0.2em] text-violet-300",
      select: "rounded-lg px-2 py-1 text-xs bg-slate-900 text-cyan-100 ring-1 ring-fuchsia-500/45 shadow-[0_0_14px_-4px_rgba(217,70,239,0.8)] hover:ring-fuchsia-400/80 focus:outline-none focus:ring-2 focus:ring-cyan-400/80 transition",
      checkbox: "size-4 accent-fuchsia-500",
      button: "rounded-lg px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.2em] text-rose-50 bg-gradient-to-br from-rose-600 via-fuchsia-600 to-purple-700 ring-1 ring-rose-300/60 shadow-[0_0_18px_-2px_rgba(244,63,94,0.75)] hover:shadow-[0_0_30px_0_rgba(244,63,94,0.95)] hover:brightness-110 active:scale-95 transition duration-200",
      errorBar: "px-4 py-2 text-xs font-semibold uppercase tracking-[0.15em] bg-rose-950 text-rose-100 ring-1 ring-rose-500/60 shadow-[0_0_28px_-6px_rgba(244,63,94,0.9)]",
      main: "gap-3 px-3 pb-3 pt-3",
      sidebar: "w-80 rounded-2xl bg-slate-950/70 backdrop-blur-sm ring-1 ring-fuchsia-500/30 shadow-[0_0_48px_-18px_rgba(217,70,239,0.85)]",
      sidebarCount: "sticky top-0 z-10 px-3 py-2 bg-slate-950/95 backdrop-blur text-[10px] uppercase tracking-[0.25em] text-fuchsia-300 border-b border-fuchsia-500/25",
      sidebarFilter: "px-3 py-2 text-xs rounded-xl bg-slate-900 text-cyan-100 placeholder:text-violet-400/60 border border-fuchsia-500/30 transition focus:border-cyan-400/80 focus:shadow-[0_0_20px_-3px_rgba(34,211,238,0.8)]",
      bankSummary: "px-3 py-2 text-[11px] font-bold uppercase tracking-[0.2em] text-fuchsia-200 bg-gradient-to-r from-fuchsia-950/70 to-transparent hover:from-fuchsia-900/70 marker:text-cyan-400 transition-colors",
      catSummary: "pl-6 pr-3 py-1.5 text-xs text-violet-200 hover:text-cyan-200 hover:bg-violet-500/10 marker:text-fuchsia-400 transition-colors",
      patchRow: "pl-9 pr-3 py-1 text-xs text-slate-300 transition-colors duration-150 hover:bg-fuchsia-500/10 hover:text-cyan-100 [&.selected]:bg-gradient-to-r [&.selected]:from-fuchsia-600 [&.selected]:via-violet-600 [&.selected]:to-transparent [&.selected]:text-white [&.selected]:font-semibold [&.selected]:shadow-[inset_0_0_20px_-6px_rgba(34,211,238,0.9)]",
      stage: "p-6 rounded-2xl bg-slate-950/40 ring-1 ring-violet-500/20 bg-[radial-gradient(90%_60%_at_50%_130%,rgba(217,70,239,0.16),transparent_70%)]",
      decor: "mix-blend-screen animate-pulse [animation-duration:9s] bg-[repeating-linear-gradient(90deg,rgba(217,70,239,0.28)_0px,rgba(217,70,239,0.28)_1px,transparent_1px,transparent_56px),repeating-linear-gradient(0deg,rgba(34,211,238,0.18)_0px,rgba(34,211,238,0.18)_1px,transparent_1px,transparent_26px),repeating-linear-gradient(45deg,rgba(168,85,247,0.07)_0px,rgba(168,85,247,0.07)_2px,transparent_2px,transparent_14px),radial-gradient(60%_45%_at_50%_100%,rgba(236,72,153,0.30),rgba(88,28,135,0.14)_45%,transparent_75%)] [background-size:100%_45%,100%_45%,100%_100%,100%_100%] [background-position:bottom,bottom,center,bottom] [background-repeat:repeat,repeat,repeat,no-repeat]",
      canvasWrap: "rounded-2xl overflow-hidden p-1 bg-slate-950 ring-2 ring-fuchsia-500/60 shadow-[0_0_60px_-10px_rgba(217,70,239,0.75),0_0_130px_-40px_rgba(34,211,238,0.65)]",
      canvas: "rounded-xl",
      footer: "mt-6 text-xs leading-relaxed text-slate-300 [&_a]:text-cyan-300 [&_a]:underline [&_a]:decoration-cyan-500/50 [&_a]:underline-offset-2 [&_a:hover]:text-fuchsia-300 [&_kbd]:mx-0.5 [&_kbd]:inline-block [&_kbd]:rounded [&_kbd]:bg-slate-900 [&_kbd]:px-1.5 [&_kbd]:py-0.5 [&_kbd]:font-mono [&_kbd]:text-[10px] [&_kbd]:text-fuchsia-200 [&_kbd]:ring-1 [&_kbd]:ring-fuchsia-500/40 [&_kbd]:shadow-[0_0_10px_-3px_rgba(217,70,239,0.8)]",
      piano: "h-24 mx-3 rounded-t-2xl bg-gradient-to-b from-slate-950 to-black border-t border-fuchsia-500/50 shadow-[0_-12px_44px_-14px_rgba(217,70,239,0.75)]",
      keyWhite: "rounded-b-md border border-slate-800 bg-gradient-to-b from-slate-100 to-slate-300 transition-colors hover:from-white hover:to-cyan-100 after:text-[9px] after:text-slate-500 [&.held]:from-cyan-200 [&.held]:to-cyan-400 [&.held]:border-cyan-200 [&.held]:shadow-[0_0_24px_2px_rgba(34,211,238,0.9)] [&.held]:after:text-slate-900",
      keyBlack: "rounded-b-md bg-black border border-fuchsia-500/50 transition-colors shadow-[0_0_10px_-2px_rgba(217,70,239,0.8)] hover:border-fuchsia-400 hover:shadow-[0_0_18px_0_rgba(217,70,239,0.9)] [&.held]:bg-fuchsia-600 [&.held]:border-cyan-300 [&.held]:shadow-[0_0_24px_2px_rgba(34,211,238,0.95)]",
      overlay: "bg-slate-950/85 backdrop-blur-md bg-[radial-gradient(70%_50%_at_50%_100%,rgba(217,70,239,0.30),transparent_70%),repeating-linear-gradient(45deg,rgba(34,211,238,0.05)_0px,rgba(34,211,238,0.05)_2px,transparent_2px,transparent_14px)]",
      overlayBox: "rounded-3xl p-10 bg-slate-950/90 text-slate-200 ring-1 ring-fuchsia-500/50 shadow-[0_0_80px_-10px_rgba(217,70,239,0.85)] [&_h2]:m-0 [&_h2]:mb-3 [&_h2]:text-2xl [&_h2]:font-black [&_h2]:uppercase [&_h2]:tracking-[0.2em] [&_h2]:bg-gradient-to-r [&_h2]:from-fuchsia-400 [&_h2]:to-cyan-300 [&_h2]:bg-clip-text [&_h2]:text-transparent [&_p]:mt-0 [&_p]:mb-6 [&_p]:text-sm [&_p]:leading-relaxed [&_p]:text-violet-200",
      startBtn: "rounded-2xl px-10 py-4 text-base font-black uppercase tracking-[0.3em] text-white bg-gradient-to-r from-fuchsia-600 via-purple-600 to-cyan-500 ring-2 ring-cyan-300/50 shadow-[0_0_40px_-6px_rgba(217,70,239,0.9)] hover:shadow-[0_0_66px_0_rgba(34,211,238,0.9)] hover:brightness-110 active:scale-95 transition duration-200",
    },
  },

  /* CRT Terminal */
  crt: {
    label: "CRT Terminal",
    classes: {
      html: "font-mono scheme-dark",
      body: "bg-black text-green-400 antialiased bg-fixed bg-[radial-gradient(ellipse_80%_60%_at_50%_-10%,rgba(34,197,94,0.10),transparent_70%)]",
      toolbar: "h-10 px-3 rounded-none border-b border-green-500/40 bg-black text-green-400",
      brand: "text-xs font-bold uppercase tracking-[0.3em] text-green-300 drop-shadow-[0_0_6px_rgba(74,222,128,0.7)] before:mr-2 before:text-green-700 before:content-['>'] after:ml-1.5 after:inline-block after:h-3 after:w-2 after:translate-y-0.5 after:animate-pulse after:bg-green-400 after:content-['']",
      status: "text-[11px] uppercase tracking-[0.1em] tabular-nums text-green-500",
      progress: "w-32 h-2 rounded-none border border-green-500/50 bg-black after:rounded-none after:bg-green-400 after:shadow-[0_0_8px_rgba(74,222,128,0.8)]",
      chip: "text-[11px] uppercase tracking-[0.1em] tabular-nums text-green-500",
      chipWarn: "text-[11px] uppercase tracking-[0.1em] tabular-nums text-amber-400",
      ctl: "text-[10px] uppercase tracking-[0.2em] text-green-600",
      select: "rounded-none border border-green-500/50 bg-black px-2 py-0.5 text-[11px] uppercase tracking-[0.1em] text-green-300 transition-colors hover:border-green-400 focus:outline-none focus:border-green-400 focus:shadow-[0_0_8px_rgba(74,222,128,0.5)]",
      checkbox: "size-3.5 accent-green-400",
      button: "rounded-none border border-amber-400/70 bg-black px-3 py-1 text-[11px] font-bold uppercase tracking-[0.2em] text-amber-400 transition-colors hover:bg-amber-400 hover:text-black active:bg-amber-300 active:text-black",
      errorBar: "border-y border-amber-400 bg-amber-400/10 px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.15em] text-amber-300",
      main: "",
      sidebar: "w-64 rounded-none border-r border-green-500/40 bg-black",
      sidebarCount: "sticky top-0 z-10 border-b border-green-500/30 bg-black px-2 py-1.5 text-[10px] uppercase tracking-[0.2em] text-green-500",
      sidebarFilter: "rounded-none border-b border-green-500/30 bg-black px-2 py-1.5 text-[11px] leading-tight text-green-200 placeholder:text-green-700 placeholder:uppercase placeholder:tracking-[0.15em] focus:bg-green-400/10 focus:border-green-400",
      bankSummary: "px-2 py-1 text-[11px] font-bold uppercase tracking-[0.15em] leading-tight text-green-200 bg-green-400/5 marker:text-green-500 transition-colors hover:bg-green-400/20",
      catSummary: "py-0.5 pl-5 pr-2 text-[11px] uppercase tracking-[0.08em] leading-tight text-green-400 marker:text-green-700 transition-colors hover:bg-green-400/10 hover:text-green-200",
      patchRow: "py-0.5 pl-8 pr-2 text-[11px] leading-tight text-green-500 transition-colors hover:bg-green-400/15 hover:text-green-100 [&.selected]:bg-green-400 [&.selected]:text-black [&.selected]:font-bold [&.selected]:shadow-[0_0_12px_-2px_rgba(74,222,128,0.8)]",
      stage: "p-6 bg-[repeating-linear-gradient(45deg,rgba(34,197,94,0.055)_0px,rgba(34,197,94,0.055)_1px,transparent_1px,transparent_8px)]",
      decor: "opacity-80 bg-[repeating-linear-gradient(0deg,rgba(0,0,0,0.35)_0px,rgba(0,0,0,0.35)_1px,transparent_1px,transparent_3px),radial-gradient(ellipse_65%_55%_at_50%_30%,rgba(74,222,128,0.10),transparent_70%)] after:absolute after:inset-0 after:animate-pulse after:bg-green-400/[0.025] after:content-['']",
      canvasWrap: "rounded-none border border-green-500/60 bg-black p-1 shadow-[0_0_40px_-5px_rgba(34,197,94,0.45)]",
      canvas: "",
      footer: "z-10 mt-6 text-[11px] leading-snug text-green-500 [&_a]:text-green-300 [&_a]:underline [&_a]:underline-offset-2 hover:[&_a]:text-green-100 [&_kbd]:rounded-none [&_kbd]:border [&_kbd]:border-green-500/50 [&_kbd]:bg-black [&_kbd]:px-1 [&_kbd]:text-[10px] [&_kbd]:uppercase [&_kbd]:text-green-200",
      piano: "h-16 rounded-none border-t border-green-500/40 bg-black shadow-[0_-8px_24px_-16px_rgba(34,197,94,0.6)]",
      keyWhite: "rounded-none border border-green-500/40 bg-neutral-950 transition-colors hover:bg-green-400/15 after:text-[8px] after:uppercase after:text-green-700 [&.held]:bg-green-400 [&.held]:shadow-[0_0_14px_rgba(74,222,128,0.9)] [&.held]:after:text-black",
      keyBlack: "rounded-none border border-green-500/30 bg-black transition-colors hover:bg-green-400/20 [&.held]:border-lime-200 [&.held]:bg-lime-300 [&.held]:shadow-[0_0_14px_rgba(163,230,53,0.9)]",
      overlay: "bg-black/95 bg-[repeating-linear-gradient(0deg,rgba(0,0,0,0.45)_0px,rgba(0,0,0,0.45)_1px,transparent_1px,transparent_3px),radial-gradient(ellipse_55%_45%_at_50%_50%,rgba(34,197,94,0.16),transparent_70%)]",
      overlayBox: "rounded-none border border-green-500/60 bg-black p-8 text-green-500 shadow-[0_0_60px_-10px_rgba(34,197,94,0.5)] [&_h2]:mb-3 [&_h2]:text-lg [&_h2]:font-bold [&_h2]:uppercase [&_h2]:tracking-[0.3em] [&_h2]:text-green-300 [&_p]:text-[11px] [&_p]:leading-snug [&_p]:text-green-500",
      startBtn: "mt-6 rounded-none border border-green-400 bg-black px-8 py-2.5 text-sm font-bold uppercase tracking-[0.35em] text-green-300 shadow-[0_0_24px_-6px_rgba(74,222,128,0.8)] transition-colors hover:bg-green-400 hover:text-black active:bg-green-200 active:text-black",
    },
  },

  /* Paper & Ink */
  paper: {
    label: "Paper & Ink",
    classes: {
      html: "font-serif scheme-light",
      body: "bg-stone-100 text-stone-800 bg-[repeating-linear-gradient(45deg,rgba(120,113,108,0.05)_0_2px,transparent_0_16px)]",
      toolbar: "h-16 px-8 bg-stone-50 border-b border-stone-300 rounded-none shadow-none",
      brand: "text-lg font-normal uppercase tracking-[0.24em] text-stone-900",
      status: "text-sm italic text-stone-600",
      progress: "w-40 h-1 rounded-sm bg-stone-300 after:bg-orange-700 after:rounded-sm",
      chip: "font-mono tabular-nums text-[11px] tracking-tight text-stone-700",
      chipWarn: "font-mono tabular-nums text-[11px] tracking-tight font-semibold text-amber-800",
      ctl: "gap-2 text-[10px] uppercase tracking-[0.18em] text-stone-600",
      select: "bg-stone-50 text-stone-800 text-xs px-2 py-1 border border-stone-300 rounded-sm hover:border-stone-400 focus:outline-none focus:border-orange-700 transition-colors duration-200",
      checkbox: "accent-orange-700 h-3.5 w-3.5",
      button: "px-4 py-1.5 text-[10px] uppercase tracking-[0.18em] bg-stone-50 text-stone-800 border border-stone-400 rounded-sm hover:bg-orange-700 hover:text-stone-50 hover:border-orange-800 active:bg-orange-900 transition-colors duration-200",
      errorBar: "px-8 py-2.5 bg-orange-100 text-orange-900 border-y border-orange-300 text-sm font-semibold",
      main: "flex-row-reverse",
      sidebar: "w-80 bg-stone-50 border-l border-stone-300 pb-6",
      sidebarCount: "sticky top-0 z-10 bg-stone-50 px-6 py-4 text-[10px] uppercase tracking-[0.18em] text-stone-600 border-b border-stone-300",
      sidebarFilter: "bg-stone-50 text-stone-800 text-sm px-6 py-3 border-b border-stone-200 rounded-none placeholder:italic placeholder:text-stone-500 focus:border-orange-700 transition-colors duration-200",
      bankSummary: "px-6 py-3.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-stone-700 border-b border-stone-300 marker:text-stone-400 hover:text-orange-800 transition-colors duration-200",
      catSummary: "pl-9 pr-6 py-2.5 text-sm text-stone-700 border-b border-stone-200 marker:text-stone-400 hover:text-orange-800 transition-colors duration-200",
      patchRow: "pl-12 pr-6 py-2 text-sm text-stone-600 underline-offset-4 decoration-orange-700/50 hover:text-stone-900 hover:underline transition-colors duration-200 [&.selected]:text-orange-800 [&.selected]:font-semibold [&.selected]:underline [&.selected]:decoration-2 [&.selected]:decoration-orange-700",
      stage: "p-14 bg-stone-100 bg-[repeating-linear-gradient(45deg,rgba(120,113,108,0.045)_0_2px,transparent_0_18px)]",
      decor: "bg-[repeating-linear-gradient(45deg,rgba(120,113,108,0.05)_0_1px,transparent_0_12px)] opacity-70 mix-blend-multiply",
      canvasWrap: "p-7 bg-stone-50 border border-stone-300 rounded-sm shadow-[0_20px_45px_-20px_rgba(120,113,108,0.6)]",
      canvas: "",
      footer: "mt-10 text-sm leading-relaxed text-stone-600 [&_a]:text-orange-800 [&_a]:underline [&_a]:underline-offset-2 [&_a]:decoration-orange-700/50 [&_a:hover]:text-orange-900 [&_kbd]:font-mono [&_kbd]:text-[10px] [&_kbd]:uppercase [&_kbd]:tracking-[0.12em] [&_kbd]:px-1.5 [&_kbd]:py-0.5 [&_kbd]:bg-stone-50 [&_kbd]:text-stone-700 [&_kbd]:border [&_kbd]:border-stone-300 [&_kbd]:rounded-sm",
      piano: "h-24 bg-stone-200 border-t border-stone-300 rounded-none shadow-[inset_0_2px_6px_-2px_rgba(120,113,108,0.45)]",
      keyWhite: "bg-stone-50 border-r border-stone-300 rounded-b-sm hover:bg-orange-50 after:text-[9px] after:font-mono after:text-stone-600 transition-colors duration-150 [&.held]:bg-orange-300",
      keyBlack: "bg-stone-800 border border-stone-900 rounded-b-sm hover:bg-stone-700 transition-colors duration-150 [&.held]:bg-orange-700",
      overlay: "bg-stone-300/80",
      overlayBox: "bg-stone-50 border border-stone-300 rounded-sm p-12 text-stone-800 shadow-[0_30px_60px_-25px_rgba(120,113,108,0.7)] [&_h2]:text-2xl [&_h2]:font-normal [&_h2]:uppercase [&_h2]:tracking-[0.2em] [&_h2]:text-stone-900 [&_h2]:mt-0 [&_h2]:mb-4 [&_p]:text-sm [&_p]:leading-relaxed [&_p]:text-stone-600",
      startBtn: "mt-8 px-10 py-3 text-[11px] font-semibold uppercase tracking-[0.24em] bg-orange-700 text-stone-50 border border-orange-800 rounded-sm hover:bg-orange-800 active:bg-orange-900 transition-colors duration-200",
    },
  },

  /* Blueprint */
  blueprint: {
    label: "Blueprint",
    classes: {
      html: "font-mono scheme-dark",
      body: "bg-blue-950 text-cyan-100 bg-[image:linear-gradient(to_right,rgba(103,232,249,0.055)_1px,transparent_1px),linear-gradient(to_bottom,rgba(103,232,249,0.055)_1px,transparent_1px),linear-gradient(to_right,rgba(165,243,252,0.11)_1px,transparent_1px),linear-gradient(to_bottom,rgba(165,243,252,0.11)_1px,transparent_1px)] bg-size-[20px_20px,20px_20px,100px_100px,100px_100px]",
      toolbar: "h-12 px-4 rounded-none border-b border-cyan-400/30 bg-blue-950/85 backdrop-blur-[2px]",
      brand: "text-sm font-semibold uppercase tracking-[0.3em] text-cyan-200",
      status: "font-mono text-[11px] uppercase tracking-[0.18em] text-cyan-300/75",
      progress: "w-40 h-1.5 rounded-none border border-cyan-400/40 bg-transparent after:bg-cyan-300",
      chip: "font-mono text-[11px] tabular-nums uppercase tracking-[0.16em] text-sky-300/85",
      chipWarn: "font-mono text-[11px] tabular-nums uppercase tracking-[0.16em] text-orange-300 border border-orange-400/50 rounded-none px-1.5 py-0.5",
      ctl: "text-[10px] uppercase tracking-[0.22em] text-cyan-400/75",
      select: "px-2 py-1 rounded-none border border-cyan-400/40 bg-blue-950 text-cyan-100 font-mono text-[11px] uppercase tracking-[0.12em] hover:border-cyan-300/70 focus:outline-none focus:border-cyan-200 transition-colors",
      checkbox: "h-3.5 w-3.5 accent-cyan-400",
      button: "px-3 py-1 rounded-none border border-cyan-400/50 bg-transparent text-cyan-200 font-mono text-[10px] uppercase tracking-[0.22em] hover:bg-cyan-400/10 hover:border-cyan-300 hover:text-cyan-100 active:bg-cyan-400/20 transition-colors",
      errorBar: "px-4 py-1.5 border-y border-red-400/55 bg-red-950/70 text-red-200 font-mono text-[11px] font-medium uppercase tracking-[0.18em]",
      main: "gap-0",
      sidebar: "w-72 rounded-none border-r border-cyan-400/30 bg-blue-950/35",
      sidebarCount: "sticky top-0 z-10 px-3 py-2 border-b border-cyan-400/30 bg-blue-950/95 backdrop-blur-[2px] text-[10px] uppercase tracking-[0.24em] text-cyan-300/85",
      sidebarFilter: "px-3 py-2 rounded-none border-b border-cyan-400/25 bg-transparent text-cyan-100 font-mono text-[11px] uppercase tracking-[0.12em] placeholder:text-cyan-500/60 placeholder:tracking-[0.2em] focus:bg-cyan-400/5 focus:border-cyan-300/60 transition-colors",
      bankSummary: "px-3 py-2 border-b border-cyan-400/20 bg-cyan-400/5 text-cyan-200 text-[11px] font-semibold uppercase tracking-[0.22em] marker:text-cyan-400 hover:bg-cyan-400/10 hover:text-cyan-100 transition-colors",
      catSummary: "pl-6 pr-3 py-1.5 text-[11px] uppercase tracking-[0.14em] text-sky-300/85 marker:text-cyan-500 hover:bg-cyan-400/5 hover:text-cyan-200 transition-colors",
      patchRow: "pl-10 pr-3 py-1 text-[11px] text-cyan-100/75 border-l-2 border-transparent hover:text-cyan-50 hover:border-cyan-400/40 hover:bg-cyan-400/5 transition-colors [&.selected]:border-cyan-300 [&.selected]:bg-cyan-400/10 [&.selected]:text-cyan-100 [&.selected]:font-semibold [&.selected]:tracking-[0.08em]",
      stage: "p-8 bg-blue-950 bg-[image:repeating-linear-gradient(45deg,rgba(34,211,238,0.11)_0px,rgba(34,211,238,0.11)_1px,transparent_1px,transparent_8px)] bg-size-[100%_7rem] bg-no-repeat bg-position-[0_100%]",
      decor: "opacity-90 bg-[image:linear-gradient(to_right,rgba(103,232,249,0.07)_1px,transparent_1px),linear-gradient(to_bottom,rgba(103,232,249,0.07)_1px,transparent_1px),linear-gradient(to_right,rgba(165,243,252,0.15)_1px,transparent_1px),linear-gradient(to_bottom,rgba(165,243,252,0.15)_1px,transparent_1px)] bg-size-[20px_20px,20px_20px,100px_100px,100px_100px]",
      canvasWrap: "p-3 rounded-none border border-cyan-300/50 bg-blue-950 ring-1 ring-cyan-400/30 ring-offset-2 ring-offset-blue-950 bg-[image:repeating-linear-gradient(45deg,rgba(34,211,238,0.16)_0px,rgba(34,211,238,0.16)_1px,transparent_1px,transparent_7px)]",
      canvas: "",
      footer: "mt-6 text-[11px] leading-relaxed text-cyan-200/80 [&_a]:text-cyan-300 [&_a]:underline [&_a]:underline-offset-2 [&_a]:decoration-cyan-400/50 [&_a:hover]:text-cyan-100 [&_kbd]:font-mono [&_kbd]:text-[10px] [&_kbd]:uppercase [&_kbd]:tracking-[0.1em] [&_kbd]:px-1.5 [&_kbd]:py-0.5 [&_kbd]:rounded-none [&_kbd]:border [&_kbd]:border-cyan-400/50 [&_kbd]:bg-blue-950 [&_kbd]:text-cyan-200",
      piano: "h-24 rounded-none border-t border-cyan-400/40 bg-blue-950 shadow-[0_-1px_0_0_rgba(34,211,238,0.25)]",
      keyWhite: "rounded-none border border-cyan-300/40 bg-sky-200/15 hover:bg-sky-200/25 after:font-mono after:text-[9px] after:tracking-[0.1em] after:text-cyan-200/70 [&.held]:bg-cyan-300 [&.held]:border-cyan-100 transition-colors",
      keyBlack: "rounded-none border border-cyan-300/50 bg-blue-950 hover:bg-cyan-400/15 [&.held]:bg-cyan-300 [&.held]:border-cyan-100 transition-colors",
      overlay: "bg-blue-950/95 backdrop-blur-[2px] bg-[image:linear-gradient(to_right,rgba(103,232,249,0.07)_1px,transparent_1px),linear-gradient(to_bottom,rgba(103,232,249,0.07)_1px,transparent_1px),linear-gradient(to_right,rgba(165,243,252,0.15)_1px,transparent_1px),linear-gradient(to_bottom,rgba(165,243,252,0.15)_1px,transparent_1px)] bg-size-[20px_20px,20px_20px,100px_100px,100px_100px]",
      overlayBox: "px-10 py-8 rounded-none border border-cyan-400/45 bg-blue-950 text-cyan-100 shadow-[0_0_0_1px_rgba(8,47,73,1),0_0_60px_rgba(34,211,238,0.10)] [&_h2]:mb-3 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:uppercase [&_h2]:tracking-[0.3em] [&_h2]:text-cyan-200 [&_p]:text-[11px] [&_p]:uppercase [&_p]:tracking-[0.14em] [&_p]:leading-relaxed [&_p]:text-cyan-300/80",
      startBtn: "mt-6 px-8 py-3 rounded-none border border-cyan-300/60 bg-transparent text-cyan-200 text-[11px] font-semibold uppercase tracking-[0.3em] hover:bg-cyan-400/15 hover:border-cyan-200 hover:text-cyan-50 active:bg-cyan-400/25 transition-colors",
    },
  },

  /* Swiss */
  swiss: {
    label: "Swiss",
    classes: {
      html: "font-sans scheme-light",
      body: "bg-white text-neutral-900",
      toolbar: "h-20 px-6 gap-4 bg-white border-b border-neutral-200 rounded-none m-0 shadow-none",
      brand: "text-2xl font-bold tracking-tight text-neutral-900",
      status: "text-xs font-normal text-neutral-600 tabular-nums",
      progress: "w-40 h-0.5 rounded-none bg-neutral-200 after:bg-red-600 after:rounded-none",
      chip: "text-[10px] uppercase tracking-[0.16em] tabular-nums text-neutral-600",
      chipWarn: "text-[10px] font-bold uppercase tracking-[0.16em] tabular-nums text-red-600",
      ctl: "gap-2 text-[10px] font-medium uppercase tracking-[0.2em] text-neutral-600",
      select: "bg-white text-neutral-900 text-xs px-2.5 py-1.5 border border-neutral-300 rounded-none shadow-none hover:border-neutral-900 focus:outline-none focus:border-red-600 transition-colors",
      checkbox: "accent-red-600 h-3.5 w-3.5",
      button: "px-5 py-2 text-[10px] font-bold uppercase tracking-[0.2em] bg-white text-neutral-900 border border-neutral-900 rounded-none shadow-none hover:bg-red-600 hover:text-white hover:border-red-600 active:bg-neutral-900 active:text-white active:border-neutral-900 transition-colors",
      errorBar: "px-10 py-3 bg-red-600 text-white rounded-none text-xs font-bold uppercase tracking-[0.16em]",
      main: "",
      sidebar: "w-80 pb-12 bg-white border-r border-neutral-200 rounded-none shadow-none",
      sidebarCount: "sticky top-0 z-10 bg-white px-6 pt-6 pb-3 text-[10px] font-bold uppercase tracking-[0.2em] text-neutral-600 border-b border-neutral-200",
      sidebarFilter: "bg-white text-neutral-900 text-sm px-6 py-3 border-b border-neutral-200 rounded-none shadow-none placeholder:text-neutral-500 placeholder:uppercase placeholder:tracking-[0.14em] placeholder:text-[10px] focus:border-red-600 transition-colors",
      bankSummary: "px-6 py-4 text-[10px] font-bold uppercase tracking-[0.2em] text-neutral-900 border-b border-neutral-200 marker:text-neutral-400 hover:text-red-600 transition-colors",
      catSummary: "pl-10 pr-6 py-2.5 text-xs uppercase tracking-[0.12em] text-neutral-700 marker:text-neutral-400 hover:text-neutral-900 transition-colors",
      patchRow: "pl-14 pr-6 py-1.5 text-[13px] leading-5 text-neutral-700 rounded-none hover:bg-neutral-100 hover:text-neutral-900 transition-colors [&.selected]:bg-red-600 [&.selected]:text-white [&.selected]:font-semibold [&.selected]:hover:bg-red-600 [&.selected]:hover:text-white",
      stage: "p-16 bg-white",
      decor: "",
      canvasWrap: "border border-neutral-200 rounded-none shadow-none",
      canvas: "",
      footer: "mt-12 text-xs leading-relaxed text-neutral-600 [&_a]:text-red-600 [&_a]:underline [&_a]:underline-offset-2 [&_a:hover]:text-neutral-900 [&_kbd]:font-sans [&_kbd]:text-[10px] [&_kbd]:uppercase [&_kbd]:tracking-[0.12em] [&_kbd]:px-1.5 [&_kbd]:py-0.5 [&_kbd]:bg-white [&_kbd]:text-neutral-700 [&_kbd]:border [&_kbd]:border-neutral-300 [&_kbd]:rounded-none",
      piano: "h-28 bg-white border-t border-neutral-200 rounded-none shadow-none",
      keyWhite: "bg-white border-r border-neutral-300 rounded-none shadow-none hover:bg-neutral-100 after:text-[9px] after:tracking-[0.08em] after:text-neutral-400 transition-colors [&.held]:bg-red-600",
      keyBlack: "bg-neutral-900 border border-neutral-900 rounded-none shadow-none hover:bg-neutral-700 transition-colors [&.held]:bg-red-600",
      overlay: "bg-white/85",
      overlayBox: "bg-white border border-neutral-900 rounded-none shadow-none p-14 text-neutral-900 [&_h2]:text-3xl [&_h2]:font-bold [&_h2]:tracking-tight [&_h2]:text-neutral-900 [&_h2]:mt-0 [&_h2]:mb-4 [&_p]:text-sm [&_p]:leading-relaxed [&_p]:text-neutral-600",
      startBtn: "mt-10 px-12 py-4 text-[11px] font-bold uppercase tracking-[0.24em] bg-red-600 text-white border border-red-600 rounded-none shadow-none hover:bg-neutral-900 hover:border-neutral-900 active:bg-neutral-800 active:border-neutral-800 transition-colors",
    },
  },

  /* High Contrast */
  contrast: {
    label: "High Contrast",
    classes: {
      html: "font-sans scheme-dark",
      body: "bg-black text-white text-base leading-relaxed",
      toolbar: "min-h-16 h-auto flex-wrap px-3 py-2 gap-2 m-0 bg-black rounded-none border-0 border-b-4 border-solid border-white",
      brand: "text-2xl font-extrabold tracking-tight text-yellow-300",
      status: "text-base font-semibold text-white",
      progress: "w-44 h-4 rounded-none bg-black border-2 border-white after:bg-yellow-300",
      chip: "text-sm font-bold text-white tabular-nums",
      chipWarn: "text-sm font-bold text-yellow-300 tabular-nums",
      ctl: "text-base font-semibold text-white",
      select: "bg-black text-white text-base font-semibold px-3 py-1.5 rounded-none border-2 border-white hover:bg-white hover:text-black transition-colors focus:outline-none focus-visible:ring-4 focus-visible:ring-yellow-300 focus-visible:ring-offset-2 focus-visible:ring-offset-black",
      checkbox: "size-5 accent-yellow-300 rounded-none focus:outline-none focus-visible:ring-4 focus-visible:ring-yellow-300 focus-visible:ring-offset-2 focus-visible:ring-offset-black",
      button: "bg-black text-yellow-300 text-base font-bold px-5 py-2 rounded-none border-2 border-yellow-300 hover:bg-yellow-300 hover:text-black active:bg-yellow-400 active:text-black transition-colors focus:outline-none focus-visible:ring-4 focus-visible:ring-yellow-300 focus-visible:ring-offset-2 focus-visible:ring-offset-black",
      errorBar: "bg-red-500 text-black text-base font-bold px-4 py-3 rounded-none border-y-4 border-white",
      main: "bg-black",
      sidebar: "w-96 bg-black rounded-none border-0 border-r-4 border-solid border-white",
      sidebarCount: "sticky top-0 z-10 bg-black px-4 py-3 text-base font-extrabold uppercase tracking-wide text-yellow-300 border-0 border-b-4 border-solid border-white",
      sidebarFilter: "bg-black text-white text-base font-semibold px-3 py-2.5 rounded-none border-2 border-white placeholder:text-white placeholder:italic placeholder:font-normal focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-yellow-300",
      bankSummary: "px-4 py-3 text-lg font-extrabold uppercase tracking-wide text-yellow-300 bg-black hover:bg-yellow-300 hover:text-black transition-colors marker:text-yellow-300",
      catSummary: "pl-8 pr-4 py-2.5 text-base font-semibold text-white hover:bg-white hover:text-black transition-colors marker:text-yellow-300",
      patchRow: "pl-12 pr-4 py-2.5 text-base font-medium text-white rounded-none hover:bg-white hover:text-black transition-colors focus:outline-none focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-yellow-300 [&.selected]:bg-yellow-300 [&.selected]:text-black [&.selected]:font-bold",
      stage: "p-8 bg-black",
      decor: "bg-[repeating-linear-gradient(45deg,#ffdf20_0px,#ffdf20_12px,#000000_12px,#000000_24px)] bg-no-repeat bg-[size:22rem_2.5rem] bg-[position:100%_0]",
      canvasWrap: "p-2 bg-black rounded-none border-4 border-white",
      canvas: "",
      footer: "mt-8 text-base leading-relaxed text-white [&_a]:text-yellow-300 [&_a]:underline [&_a]:underline-offset-2 [&_a]:font-semibold [&_kbd]:inline-block [&_kbd]:rounded-none [&_kbd]:border-2 [&_kbd]:border-white [&_kbd]:bg-black [&_kbd]:px-1.5 [&_kbd]:py-0.5 [&_kbd]:text-sm [&_kbd]:font-bold [&_kbd]:text-yellow-300",
      piano: "h-32 bg-black rounded-none border-0 border-t-4 border-solid border-white",
      keyWhite: "bg-white rounded-none border-2 border-black hover:bg-yellow-400 transition-colors after:text-black after:text-xs after:font-bold [&.held]:bg-yellow-300",
      keyBlack: "bg-black rounded-none border-2 border-white hover:bg-yellow-400 transition-colors [&.held]:bg-yellow-300",
      overlay: "bg-black",
      overlayBox: "bg-black text-white p-10 rounded-none border-4 border-white [&_h2]:mb-4 [&_h2]:text-3xl [&_h2]:font-extrabold [&_h2]:tracking-tight [&_h2]:text-yellow-300 [&_p]:mb-2 [&_p]:text-base [&_p]:font-medium [&_p]:leading-relaxed [&_p]:text-white",
      startBtn: "mt-8 bg-yellow-300 text-black text-xl font-extrabold px-10 py-4 rounded-none border-4 border-white hover:bg-yellow-400 active:bg-white transition-colors focus:outline-none focus-visible:ring-4 focus-visible:ring-yellow-300 focus-visible:ring-offset-4 focus-visible:ring-offset-black",
    },
  },

  /* Rack Hardware */
  hardware: {
    label: "Rack Hardware",
    classes: {
      html: "font-sans scheme-dark",
      body: "text-zinc-300 bg-zinc-950 bg-[radial-gradient(ellipse_at_50%_-10%,rgba(251,191,36,0.06),transparent_60%),repeating-linear-gradient(90deg,rgba(255,255,255,0.022)_0_1px,transparent_1px_4px),linear-gradient(to_bottom,var(--color-zinc-900),var(--color-zinc-950))]",
      toolbar: "h-14 shrink-0 px-4 mx-2 mt-2 rounded-md border border-zinc-950 bg-zinc-800 bg-[repeating-linear-gradient(90deg,rgba(255,255,255,0.04)_0_1px,transparent_1px_3px),linear-gradient(to_bottom,var(--color-zinc-700),var(--color-zinc-800)_55%,var(--color-zinc-900))] shadow-[inset_0_1px_0_rgba(255,255,255,0.14),inset_0_-1px_0_rgba(0,0,0,0.75),0_3px_8px_rgba(0,0,0,0.55)]",
      brand: "text-sm font-semibold uppercase tracking-[0.3em] text-zinc-200 shrink-0 [text-shadow:0_1px_0_rgba(0,0,0,0.9),0_-1px_0_rgba(255,255,255,0.10)]",
      status: "text-xs font-mono tracking-wide text-amber-300 [text-shadow:0_0_8px_rgba(251,191,36,0.35)]",
      progress: "w-40 h-2.5 rounded-sm border border-zinc-950 bg-zinc-950 shadow-[inset_0_2px_4px_rgba(0,0,0,0.95),inset_0_-1px_0_rgba(255,255,255,0.05)] after:rounded-[1px] after:bg-amber-400 after:shadow-[0_0_10px_rgba(251,191,36,0.75),inset_0_1px_0_rgba(255,255,255,0.45)]",
      chip: "px-1.5 py-0.5 rounded-sm text-[11px] font-mono tabular-nums text-amber-300 border border-zinc-950 bg-zinc-950/70 shadow-[inset_0_1px_3px_rgba(0,0,0,0.9)]",
      chipWarn: "px-1.5 py-0.5 rounded-sm text-[11px] font-mono tabular-nums font-semibold text-red-300 border border-red-950 bg-red-950/60 shadow-[inset_0_1px_3px_rgba(0,0,0,0.9),0_0_8px_rgba(248,113,113,0.25)]",
      ctl: "text-[10px] font-medium uppercase tracking-[0.15em] text-zinc-300 [text-shadow:0_1px_0_rgba(0,0,0,0.8)]",
      select: "h-7 px-2 rounded border border-zinc-950 bg-gradient-to-b from-zinc-600 to-zinc-800 text-xs text-zinc-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.18),inset_0_-1px_0_rgba(0,0,0,0.6),0_1px_2px_rgba(0,0,0,0.55)] transition-colors duration-75 hover:from-zinc-500 hover:to-zinc-700 focus:outline-none focus:ring-1 focus:ring-amber-500/70",
      checkbox: "h-4 w-4 accent-amber-500",
      button: "h-7 px-3 rounded border border-red-950 bg-gradient-to-b from-red-600 to-red-800 text-[11px] font-semibold uppercase tracking-[0.15em] text-red-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.28),inset_0_-2px_0_rgba(0,0,0,0.5),0_2px_5px_rgba(0,0,0,0.6),0_0_12px_rgba(220,38,38,0.30)] transition-all duration-75 hover:from-red-500 hover:to-red-700 active:translate-y-px active:from-red-700 active:to-red-900 active:shadow-[inset_0_3px_5px_rgba(0,0,0,0.75),inset_0_-1px_0_rgba(255,255,255,0.08)]",
      errorBar: "px-4 py-2 text-xs font-mono font-semibold uppercase tracking-[0.12em] text-red-100 bg-gradient-to-b from-red-800 to-red-950 border-y border-red-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.12),inset_0_-1px_0_rgba(0,0,0,0.7)]",
      main: "gap-2 p-2",
      sidebar: "w-80 rounded-md border border-zinc-950 bg-zinc-950 bg-[repeating-linear-gradient(90deg,rgba(255,255,255,0.018)_0_1px,transparent_1px_4px)] shadow-[inset_0_3px_8px_rgba(0,0,0,0.95),inset_0_-1px_0_rgba(255,255,255,0.05)]",
      sidebarCount: "sticky top-0 z-10 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-200 border-b border-zinc-950 bg-zinc-800 bg-[repeating-linear-gradient(90deg,rgba(255,255,255,0.04)_0_1px,transparent_1px_3px),linear-gradient(to_bottom,var(--color-zinc-700),var(--color-zinc-900))] shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_3px_6px_rgba(0,0,0,0.6)]",
      sidebarFilter: "mx-3 my-2 w-[calc(100%_-_1.5rem)] px-2 py-1.5 rounded border border-zinc-950 bg-zinc-950 text-xs font-mono text-zinc-100 shadow-[inset_0_2px_5px_rgba(0,0,0,0.95)] placeholder:text-zinc-500 placeholder:uppercase placeholder:tracking-[0.12em] focus:border-amber-700 focus:shadow-[inset_0_2px_5px_rgba(0,0,0,0.95),0_0_0_1px_rgba(217,119,6,0.7),0_0_12px_rgba(251,191,36,0.28)]",
      bankSummary: "px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-200 border-y border-zinc-950 bg-gradient-to-b from-zinc-700 to-zinc-800 shadow-[inset_0_1px_0_rgba(255,255,255,0.10),inset_0_-1px_0_rgba(0,0,0,0.65)] transition-colors duration-75 hover:from-zinc-600 hover:to-zinc-700 hover:text-amber-200 marker:text-amber-500",
      catSummary: "pl-6 pr-3 py-1.5 text-xs uppercase tracking-[0.08em] text-zinc-400 transition-colors duration-75 hover:bg-zinc-800/70 hover:text-amber-200 marker:text-zinc-500",
      patchRow: "pl-9 pr-3 py-1 text-xs text-zinc-400 border-l-2 border-transparent transition-colors duration-75 hover:bg-zinc-800/70 hover:text-zinc-100 [&.selected]:border-amber-500 [&.selected]:bg-amber-500/15 [&.selected]:text-amber-200 [&.selected]:font-medium [&.selected]:shadow-[inset_0_0_18px_rgba(251,191,36,0.18),inset_0_1px_0_rgba(255,255,255,0.06)]",
      stage: "p-6 rounded-md border border-zinc-950 bg-zinc-950 bg-[radial-gradient(ellipse_at_50%_0%,rgba(251,191,36,0.05),transparent_55%),linear-gradient(to_bottom,var(--color-zinc-900),var(--color-zinc-950))] shadow-[inset_0_3px_10px_rgba(0,0,0,0.85),inset_0_-1px_0_rgba(255,255,255,0.04)]",
      decor: "opacity-70 bg-[repeating-linear-gradient(45deg,rgba(255,255,255,0.045)_0_1px,transparent_1px_7px),repeating-linear-gradient(90deg,rgba(0,0,0,0.30)_0_1px,transparent_1px_3px),radial-gradient(circle_at_50%_50%,var(--color-zinc-500)_0_36%,var(--color-zinc-800)_36%_48%,transparent_49%),radial-gradient(circle_at_50%_50%,var(--color-zinc-500)_0_36%,var(--color-zinc-800)_36%_48%,transparent_49%),radial-gradient(circle_at_50%_50%,var(--color-zinc-500)_0_36%,var(--color-zinc-800)_36%_48%,transparent_49%),radial-gradient(circle_at_50%_50%,var(--color-zinc-500)_0_36%,var(--color-zinc-800)_36%_48%,transparent_49%)] [background-repeat:repeat,repeat,no-repeat,no-repeat,no-repeat,no-repeat] [background-position:0_0,0_0,left_14px_top_14px,right_14px_top_14px,left_14px_bottom_14px,right_14px_bottom_14px] [background-size:auto,auto,14px_14px,14px_14px,14px_14px,14px_14px]",
      canvasWrap: "mx-auto p-2 rounded-md border-2 border-zinc-950 bg-zinc-900 bg-gradient-to-b from-zinc-800 to-zinc-900 shadow-[inset_0_3px_8px_rgba(0,0,0,0.95),inset_0_-1px_0_rgba(255,255,255,0.07),0_10px_28px_rgba(0,0,0,0.72)]",
      canvas: "",
      footer: "mx-auto mt-6 text-[11px] leading-relaxed text-zinc-400 [&_a]:text-amber-400 [&_a]:underline [&_a]:decoration-amber-700 [&_a]:underline-offset-2 [&_a:hover]:text-amber-300 [&_kbd]:inline-block [&_kbd]:rounded [&_kbd]:border [&_kbd]:border-zinc-950 [&_kbd]:bg-gradient-to-b [&_kbd]:from-zinc-600 [&_kbd]:to-zinc-800 [&_kbd]:px-1.5 [&_kbd]:py-0.5 [&_kbd]:font-mono [&_kbd]:text-[10px] [&_kbd]:text-zinc-100 [&_kbd]:shadow-[inset_0_1px_0_rgba(255,255,255,0.22),inset_0_-1px_0_rgba(0,0,0,0.7),0_1px_2px_rgba(0,0,0,0.6)]",
      piano: "h-28 rounded-b-md border-t-2 border-zinc-950 bg-zinc-900 bg-[repeating-linear-gradient(90deg,rgba(255,255,255,0.03)_0_1px,transparent_1px_3px),linear-gradient(to_bottom,var(--color-zinc-700),var(--color-zinc-800)_40%,var(--color-zinc-900))] shadow-[inset_0_2px_0_rgba(255,255,255,0.09),inset_0_-3px_10px_rgba(0,0,0,0.85),0_-4px_14px_rgba(0,0,0,0.55)]",
      keyWhite: "border border-zinc-900 rounded-b bg-gradient-to-b from-stone-100 via-stone-200 to-stone-400 shadow-[inset_0_1px_0_rgba(255,255,255,0.95),inset_-2px_0_3px_rgba(0,0,0,0.18),inset_0_-7px_9px_rgba(0,0,0,0.22)] transition-colors duration-75 hover:from-amber-50 hover:via-stone-200 hover:to-stone-400 after:text-[9px] after:font-mono after:tracking-tight after:text-zinc-500 [&.held]:from-amber-200 [&.held]:via-amber-300 [&.held]:to-amber-500 [&.held]:shadow-[inset_0_1px_0_rgba(255,255,255,0.8),inset_0_-7px_9px_rgba(180,83,9,0.35),0_0_18px_rgba(251,191,36,0.75)] [&.held]:after:text-amber-900",
      keyBlack: "border border-black rounded-b bg-gradient-to-b from-zinc-700 via-zinc-900 to-black shadow-[inset_0_1px_0_rgba(255,255,255,0.20),inset_0_-4px_5px_rgba(0,0,0,0.85),1px_3px_5px_rgba(0,0,0,0.7)] transition-colors duration-75 hover:from-zinc-600 hover:via-zinc-800 hover:to-zinc-950 [&.held]:from-amber-400 [&.held]:via-amber-600 [&.held]:to-amber-800 [&.held]:shadow-[inset_0_1px_0_rgba(255,255,255,0.4),0_0_18px_rgba(251,191,36,0.7)]",
      overlay: "bg-zinc-950/88 backdrop-blur-sm bg-[repeating-linear-gradient(45deg,rgba(255,255,255,0.03)_0_1px,transparent_1px_8px)]",
      overlayBox: "px-10 py-8 rounded-lg border border-zinc-950 bg-zinc-800 text-zinc-200 bg-[radial-gradient(circle_at_50%_50%,var(--color-zinc-400)_0_34%,var(--color-zinc-900)_34%_46%,transparent_47%),radial-gradient(circle_at_50%_50%,var(--color-zinc-400)_0_34%,var(--color-zinc-900)_34%_46%,transparent_47%),radial-gradient(circle_at_50%_50%,var(--color-zinc-400)_0_34%,var(--color-zinc-900)_34%_46%,transparent_47%),radial-gradient(circle_at_50%_50%,var(--color-zinc-400)_0_34%,var(--color-zinc-900)_34%_46%,transparent_47%),repeating-linear-gradient(90deg,rgba(255,255,255,0.04)_0_1px,transparent_1px_3px),linear-gradient(to_bottom,var(--color-zinc-700),var(--color-zinc-800)_50%,var(--color-zinc-900))] [background-repeat:no-repeat,no-repeat,no-repeat,no-repeat,repeat,no-repeat] [background-position:left_12px_top_12px,right_12px_top_12px,left_12px_bottom_12px,right_12px_bottom_12px,0_0,0_0] [background-size:14px_14px,14px_14px,14px_14px,14px_14px,auto,auto] shadow-[inset_0_1px_0_rgba(255,255,255,0.16),inset_0_-1px_0_rgba(0,0,0,0.85),0_20px_55px_rgba(0,0,0,0.8)] [&_h2]:m-0 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:uppercase [&_h2]:tracking-[0.25em] [&_h2]:text-amber-300 [&_h2]:[text-shadow:0_1px_0_rgba(0,0,0,0.9),0_0_14px_rgba(251,191,36,0.35)] [&_p]:mt-3 [&_p]:text-xs [&_p]:leading-relaxed [&_p]:text-zinc-300",
      startBtn: "mt-6 px-10 py-3 rounded-md border border-amber-900 bg-gradient-to-b from-amber-400 via-amber-500 to-amber-700 text-sm font-bold uppercase tracking-[0.25em] text-amber-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.55),inset_0_-2px_0_rgba(120,53,15,0.6),0_4px_10px_rgba(0,0,0,0.7),0_0_26px_rgba(251,191,36,0.45)] transition-all duration-75 hover:from-amber-300 hover:via-amber-400 hover:to-amber-600 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.6),0_4px_12px_rgba(0,0,0,0.7),0_0_36px_rgba(251,191,36,0.6)] active:translate-y-px active:shadow-[inset_0_3px_7px_rgba(120,53,15,0.7),inset_0_-1px_0_rgba(255,255,255,0.15)]",
    },
  },

  /* Pastel Dream */
  pastel: {
    label: "Pastel Dream",
    classes: {
      html: "font-sans scheme-light",
      body: "bg-slate-50 text-slate-700 bg-fixed bg-[repeating-linear-gradient(45deg,rgba(148,163,184,0.07)_0_1px,transparent_1px_13px),radial-gradient(ellipse_55%_45%_at_12%_6%,rgba(125,211,252,0.48),transparent_70%),radial-gradient(ellipse_50%_50%_at_84%_4%,rgba(196,181,253,0.52),transparent_70%),radial-gradient(ellipse_60%_55%_at_80%_92%,rgba(253,164,175,0.44),transparent_70%),radial-gradient(ellipse_52%_46%_at_14%_94%,rgba(94,234,212,0.40),transparent_70%),radial-gradient(ellipse_72%_62%_at_50%_48%,rgba(240,171,252,0.24),transparent_78%)]",
      toolbar: "h-16 px-5 mx-3 mt-3 gap-3 rounded-2xl border-0 bg-white/85 backdrop-blur-md text-slate-700 shadow-lg shadow-violet-200/60",
      brand: "text-xl font-semibold tracking-tight bg-linear-to-r from-violet-600 via-fuchsia-500 to-sky-500 bg-clip-text text-transparent",
      status: "text-sm font-medium text-slate-600",
      progress: "w-32 h-2 rounded-full overflow-hidden bg-slate-200/80 after:rounded-full after:bg-linear-to-r after:from-sky-400 after:via-violet-400 after:to-fuchsia-400",
      chip: "text-xs font-medium tabular-nums text-violet-700 bg-violet-100 rounded-full px-2.5 py-0.5",
      chipWarn: "text-xs font-semibold tabular-nums text-amber-700 bg-amber-100 rounded-full px-2.5 py-0.5",
      ctl: "gap-1.5 text-sm font-medium text-slate-600",
      select: "bg-white text-slate-700 text-sm font-medium px-3 py-1.5 rounded-full border-0 ring-1 ring-slate-200 shadow-sm shadow-sky-200/50 hover:ring-violet-300 focus:outline-none focus:ring-2 focus:ring-violet-400 transition-all duration-200",
      checkbox: "accent-violet-500 h-4 w-4",
      button: "px-4 py-1.5 rounded-full text-sm font-semibold bg-rose-100 text-rose-700 ring-1 ring-rose-200 shadow-sm shadow-rose-200/60 hover:bg-rose-200 hover:text-rose-800 active:scale-95 transition-all duration-200",
      errorBar: "mx-3 mt-2 px-5 py-3 rounded-2xl bg-rose-100 text-rose-700 ring-1 ring-rose-200 text-sm font-semibold shadow-lg shadow-rose-200/60",
      main: "p-3 gap-3",
      sidebar: "w-80 pb-8 rounded-3xl border-0 bg-white/90 backdrop-blur-sm ring-1 ring-violet-100 shadow-xl shadow-violet-200/60",
      sidebarCount: "sticky top-0 z-10 rounded-t-3xl bg-white/95 backdrop-blur-sm px-5 pt-5 pb-3 text-sm font-semibold text-slate-700",
      sidebarFilter: "w-[calc(100%-2.5rem)] mx-5 mb-3 px-4 py-2 rounded-full text-sm font-medium border-0 bg-sky-50 text-slate-700 ring-1 ring-sky-200 placeholder:font-normal placeholder:text-slate-400 focus:bg-white focus:ring-2 focus:ring-violet-300 transition-all duration-200",
      bankSummary: "mx-3 mt-2 px-4 py-2.5 rounded-2xl text-sm font-semibold text-violet-700 bg-violet-50 marker:text-violet-400 hover:bg-violet-100 transition-colors duration-200",
      catSummary: "ml-5 mr-3 pl-3 pr-3 py-1.5 rounded-full text-[13px] font-medium text-slate-600 marker:text-sky-400 hover:bg-sky-50 hover:text-slate-800 transition-colors duration-200",
      patchRow: "w-[calc(100%-2.5rem)] mx-5 pl-4 pr-3 py-1 rounded-full text-[13px] leading-6 font-medium text-slate-600 hover:bg-rose-50 hover:text-slate-800 transition-all duration-150 [&.selected]:rounded-full [&.selected]:bg-violet-200 [&.selected]:text-violet-800 [&.selected]:font-semibold [&.selected]:shadow-sm [&.selected]:shadow-violet-300/60 [&.selected]:hover:bg-violet-200 [&.selected]:hover:text-violet-800",
      stage: "p-8 rounded-3xl bg-white/60 backdrop-blur-sm ring-1 ring-white/70 shadow-xl shadow-sky-200/50",
      decor: "rounded-3xl opacity-70 mix-blend-multiply bg-[repeating-linear-gradient(45deg,rgba(148,163,184,0.10)_0_1px,transparent_1px_11px),radial-gradient(ellipse_45%_40%_at_78%_14%,rgba(125,211,252,0.42),transparent_72%),radial-gradient(ellipse_40%_44%_at_16%_24%,rgba(196,181,253,0.44),transparent_72%),radial-gradient(ellipse_48%_42%_at_30%_86%,rgba(253,164,175,0.38),transparent_72%),radial-gradient(ellipse_44%_40%_at_88%_74%,rgba(94,234,212,0.34),transparent_72%)]",
      canvasWrap: "rounded-3xl overflow-hidden p-4 bg-linear-to-br from-violet-100 via-sky-100 to-rose-100 ring-1 ring-violet-200 shadow-2xl shadow-violet-300/60",
      canvas: "rounded-2xl",
      footer: "mt-8 text-sm leading-relaxed text-slate-600 [&_a]:font-medium [&_a]:text-violet-700 [&_a]:underline [&_a]:decoration-violet-300 [&_a]:underline-offset-2 [&_a:hover]:text-fuchsia-700 [&_kbd]:font-sans [&_kbd]:text-xs [&_kbd]:font-semibold [&_kbd]:px-1.5 [&_kbd]:py-0.5 [&_kbd]:rounded-lg [&_kbd]:bg-white [&_kbd]:text-slate-700 [&_kbd]:ring-1 [&_kbd]:ring-slate-200 [&_kbd]:shadow-sm [&_kbd]:shadow-violet-200/60",
      piano: "h-24 mx-3 mb-3 rounded-3xl bg-linear-to-b from-white to-slate-50 ring-1 ring-violet-100 shadow-xl shadow-violet-200/60",
      keyWhite: "bg-white border-r border-slate-200 rounded-b-xl hover:bg-sky-50 after:text-[10px] after:font-medium after:text-slate-400 transition-colors duration-100 [&.held]:bg-violet-300 [&.held]:border-violet-300",
      keyBlack: "bg-slate-500 border border-slate-400 rounded-b-lg hover:bg-slate-400 transition-colors duration-100 [&.held]:bg-rose-400 [&.held]:border-rose-400",
      overlay: "bg-white/60 backdrop-blur-xl bg-[radial-gradient(ellipse_60%_55%_at_22%_18%,rgba(196,181,253,0.45),transparent_70%),radial-gradient(ellipse_55%_50%_at_80%_82%,rgba(125,211,252,0.42),transparent_70%),radial-gradient(ellipse_50%_45%_at_86%_16%,rgba(253,164,175,0.36),transparent_70%)]",
      overlayBox: "bg-white/95 rounded-3xl p-12 ring-1 ring-violet-100 shadow-2xl shadow-violet-300/60 text-slate-700 [&_h2]:text-3xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-slate-800 [&_h2]:mt-0 [&_h2]:mb-3 [&_p]:text-sm [&_p]:leading-relaxed [&_p]:text-slate-600",
      startBtn: "mt-8 px-10 py-3.5 rounded-full text-base font-semibold text-white bg-linear-to-r from-violet-600 via-fuchsia-600 to-rose-500 shadow-xl shadow-violet-300/70 hover:scale-105 hover:shadow-2xl hover:shadow-fuchsia-300/70 active:scale-95 transition-all duration-200",
    },
  },

  /* Linear */
  linear: {
    label: "Linear",
    classes: {
      html: "font-sans scheme-dark",
      body: "bg-[#08090a] text-[#e6e6e6]",
      toolbar: "h-14 px-5 gap-4 bg-[#0d0e10] border-b border-white/[0.06] rounded-none shadow-none",
      brand: "text-[15px] font-semibold tracking-tight text-[#e6e6e6]",
      status: "text-[13px] text-[#8a8f98]",
      progress: "w-32 h-1 rounded-full bg-white/10 after:bg-[#5e6ad2] after:rounded-full",
      chip: "text-[11px] tabular-nums text-[#8a8f98]",
      chipWarn: "text-[11px] tabular-nums text-amber-400/90",
      ctl: "gap-2 text-[13px] text-[#8a8f98]",
      select: "bg-[#141516] text-[#e6e6e6] text-[13px] px-2.5 py-1.5 rounded-md border border-white/10 shadow-none hover:border-white/20 hover:bg-[#1a1b1d] focus:outline-none focus:border-[#5e6ad2] focus:ring-2 focus:ring-[#5e6ad2]/40 transition-colors",
      checkbox: "size-4 accent-[#5e6ad2]",
      button: "px-3 py-1.5 text-[13px] font-medium rounded-md bg-white/[0.04] text-[#e6e6e6] border border-white/10 shadow-none hover:bg-rose-500/10 hover:text-rose-200 hover:border-rose-500/30 active:bg-rose-500/20 focus:outline-none focus:ring-2 focus:ring-rose-500/30 transition-colors",
      errorBar: "px-5 py-2.5 text-[13px] rounded-none bg-rose-500/10 text-rose-200 border-b border-rose-500/25",
      main: "",
      sidebar: "w-72 pb-10 bg-[#0d0e10] border-r border-white/[0.06] rounded-none shadow-none",
      sidebarCount: "sticky top-0 z-10 bg-[#0d0e10] px-4 pt-4 pb-2.5 text-[11px] font-medium tracking-tight tabular-nums text-[#8a8f98]",
      sidebarFilter: "bg-[#0d0e10] text-[#e6e6e6] text-[13px] px-4 py-2.5 rounded-none shadow-none border-b border-white/[0.06] placeholder:text-[#6b7079] focus:bg-[#141516] focus:border-[#5e6ad2] transition-colors",
      bankSummary: "px-4 py-2.5 text-[13px] font-medium tracking-tight text-[#e6e6e6] marker:text-[#5a5f68] hover:bg-white/[0.03] transition-colors",
      catSummary: "pl-7 pr-4 py-1.5 text-[13px] text-[#8a8f98] marker:text-[#4c515a] hover:text-[#e6e6e6] hover:bg-white/[0.02] transition-colors",
      patchRow: "pl-11 pr-4 py-1 text-[13px] leading-6 rounded-none text-zinc-400 hover:bg-white/[0.05] hover:text-[#e6e6e6] transition-colors [&.selected]:bg-[#5e6ad2] [&.selected]:text-white [&.selected]:font-medium [&.selected]:hover:bg-[#5e6ad2] [&.selected]:hover:text-white",
      stage: "p-10",
      decor: "bg-[radial-gradient(ellipse_70%_45%_at_50%_-8%,rgba(94,106,210,0.12),transparent_70%)]",
      canvasWrap: "rounded-lg overflow-hidden ring-1 ring-white/10 shadow-none",
      canvas: "",
      footer: "mt-10 text-[13px] leading-relaxed text-[#8a8f98] [&_a]:text-[#8f97e8] [&_a]:no-underline [&_a]:underline-offset-2 [&_a:hover]:text-[#a7aef0] [&_a:hover]:underline [&_kbd]:font-sans [&_kbd]:text-[11px] [&_kbd]:tabular-nums [&_kbd]:px-1.5 [&_kbd]:py-0.5 [&_kbd]:rounded-md [&_kbd]:bg-white/[0.06] [&_kbd]:text-[#e6e6e6] [&_kbd]:border [&_kbd]:border-white/10",
      piano: "h-24 bg-[#0d0e10] border-t border-white/[0.06] rounded-none shadow-none",
      keyWhite: "bg-zinc-300 border-r border-zinc-500/50 rounded-b-md shadow-none hover:bg-zinc-200 after:text-[9px] after:text-zinc-600 transition-colors [&.held]:bg-[#5e6ad2] [&.held]:after:text-white/85",
      keyBlack: "bg-[#141516] border border-white/10 rounded-b-md shadow-none hover:bg-[#212326] transition-colors [&.held]:bg-[#5e6ad2] [&.held]:border-[#5e6ad2]",
      overlay: "bg-[#08090a]/85",
      overlayBox: "bg-[#0d0e10] border border-white/10 rounded-xl p-10 text-[#e6e6e6] shadow-lg shadow-black/50 [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-[#e6e6e6] [&_h2]:mt-0 [&_h2]:mb-3 [&_p]:text-[14px] [&_p]:leading-relaxed [&_p]:text-[#8a8f98]",
      startBtn: "mt-8 px-5 py-2.5 text-[13px] font-medium rounded-md bg-[#5e6ad2] text-white border border-[#6b76d8] shadow-none hover:bg-[#7b83e0] hover:border-[#7b83e0] active:bg-[#5560c4] focus:outline-none focus:ring-2 focus:ring-[#5e6ad2]/50 transition-colors",
    },
  },

  /* Vercel */
  vercel: {
    label: "Vercel",
    classes: {
      html: "font-sans scheme-dark antialiased",
      body: "bg-black text-white text-[13px] leading-6",
      toolbar: "h-14 px-4 gap-4 m-0 bg-black rounded-none border-0 border-b border-solid border-neutral-800",
      brand: "text-sm font-semibold tracking-tight text-white",
      status: "text-[13px] text-neutral-400",
      progress: "w-32 h-1 rounded-full bg-neutral-800 after:bg-white after:rounded-full",
      chip: "text-xs tabular-nums text-neutral-400",
      chipWarn: "text-xs tabular-nums text-amber-400",
      ctl: "gap-2 text-xs font-medium text-neutral-400",
      select: "bg-neutral-950 text-neutral-200 text-xs px-2.5 py-1.5 rounded-md border border-neutral-800 shadow-none transition-colors hover:bg-neutral-900 hover:border-neutral-700 focus:outline-none focus-visible:ring-1 focus-visible:ring-white/50 focus-visible:border-neutral-600",
      checkbox: "size-4 accent-white rounded-sm focus:outline-none focus-visible:ring-1 focus-visible:ring-white/50",
      button: "px-3 py-1.5 text-xs font-medium rounded-md transition-colors bg-neutral-950 text-red-400 border border-neutral-800 shadow-none hover:bg-red-950 hover:text-red-300 hover:border-red-900 active:bg-red-900 active:text-white focus:outline-none focus-visible:ring-1 focus-visible:ring-red-500/60",
      errorBar: "px-4 py-2.5 text-[13px] rounded-none bg-red-950 text-red-200 border-0 border-b border-solid border-red-900",
      main: "",
      sidebar: "w-72 pb-8 bg-neutral-950 rounded-none shadow-none border-0 border-r border-solid border-neutral-800",
      sidebarCount: "sticky top-0 z-10 bg-neutral-950 px-4 py-3 text-xs font-medium tabular-nums text-neutral-400 border-0 border-b border-solid border-neutral-800",
      sidebarFilter: "bg-neutral-950 text-[13px] text-white px-4 py-2.5 rounded-none shadow-none border-0 border-b border-solid border-neutral-800 placeholder:text-neutral-400 focus:bg-neutral-900 transition-colors",
      bankSummary: "px-4 py-2.5 text-[13px] font-medium text-neutral-200 rounded-none marker:text-neutral-500 transition-colors hover:bg-neutral-900 hover:text-white",
      catSummary: "pl-8 pr-4 py-2 text-[13px] text-neutral-400 rounded-none marker:text-neutral-500 transition-colors hover:bg-neutral-900 hover:text-white",
      patchRow: "pl-12 pr-4 py-1.5 text-[13px] leading-5 text-neutral-400 rounded-none transition-colors hover:bg-neutral-900 hover:text-white [&.selected]:bg-white [&.selected]:text-black [&.selected]:font-medium [&.selected]:hover:bg-white [&.selected]:hover:text-black",
      stage: "p-10 bg-black",
      decor: "",
      canvasWrap: "rounded-lg overflow-hidden ring-1 ring-neutral-800 shadow-none",
      canvas: "",
      footer: "mt-10 text-[13px] leading-6 text-neutral-400 [&_a]:text-white [&_a]:underline [&_a]:underline-offset-4 [&_a]:decoration-neutral-700 [&_a:hover]:decoration-white [&_kbd]:inline-block [&_kbd]:font-sans [&_kbd]:text-[11px] [&_kbd]:px-1.5 [&_kbd]:py-0.5 [&_kbd]:rounded-md [&_kbd]:bg-neutral-950 [&_kbd]:text-neutral-200 [&_kbd]:border [&_kbd]:border-neutral-800",
      piano: "h-24 bg-black rounded-none shadow-none border-0 border-t border-solid border-neutral-800",
      keyWhite: "bg-white rounded-none shadow-none border-0 border-r border-solid border-neutral-300 transition-colors hover:bg-neutral-200 after:text-[9px] after:text-neutral-500 [&.held]:bg-neutral-900 [&.held]:after:text-neutral-300",
      keyBlack: "bg-neutral-900 rounded-none shadow-none border border-solid border-black transition-colors hover:bg-neutral-700 [&.held]:bg-white [&.held]:border-white",
      overlay: "bg-black/85",
      overlayBox: "bg-neutral-950 text-white p-10 rounded-lg shadow-none border border-neutral-800 [&_h2]:mt-0 [&_h2]:mb-3 [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-white [&_p]:mb-2 [&_p]:text-[13px] [&_p]:leading-6 [&_p]:text-neutral-400 [&_em]:not-italic [&_em]:text-white",
      startBtn: "mt-8 px-5 py-2.5 text-[13px] font-medium rounded-md transition-colors bg-white text-black border border-white shadow-none hover:bg-neutral-200 hover:border-neutral-200 active:bg-neutral-300 active:border-neutral-300 focus:outline-none focus-visible:ring-1 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black",
    },
  },

  /* Nord */
  nord: {
    label: "Nord",
    classes: {
      html: "font-sans scheme-dark",
      body: "bg-[#2E3440] text-[#ECEFF4]",
      toolbar: "h-14 px-4 gap-4 bg-[#2E3440] border-b border-[#434C5E]",
      brand: "text-sm font-semibold tracking-tight text-[#ECEFF4]",
      status: "text-[13px] text-[#D8DEE9]",
      progress: "w-40 h-1 rounded-full bg-[#3B4252] after:bg-[#88C0D0] after:rounded-full",
      chip: "text-xs tabular-nums text-[#81A1C1]",
      chipWarn: "px-2 py-0.5 rounded-md text-xs font-medium tabular-nums bg-[#EBCB8B]/15 text-[#EBCB8B]",
      ctl: "gap-2 text-xs font-medium text-[#81A1C1]",
      select: "px-2.5 py-1.5 rounded-md text-xs text-[#ECEFF4] bg-[#3B4252] border border-[#434C5E] hover:border-[#4C566A] focus:outline-none focus:border-[#88C0D0] focus:ring-1 focus:ring-[#88C0D0] transition-colors",
      checkbox: "size-4 accent-[#88C0D0]",
      button: "px-3 py-1.5 rounded-md text-xs font-medium bg-[#BF616A] text-[#ECEFF4] hover:bg-[#BF616A]/90 active:bg-[#BF616A]/80 transition-colors",
      errorBar: "px-4 py-2 bg-[#BF616A] text-[#ECEFF4] text-[13px] font-medium",
      main: "",
      sidebar: "w-72 pb-8 bg-[#2E3440] border-r border-[#434C5E]",
      sidebarCount: "sticky top-0 z-10 px-4 pt-4 pb-2 bg-[#2E3440] border-b border-[#434C5E] text-[11px] font-medium tracking-tight text-[#81A1C1]",
      sidebarFilter: "px-4 py-2.5 bg-transparent text-[13px] text-[#ECEFF4] border-b border-[#434C5E] placeholder:text-[#81A1C1]/75 focus:border-[#88C0D0] transition-colors",
      bankSummary: "px-4 py-2.5 text-[13px] font-medium tracking-tight text-[#ECEFF4] marker:text-[#81A1C1] hover:bg-[#3B4252] transition-colors",
      catSummary: "pl-8 pr-4 py-1.5 text-[13px] text-[#D8DEE9] marker:text-[#81A1C1] hover:bg-[#3B4252] hover:text-[#ECEFF4] transition-colors",
      patchRow: "pl-12 pr-4 py-1 text-[13px] leading-6 text-[#D8DEE9] hover:bg-[#3B4252] hover:text-[#ECEFF4] transition-colors [&.selected]:bg-[#88C0D0] [&.selected]:text-[#2E3440] [&.selected]:font-medium [&.selected]:hover:bg-[#88C0D0] [&.selected]:hover:text-[#2E3440]",
      stage: "p-10 bg-[#2E3440]",
      decor: "bg-[radial-gradient(ellipse_at_top,rgba(136,192,208,0.07),transparent_65%)]",
      canvasWrap: "rounded-lg overflow-hidden ring-1 ring-[#434C5E]",
      canvas: "",
      footer: "mt-10 text-[13px] leading-relaxed text-[#81A1C1] [&_a]:text-[#88C0D0] [&_a]:underline [&_a]:underline-offset-2 [&_a:hover]:text-[#ECEFF4] [&_kbd]:font-sans [&_kbd]:text-[11px] [&_kbd]:px-1.5 [&_kbd]:py-0.5 [&_kbd]:rounded-md [&_kbd]:bg-[#3B4252] [&_kbd]:text-[#ECEFF4] [&_kbd]:border [&_kbd]:border-[#434C5E]",
      piano: "h-24 bg-[#2E3440] border-t border-[#434C5E]",
      keyWhite: "bg-[#D8DEE9] border-r border-[#4C566A]/45 rounded-b-sm hover:bg-[#ECEFF4] after:text-[#4C566A] [&.held]:bg-[#88C0D0] transition-colors",
      keyBlack: "bg-[#3B4252] border-x border-[#2E3440] rounded-b-sm hover:bg-[#434C5E] [&.held]:bg-[#88C0D0] transition-colors",
      overlay: "bg-[#2E3440]/85 backdrop-blur-sm",
      overlayBox: "p-10 rounded-lg bg-[#3B4252] ring-1 ring-[#434C5E] text-[#ECEFF4] [&_h2]:mt-0 [&_h2]:mb-3 [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-[#ECEFF4] [&_p]:text-sm [&_p]:leading-relaxed [&_p]:text-[#D8DEE9]",
      startBtn: "mt-8 px-6 py-2.5 rounded-md text-sm font-semibold tracking-tight bg-[#88C0D0] text-[#2E3440] hover:bg-[#88C0D0]/90 active:bg-[#88C0D0]/80 transition-colors",
    },
  },

  /* Monochrome */
  mono: {
    label: "Monochrome",
    classes: {
      html: "font-sans scheme-light",
      body: "bg-zinc-100 text-zinc-900 antialiased",
      toolbar: "h-14 px-5 gap-4 bg-white border-b border-zinc-200",
      brand: "text-sm font-semibold tracking-tight text-zinc-900",
      status: "text-xs text-zinc-600",
      progress: "w-32 h-1 rounded-full bg-zinc-200 after:bg-zinc-900 after:rounded-full",
      chip: "text-xs tabular-nums text-zinc-500",
      chipWarn: "px-2 py-0.5 rounded-md bg-zinc-200 text-xs font-medium tabular-nums text-zinc-900",
      ctl: "gap-2 text-xs font-medium text-zinc-600",
      select: "bg-white text-zinc-900 text-xs px-2.5 py-1.5 rounded-md border border-zinc-300 hover:border-zinc-400 focus:outline-none focus:border-zinc-500 focus:ring-2 focus:ring-zinc-900/15 transition-colors",
      checkbox: "size-4 accent-zinc-900",
      button: "px-3 py-1.5 text-xs font-medium rounded-md bg-white text-zinc-700 border border-zinc-300 hover:bg-zinc-50 hover:text-zinc-900 active:bg-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900/15 transition-colors",
      errorBar: "mx-4 mt-3 px-4 py-2.5 rounded-lg bg-red-50 text-red-800 ring-1 ring-red-200 text-xs font-medium",
      main: "",
      sidebar: "w-80 pb-8 bg-white border-r border-zinc-200",
      sidebarCount: "sticky top-0 z-10 bg-white px-4 pt-4 pb-2 text-xs font-medium tabular-nums text-zinc-500",
      sidebarFilter: "bg-white text-zinc-900 text-sm px-4 py-2.5 border-b border-zinc-200 placeholder:text-zinc-500 focus:bg-zinc-50 transition-colors",
      bankSummary: "px-4 py-2.5 text-xs font-semibold text-zinc-900 marker:text-zinc-400 hover:bg-zinc-50 transition-colors",
      catSummary: "pl-8 pr-4 py-1.5 text-xs text-zinc-600 marker:text-zinc-400 hover:bg-zinc-50 hover:text-zinc-900 transition-colors",
      patchRow: "mx-2 w-[calc(100%-1rem)] pl-10 pr-3 py-1.5 rounded-md text-[13px] leading-5 text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 [&.selected]:bg-zinc-900 [&.selected]:text-white [&.selected]:font-medium [&.selected]:hover:bg-zinc-900 [&.selected]:hover:text-white",
      stage: "p-8",
      decor: "",
      canvasWrap: "rounded-lg overflow-hidden bg-white ring-1 ring-zinc-200 shadow-sm",
      canvas: "",
      footer: "mt-8 text-xs leading-relaxed text-zinc-600 [&_a]:text-zinc-900 [&_a]:underline [&_a]:underline-offset-2 [&_a]:decoration-zinc-300 [&_a:hover]:decoration-zinc-900 [&_kbd]:font-sans [&_kbd]:text-[11px] [&_kbd]:px-1.5 [&_kbd]:py-0.5 [&_kbd]:rounded-md [&_kbd]:bg-white [&_kbd]:text-zinc-700 [&_kbd]:ring-1 [&_kbd]:ring-zinc-200",
      piano: "h-24 bg-white border-t border-zinc-200",
      keyWhite: "bg-white border-r border-zinc-200 hover:bg-zinc-100 transition-colors after:text-[9px] after:text-zinc-500 [&.held]:bg-zinc-900 [&.held]:after:text-zinc-400",
      keyBlack: "bg-zinc-800 border-x border-zinc-800 hover:bg-zinc-600 transition-colors [&.held]:bg-zinc-300",
      overlay: "bg-zinc-900/40",
      overlayBox: "bg-white rounded-lg ring-1 ring-zinc-200 shadow-sm p-8 text-zinc-600 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-zinc-900 [&_h2]:mt-0 [&_h2]:mb-3 [&_p]:text-sm [&_p]:leading-relaxed [&_p]:text-zinc-600",
      startBtn: "mt-6 px-5 py-2.5 text-sm font-medium rounded-md bg-zinc-900 text-white hover:bg-zinc-800 active:bg-zinc-700 focus:outline-none focus:ring-2 focus:ring-zinc-900/20 transition-colors",
    },
  },

  /* Daylight */
  sky: {
    label: "Daylight",
    classes: {
      html: "font-sans scheme-light",
      body: "bg-slate-50 text-slate-900",
      toolbar: "h-14 px-4 gap-3 bg-white border-b border-slate-200",
      brand: "text-sm font-semibold tracking-tight text-slate-900",
      status: "text-sm text-slate-600",
      progress: "w-32 h-1 rounded-full bg-slate-200 after:bg-blue-600 after:rounded-full",
      chip: "text-xs tabular-nums text-slate-600",
      chipWarn: "text-xs font-medium tabular-nums text-amber-700",
      ctl: "gap-1.5 text-sm text-slate-600",
      select: "px-2.5 py-1.5 text-sm rounded-md bg-white text-slate-900 border border-slate-300 shadow-none hover:border-slate-400 focus:outline-none focus:border-blue-600 focus:ring-1 focus:ring-blue-600 transition-colors",
      checkbox: "size-4 accent-blue-600",
      button: "px-3 py-1.5 text-sm font-medium rounded-md bg-white text-red-700 border border-slate-300 shadow-none hover:bg-red-50 hover:border-red-300 active:bg-red-100 focus:outline-none focus:ring-1 focus:ring-red-600 transition-colors",
      errorBar: "px-4 py-2.5 text-sm font-medium bg-red-50 text-red-700 border-b border-red-200",
      main: "",
      sidebar: "w-72 pb-8 bg-white border-r border-slate-200",
      sidebarCount: "sticky top-0 z-10 bg-white px-4 pt-4 pb-2 text-xs font-medium tabular-nums text-slate-600 border-b border-slate-200",
      sidebarFilter: "px-4 py-2 text-sm bg-white text-slate-900 border-b border-slate-200 placeholder:text-slate-400 focus:bg-blue-50 transition-colors",
      bankSummary: "px-4 py-2.5 text-sm font-medium text-slate-900 marker:text-slate-400 hover:bg-slate-50 transition-colors",
      catSummary: "pl-8 pr-4 py-1.5 text-[13px] text-slate-600 marker:text-slate-400 hover:bg-slate-50 hover:text-slate-900 transition-colors",
      patchRow: "pl-12 pr-4 py-1 text-[13px] leading-6 text-slate-600 rounded-none hover:bg-slate-100 hover:text-slate-900 transition-colors [&.selected]:bg-blue-50 [&.selected]:text-blue-700 [&.selected]:font-semibold [&.selected]:hover:bg-blue-50 [&.selected]:hover:text-blue-700",
      stage: "p-8 bg-slate-50",
      decor: "bg-[linear-gradient(to_bottom,rgba(37,99,235,0.05),transparent_60%)]",
      canvasWrap: "rounded-lg overflow-hidden bg-white ring-1 ring-slate-200 shadow-sm",
      canvas: "",
      footer: "mt-8 text-sm leading-relaxed text-slate-600 [&_a]:text-blue-600 [&_a]:underline [&_a]:underline-offset-2 [&_a]:decoration-blue-300 [&_a:hover]:text-blue-700 [&_kbd]:font-sans [&_kbd]:text-xs [&_kbd]:px-1.5 [&_kbd]:py-0.5 [&_kbd]:rounded-md [&_kbd]:bg-white [&_kbd]:text-slate-700 [&_kbd]:border [&_kbd]:border-slate-300",
      piano: "h-24 bg-white border-t border-slate-200",
      keyWhite: "bg-white border-r border-slate-200 rounded-none hover:bg-slate-50 after:text-[9px] after:text-slate-500 transition-colors [&.held]:bg-blue-600 [&.held]:border-blue-600 [&.held]:after:text-white",
      keyBlack: "bg-slate-800 border border-slate-800 rounded-none hover:bg-slate-700 transition-colors [&.held]:bg-blue-600 [&.held]:border-blue-600",
      overlay: "bg-slate-900/40",
      overlayBox: "bg-white rounded-lg p-10 ring-1 ring-slate-200 shadow-sm text-slate-600 [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-slate-900 [&_h2]:mt-0 [&_h2]:mb-3 [&_p]:text-sm [&_p]:leading-relaxed [&_p]:text-slate-600",
      startBtn: "mt-8 px-6 py-2.5 text-sm font-medium rounded-md bg-blue-600 text-white shadow-sm hover:bg-blue-700 active:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:ring-offset-2 transition-colors",
    },
  },
};

let activeName = DEFAULT_THEME;

/**
 * Pure function. The class attribute a region should carry under a skin.
 *
 * @param {string} region - a REGIONS entry
 * @param {object} skin - a THEMES entry
 * @param {string[]} sticky - state classes currently on the element
 * @returns {string}
 *
 * @example
 * classesFor('canvas', THEMES.swiss, [])
 * // 'block outline-none touch-none cursor-default'
 * @example
 * classesFor('patchRow', THEMES.swiss, ['selected']).includes('patch')
 * // true -- the marker patches.js selects by survives
 */
export function classesFor(region, skin, sticky) {
  return [MARKERS[region], BASE[region], skin.classes[region], ...sticky]
    .filter(Boolean).join(' ');
}

/**
 * Command. Rewrites one element's class attribute for a region.
 *
 * Mutates el.className.
 */
function dress(el, region, skin) {
  el.className = classesFor(region, skin, STICKY.filter((c) => el.classList.contains(c)));
}

/**
 * Command. Applies a skin to the whole page and remembers the choice.
 *
 * Sets data-theme on <html> (so a skin can also use Tailwind's
 * data-[theme=...] variants), rewrites every region's classes, and persists the
 * name. Throws on an unknown skin rather than silently leaving the page dressed
 * in the previous one.
 *
 * @param {string} name - a key of THEMES, e.g. 'brutalist'
 * @returns {void}
 *
 * @example applyTheme('crt')  // page becomes the mono green terminal skin
 */
export function applyTheme(name) {
  const skin = THEMES[name];
  if (!skin) {
    throw new Error(`Unknown skin "${name}" -- have: ${Object.keys(THEMES).join(', ')}`);
  }
  activeName = name;
  document.documentElement.dataset.theme = name;
  for (const region of REGIONS) {
    for (const el of document.querySelectorAll(SELECTORS[region])) dress(el, region, skin);
  }
  localStorage.setItem(STORAGE_KEY, name);
}

/**
 * Command. Dresses the elements patches.js and piano.js just created.
 *
 * applyTheme only sees the DOM as it is when it runs, so anything built later
 * -- the 3559 patch rows, the 128 keys -- needs this once it exists.
 *
 * @returns {void}
 *
 * @example dressGenerated()  // after buildPatchTree() or createPiano()
 */
export function dressGenerated() {
  const skin = THEMES[activeName];
  for (const region of GENERATED) {
    for (const el of document.querySelectorAll(SELECTORS[region])) dress(el, region, skin);
  }
}

/**
 * Query. The skin to start in: the stored choice, else the default.
 *
 * Reads localStorage. A stored name from an older build no longer in THEMES is
 * reported and ignored rather than thrown on, since it is not the user's fault
 * and the page still has to load.
 *
 * @returns {string} a key of THEMES
 *
 * @example storedTheme()  // 'paper' after the user picked Paper & Ink
 */
export function storedTheme() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && !THEMES[stored]) {
    console.warn(`Stored skin "${stored}" no longer exists; using "${DEFAULT_THEME}"`);
    return DEFAULT_THEME;
  }
  return stored || DEFAULT_THEME;
}

/**
 * Command. Fills the skin <select>, applies the remembered skin, wires changes.
 *
 * @param {HTMLSelectElement} selectEl - the picker in the toolbar
 * @returns {void}
 *
 * @example initThemePicker(document.getElementById('theme-select'))
 */
export function initThemePicker(selectEl) {
  for (const [name, skin] of Object.entries(THEMES)) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = skin.label;
    selectEl.append(option);
  }

  const initial = storedTheme();
  selectEl.value = initial;
  applyTheme(initial);

  selectEl.addEventListener('change', () => applyTheme(selectEl.value));
}
