// Page-world (MAIN world) script.
//
// Injected by content.js at ``document_start`` alongside injected.js
// (and the legacy review-modal.js). Exposes a Shadow-DOM-scoped
// **sidebar** the fetch interceptor can ``await`` when ``uiMode``
// is ``"sidebar"`` — which is the new default for Milestone 8 Wave B.
//
// Companion to ``review-modal.js`` (still used when ``uiMode === "modal"``):
//   * The modal renders the per-occurrence ``DetectionResult`` list
//     returned by ``POST /v1/extension/sanitize`` (legacy contract).
//   * The sidebar renders the **aggregated** ``AggregatedEntity`` list
//     returned by ``POST /v1/extension/sanitize/aggregated`` (Milestone
//     8 Wave A). One row per unique ``(category, value)`` pair, with a
//     count badge instead of repeating the same surface.
//
// Exposed on ``window.__localMaskMCP.sidebar`` so injected.js can reach
// it without cross-world messaging.
//
// Design decisions
// ~~~~~~~~~~~~~~~~
//
// * **Shadow DOM** — entire UI lives inside ``attachShadow`` on a
//   throwaway ``<div>`` appended to ``document.body``. Page CSS cannot
//   bleed in and our styles never touch the page. When the promise
//   resolves the host element is removed completely.
// * **z-index: 2147483647** (max signed 32-bit int) so the sidebar
//   always sits above whatever layer the host page is using.
// * **No innerHTML** — every node is built via ``createElement`` /
//   ``textContent``; user-controlled strings (entity values, labels,
//   categories, original text) only ever reach the DOM through
//   ``textContent``.
// * **No dependencies** — vanilla JS. Indigo / red / gray palette
//   defined as CSS variables in the shadow root style block.
// * **Keyboard** — Enter confirms; Esc cancels; Tab cycles; Space
//   toggles focused checkbox. Tab is wrapped via a focus trap so it
//   never escapes the sidebar.
// * **Force-mask lock** — categories appearing in
//   ``force_masked_categories`` are rendered with a 🔒 icon and their
//   checkboxes are ``disabled`` so neither the row nor the parent
//   category nor the bulk "全解除" button can ever uncheck them.
// * **Severity colour-coding** — every row carries a left coloured
//   border (red / orange / amber / gray) matching its ``severity``
//   field, plus a ``[critical|high|medium|low]`` pill after the label.
//   Category headers show the pill at the highest severity of their
//   children (e.g. a ``CREDENTIAL`` header with one ``API_KEY`` inside
//   renders as ``critical``).
// * **Critical long-press guard** — ``severity === "critical"`` rows
//   replace the checkbox with a circular progress ring control. A
//   user must press and hold for 800 ms (via ``pointer*`` events so
//   it works on touch) to toggle the row off. Bulk "すべて解除" shows
//   a native ``window.confirm`` and, if accepted, clears only the
//   non-critical rows — critical ones still require the long-press
//   gesture. When a row is ALSO force-masked the long-press UI is
//   replaced with a disabled lock icon so the row is truly immutable.

(() => {
  "use strict";

  const NS = (window.__localMaskMCP = window.__localMaskMCP || {});
  if (NS.sidebar) {
    // Idempotent — content.js may re-inject after an SPA navigation
    // and we must not install the sidebar twice.
    return;
  }

  // Build a stable "row key" for an aggregated entity. Used as the
  // ``data-row-key`` on each checkbox AND as the entry in the
  // ``maskedEntityKeys`` set the caller receives so a downstream
  // consumer can correlate UI selections with the aggregated rows.
  function rowKeyOf(entity) {
    return `${String(entity.category || "")}|${String(entity.value || "")}`;
  }

  // Pure function — used both at build-time (initial preview) and on
  // every checkbox change. Same logic the gateway-side ``tag`` strategy
  // uses, just executed client-side so we can update the preview
  // without round-tripping through the gateway.
  //
  // ``keepers`` is an Array<[start, end, label]>. We replace each span
  // back-to-front so earlier offsets stay valid as the string shrinks.
  function applyMasks(originalText, keepers) {
    if (!keepers || keepers.length === 0) return originalText;

    // Pass 1 — number every (label, surface) pair left-to-right so
    // repeated mentions of the same surface share a placeholder
    // (``<PERSON_1>`` used twice means "same person referenced
    // twice", matching the server-side _tag_mask invariant).
    const counters = new Map();
    const numbering = new Map();
    const ascending = [...keepers].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const [s, e, label] of ascending) {
      if (!Number.isInteger(s) || !Number.isInteger(e) || e <= s) continue;
      const surface = originalText.slice(s, e);
      const key = `${label}\x00${surface}`;
      if (!numbering.has(key)) {
        const n = (counters.get(label) || 0) + 1;
        counters.set(label, n);
        numbering.set(key, n);
      }
    }

    // Pass 2 — substitute back-to-front so earlier offsets remain
    // valid as later substrings shrink or grow.
    const descending = [...keepers].sort((a, b) => b[0] - a[0]);
    let result = originalText;
    for (const [s, e, label] of descending) {
      if (
        !Number.isInteger(s) ||
        !Number.isInteger(e) ||
        e <= s ||
        s < 0 ||
        e > result.length
      ) {
        // Defensive: skip malformed positions instead of throwing,
        // so a single bad row never breaks the whole preview.
        continue;
      }
      const surface = originalText.slice(s, e);
      const lbl = String(label || "MASKED");
      const n = numbering.get(`${lbl}\x00${surface}`) || 1;
      result = result.slice(0, s) + `<${lbl}_${n}>` + result.slice(e);
    }
    return result;
  }

  const STYLE = `
    /* ================================================================
       PII Masking Review Sidebar - Modernised stylesheet
       Glassmorphism header, micro-animations, custom scrollbar,
       segment-control tabs, gradient buttons, code-block preview.
       NOTE: no backticks allowed anywhere inside this template literal.
       ================================================================ */

    :host {
      all: initial;
    }

    /* --- Root & design tokens ---------------------------------------- */
    .root {
      position: relative;
      width: 100%;
      height: 100%;
      pointer-events: none;
      font-family: system-ui, -apple-system, "Segoe UI", Roboto,
        "Helvetica Neue", sans-serif;
      font-size: 14px;
      color: var(--text);

      --primary: #4f46e5;
      --primary-hover: #4338ca;
      --danger: #dc2626;
      --bg: #f9fafb;
      --bg-panel: #ffffff;
      --bg-panel-rgb: 255, 255, 255;
      --border: #e5e7eb;
      --text: #111827;
      --text-muted: #6b7280;
      --shadow: 0 10px 25px rgba(0, 0, 0, 0.08);
      --radius: 12px;
      --row-bg-hover: #f3f4f6;
      --locked-bg: #fef2f2;

      /* Severity palette -- Tailwind 500/100 pairs. Mirrored in
         review-modal.js so both surfaces flash the same colour for
         the same risk tier. */
      --sev-critical: #e11d48;    /* rose-600 — vivid rose  */
      --sev-critical-bg: #fff1f2; /* rose-50  */
      --sev-high: #ea580c;        /* orange-600 — deeper    */
      --sev-high-bg: #fff7ed;     /* orange-50  */
      --sev-medium: #ca8a04;      /* yellow-600 — muted gold */
      --sev-medium-bg: #fefce8;   /* yellow-50  */
      --sev-low: #64748b;         /* slate-500 — cool gray  */
      --sev-low-bg: #f8fafc;      /* slate-50   */

      /* Shared micro-animation duration */
      --ease-fast: 0.15s ease;
    }

    .root.dark {
        --primary: #818cf8;
        --primary-hover: #6366f1;
        --danger: #f87171;
        --bg: var(--site-bg, #1f2937);
        --bg-panel: var(--site-bg, #111827);
        --bg-panel-rgb: 17, 24, 39;
        --border: #374151;
        --text: #f9fafb;
        --text-muted: #9ca3af;
        --shadow: 0 10px 25px rgba(0, 0, 0, 0.4);
        --row-bg-hover: #374151;
        --locked-bg: #450a0a;
        --sev-critical: #fb7185;
        --sev-critical-bg: rgba(225, 29, 72, 0.15);
        --sev-high: #fb923c;
        --sev-high-bg: rgba(234, 88, 12, 0.12);
        --sev-medium: #fbbf24;
        --sev-medium-bg: rgba(202, 138, 4, 0.10);
        --sev-low: #94a3b8;
        --sev-low-bg: rgba(100, 116, 139, 0.10);
    }

    .root.light {
        --bg: var(--site-bg, #f9fafb);
        --bg-panel: var(--site-bg, #ffffff);
    }

    /* --- Panel shell ------------------------------------------------- */
    .panel {
      position: relative;
      width: 100%;
      height: 100%;
      background: var(--bg-panel);
      border-left: 1px solid var(--border);
      box-shadow: var(--shadow);
      display: flex;
      flex-direction: column;
      pointer-events: auto;
      overflow: hidden;
    }

    /* --- Glassmorphism header ---------------------------------------- */
    .panel header {
      flex: 0 0 auto;
      padding: 14px 16px 12px 16px;
      border-bottom: 1px solid rgba(var(--bg-panel-rgb), 0.45);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      background: rgba(var(--bg-panel-rgb), 0.85);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      z-index: 2;
    }

    .panel header h2 {
      margin: 0;
      font-size: 15px;
      font-weight: 700;
      color: var(--text);
      letter-spacing: 0.025em;
    }

    .mode-pill {
      flex: 0 0 auto;
      margin-left: auto;
      margin-right: 4px;
      padding: 3px 10px;
      font-size: 10.5px;
      font-weight: 700;
      letter-spacing: 0.01em;
      border-radius: 10px;
      white-space: nowrap;
      line-height: 1.35;
    }
    .mode-pill.mode-replace {
      background: linear-gradient(135deg, rgba(168, 85, 247, 0.18), rgba(99, 102, 241, 0.18));
      color: #a855f7;
      border: 1px solid rgba(168, 85, 247, 0.42);
    }
    .mode-pill.mode-detect {
      background: rgba(59, 130, 246, 0.14);
      color: #3b82f6;
      border: 1px solid rgba(59, 130, 246, 0.36);
    }
    .mode-pill.mode-regex {
      background: rgba(100, 116, 139, 0.14);
      color: var(--text-muted);
      border: 1px solid var(--border);
    }

    .close-btn {
      background: transparent;
      border: none;
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 6px;
      color: var(--text-muted);
      transition: background var(--ease-fast), color var(--ease-fast),
        transform var(--ease-fast);
    }
    .close-btn:hover,
    .close-btn:focus-visible {
      background: var(--row-bg-hover);
      color: var(--text);
      outline: none;
      transform: scale(1.08);
    }
    .close-btn:active {
      transform: scale(0.95);
    }

    /* --- Body layout (flex column) ----------------------------------- */
    /* The .body is a flex column so the preview can be pinned at the
       bottom and only the category list scrolls.  Vertical layout:
         [bulk-bar]    flex 0 0 auto  (fixed)
         [categories]  flex 1 1 auto  (scrolls)
         [preview]     flex 0 0 auto  (pinned, capped height)
       The outer footer (confirm / cancel) still sits below .body. */
    .body {
      flex: 1 1 auto;
      min-height: 0;
      display: flex;
      flex-direction: column;
      padding: 12px 16px 0 16px;
      background: var(--bg);
      overflow: hidden;
      position: relative;   /* containing block for .llm-overlay */
    }

    .bulk-bar {
      flex: 0 0 auto;
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
    }

    /* --- LLM centered overlay + compact error toast ------------------ */
    /* While the LLM is thinking we cover the category area with a
       semi-transparent gradient and show a large centered spinner +
       label. Regex rows remain visible underneath so the user can
       start reviewing; pointer-events are disabled on the overlay
       itself (not its children, which stay interactive in case we
       add a "cancel LLM" button later). */
    .llm-overlay {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 14px;
      padding: 32px 16px;
      z-index: 10;
      background: linear-gradient(145deg,
        rgba(168, 85, 247, 0.12),
        rgba(99, 102, 241, 0.10) 40%,
        rgba(var(--bg-panel-rgb), 0.82) 100%);
      backdrop-filter: blur(3px);
      -webkit-backdrop-filter: blur(3px);
      pointer-events: none;
      animation: llm-overlay-in 0.22s ease-out;
    }
    .root.dark .llm-overlay {
      background: linear-gradient(145deg,
        rgba(168, 85, 247, 0.22),
        rgba(99, 102, 241, 0.18) 40%,
        rgba(var(--bg-panel-rgb), 0.82) 100%);
    }
    .llm-overlay-spin-wrap {
      position: relative;
      width: 64px;
      height: 64px;
    }
    .llm-overlay-spin {
      position: absolute;
      inset: 0;
      border: 3px solid rgba(139, 92, 246, 0.18);
      border-top-color: #a855f7;
      border-right-color: #6366f1;
      border-radius: 50%;
      animation: llm-overlay-spin 0.9s linear infinite;
    }
    .llm-overlay-spin.ring2 {
      inset: 8px;
      border-width: 2px;
      border-top-color: #6366f1;
      border-right-color: transparent;
      border-bottom-color: transparent;
      border-left-color: #a855f7;
      animation-duration: 1.3s;
      animation-direction: reverse;
      opacity: 0.7;
    }
    .llm-overlay-label {
      font-size: 15px;
      font-weight: 700;
      letter-spacing: 0.02em;
      color: var(--text);
      text-align: center;
    }
    .llm-overlay-sub {
      font-size: 11.5px;
      color: var(--text-muted);
      text-align: center;
      max-width: 260px;
      line-height: 1.5;
    }
    .llm-overlay.is-leaving {
      animation: llm-overlay-out 0.18s ease-in forwards;
    }
    @keyframes llm-overlay-spin { to { transform: rotate(360deg); } }
    @keyframes llm-overlay-in {
      from { opacity: 0; }
      to   { opacity: 1; }
    }
    @keyframes llm-overlay-out {
      from { opacity: 1; }
      to   { opacity: 0; }
    }

    /* Error toast — slim top banner that auto-hides after 4s. Kept
       visually calm so the user can still focus on the (now regex-
       only) review list. */
    .llm-toast {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      margin-bottom: 10px;
      border-radius: 8px;
      background: rgba(248, 113, 113, 0.12);
      border: 1px solid rgba(248, 113, 113, 0.42);
      color: var(--text);
      font-size: 12px;
      line-height: 1.4;
      animation: llm-toast-in 0.18s ease-out;
    }
    @keyframes llm-toast-in {
      from { opacity: 0; transform: translateY(-4px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    /* --- Custom scrollbar -------------------------------------------- */
    /* 機密の可能性がある文の警告。マスク候補ではないので、カテゴリ一覧と
       混ざらないよう独立したブロックとして上に置く。左の太い罫で
       「これは操作するものではなく読むもの」と示す。 */
    .confidential-warning {
      flex: 0 0 auto;
      margin: 0 0 10px;
      padding: 10px 12px;
      border-left: 3px solid var(--sev-high);
      border-radius: 4px;
      background: var(--sev-high-bg, rgba(217, 119, 6, 0.08));
    }
    .confidential-warning-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--sev-high);
      margin-bottom: 4px;
    }
    .confidential-warning-lead {
      margin: 0 0 8px;
      font-size: 11px;
      line-height: 1.5;
      opacity: 0.85;
    }
    .confidential-item {
      margin-bottom: 8px;
      padding-left: 8px;
      border-left: 1px solid rgba(127, 127, 127, 0.35);
    }
    .confidential-item:last-of-type { margin-bottom: 0; }
    .confidential-quote {
      font-size: 12px;
      line-height: 1.55;
      word-break: break-word;
    }
    .confidential-why {
      margin-top: 3px;
      font-size: 10px;
      opacity: 0.7;
      word-break: break-word;
    }
    .confidential-warning-note {
      margin: 8px 0 0;
      font-size: 10px;
      line-height: 1.5;
      opacity: 0.6;
    }

    .categories {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      padding-right: 4px;
      margin-right: -4px;
      padding-bottom: 6px;
      scrollbar-width: thin;
      scrollbar-color: rgba(var(--bg-panel-rgb), 0.45) transparent;
    }
    .categories::-webkit-scrollbar {
      width: 6px;
    }
    .categories::-webkit-scrollbar-track {
      background: transparent;
    }
    .categories::-webkit-scrollbar-thumb {
      background: rgba(107, 114, 128, 0.28);
      border-radius: 3px;
    }
    .categories::-webkit-scrollbar-thumb:hover {
      background: rgba(107, 114, 128, 0.45);
    }

    /* --- Severity tab bar (segment control) -------------------------- */
    .sev-tabs {
      flex: 0 0 auto;
      display: flex;
      gap: 2px;
      margin-bottom: 8px;
      background: var(--row-bg-hover);
      border-radius: 10px;
      padding: 3px;
    }
    .sev-tab {
      flex: 1 1 0;
      padding: 5px 0;
      font: inherit;
      font-size: 11px;
      font-weight: 500;
      border-radius: 8px;
      border: none;
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
      text-align: center;
      white-space: nowrap;
      transition: background var(--ease-fast), color var(--ease-fast),
        box-shadow var(--ease-fast), transform var(--ease-fast);
    }
    .sev-tab:hover {
      background: rgba(var(--bg-panel-rgb), 0.6);
      color: var(--text);
    }
    .sev-tab:active { transform: scale(0.97); }
    .sev-tab.active {
      font-weight: 600;
      color: #fff;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
    }
    .sev-tab.active[data-sev="all"]      { background: var(--text-muted); }
    .sev-tab.active[data-sev="critical"] { background: var(--sev-critical); }
    .sev-tab.active[data-sev="high"]     { background: var(--sev-high); }
    .sev-tab.active[data-sev="medium"]   { background: var(--sev-medium); }
    .sev-tab.active[data-sev="low"]      { background: var(--sev-low); }

    /* --- Bulk buttons ------------------------------------------------ */
    .bulk-btn {
      flex: 1 1 0;
      padding: 6px 10px;
      font: inherit;
      font-size: 12px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--bg-panel);
      color: var(--text);
      cursor: pointer;
      transition: background var(--ease-fast), border-color var(--ease-fast),
        transform var(--ease-fast), box-shadow var(--ease-fast);
    }
    .bulk-btn:hover,
    .bulk-btn:focus-visible {
      background: var(--row-bg-hover);
      outline: none;
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
    }
    .bulk-btn:active { transform: scale(0.97); }

    /* --- Hold-duration slider ---------------------------------------- */
    .hold-slider-bar {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
      font-size: 11px;
      color: var(--text-muted);
    }
    .hold-slider-bar label {
      white-space: nowrap;
    }
    .hold-slider-bar input[type="range"] {
      flex: 1 1 auto;
      -webkit-appearance: none;
      appearance: none;
      height: 4px;
      border-radius: 2px;
      background: var(--border);
      outline: none;
      transition: background var(--ease-fast);
    }
    .hold-slider-bar input[type="range"]::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: var(--sev-critical);
      border: 2px solid var(--bg-panel);
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.18);
      cursor: pointer;
      transition: transform var(--ease-fast), box-shadow var(--ease-fast);
    }
    .hold-slider-bar input[type="range"]::-webkit-slider-thumb:hover {
      transform: scale(1.18);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.22);
    }
    .hold-slider-bar input[type="range"]::-moz-range-thumb {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: var(--sev-critical);
      border: 2px solid var(--bg-panel);
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.18);
      cursor: pointer;
    }
    .hold-slider-bar .hold-val {
      min-width: 28px;
      text-align: right;
      font-weight: 600;
      color: var(--text);
    }

    /* --- Empty state ------------------------------------------------- */
    .empty {
      padding: 24px 0;
      text-align: center;
      color: var(--text-muted);
      font-size: 13px;
    }

    /* --- Category cards ---------------------------------------------- */
    .category {
      background: var(--bg-panel);
      border: 1px solid rgba(var(--bg-panel-rgb), 0.25);
      border-radius: 14px;
      margin-bottom: 10px;
      overflow: hidden;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04), 0 1px 2px rgba(0, 0, 0, 0.03);
      transition: box-shadow var(--ease-fast), transform var(--ease-fast);
    }
    .category:hover {
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.07), 0 1px 3px rgba(0, 0, 0, 0.04);
    }
    .category.is-locked {
      border-color: var(--sev-critical);
    }

    .category-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      cursor: pointer;
      user-select: none;
      border-left: 4px solid transparent;
      transition: filter var(--ease-fast), background var(--ease-fast);
    }
    .category.cat-sev-critical .category-header { border-left-color: var(--sev-critical); }
    .category.cat-sev-high     .category-header { border-left-color: var(--sev-high); }
    .category.cat-sev-medium   .category-header { border-left-color: var(--sev-medium); }
    .category.cat-sev-low      .category-header { border-left-color: var(--sev-low); }
    .category-header:hover {
      filter: brightness(0.95);
    }
    .category.is-locked .category-header:hover {
      filter: brightness(0.92);
    }

    .twisty {
      width: 14px;
      text-align: center;
      color: var(--text-muted);
      font-size: 12px;
      transition: transform 0.15s ease;
    }
    .category.is-collapsed .twisty {
      transform: rotate(-90deg);
    }

    .category-name {
      flex: 1 1 auto;
      font-weight: 600;
      font-size: 13px;
      color: var(--text);
      display: flex;
      align-items: center;
      gap: 6px;
      letter-spacing: 0.01em;
    }
    .category-count {
      color: var(--text-muted);
      font-weight: 400;
      font-size: 12px;
    }
    .lock-icon {
      font-size: 12px;
      color: var(--danger);
      transition: transform var(--ease-fast);
    }
    .category-toggle {
      width: 16px;
      height: 16px;
      flex: 0 0 auto;
      accent-color: var(--primary);
      cursor: pointer;
      transition: transform var(--ease-fast);
    }
    .category-toggle:hover { transform: scale(1.15); }
    .category-toggle:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }
    .category-toggle:disabled:hover { transform: none; }

    .rows {
      border-top: 1px solid var(--border);
    }
    .category.is-locked .rows {
      border-top-color: var(--sev-critical);
    }
    .category.is-collapsed .rows {
      display: none;
    }

    /* --- Row layout (2-line) -----------------------------------------
       Line 1:  icon + value -> <PLACEHOLDER>
       Line 2:  N-ken + severity pill + long-press hint (critical only)
       The whole row element (.row) is the interactive surface for
       critical items so the long-press gesture fires wherever the
       user presses. An absolute-positioned fill (.lp-fill) animates
       left-to-right across the full row width during the hold.
       NOTE: backticks MUST NOT appear in this block -- the enclosing
       string is a JS template literal and any backtick terminates it.
    */
    .row {
      display: block;
      position: relative;
      padding: 10px 14px 10px 18px;
      border-bottom: 1px solid var(--border);
      border-left: 4px solid var(--sev-low);
      font-size: 13px;
      transition: background-color var(--ease-fast), box-shadow var(--ease-fast),
        transform var(--ease-fast);
      overflow: hidden;
      cursor: pointer;
      user-select: none;
      -webkit-tap-highlight-color: transparent;
    }
    .row.sev-critical { border-left-color: var(--sev-critical); }
    .row.sev-high     { border-left-color: var(--sev-high); }
    .row.sev-medium   { border-left-color: var(--sev-medium); }
    .row.sev-low      { border-left-color: var(--sev-low); }
    /* Unmasked row = green right-border marker only. Previously the
       row itself had a 0.55 opacity which combined with child opacity
       to produce a flicker when hovering an unmasked row. Children
       carry their own opacity / color changes.
       NB: no backticks inside this CSS template literal. */
    .row.is-unmasked  { background: var(--bg); border-right: 4px solid #22c55e; }

    /* Stagger-in animation applied when rows are first rendered after
       an LLM augmentation completes. Each row gets its animation-delay
       set inline by applyAggregated(). Uses both-fill + explicit
       from/to so a row NEVER gets stuck at opacity:0 — if animation
       is disabled (prefers-reduced-motion, Shadow DOM glitches) the
       default styles stay visible.
       NB: no backticks inside this CSS template literal. */
    .row.row-staggered {
      animation: row-stagger-in 0.32s ease-out both;
    }
    @keyframes row-stagger-in {
      from { opacity: 0; transform: translateX(10px); }
      to   { opacity: 1; transform: translateX(0); }
    }
    @media (prefers-reduced-motion: reduce) {
      .row.row-staggered { animation: none; }
    }

    .row.long-press-pulse {
      animation: lp-pulse 0.45s ease-out;
    }
    @keyframes lp-pulse {
      0%   { box-shadow: inset 0 0 0 0 var(--sev-critical); }
      30%  { box-shadow: inset 0 0 0 4px var(--sev-critical); }
      100% { box-shadow: inset 0 0 0 0 var(--sev-critical); }
    }
    .row.unlock-flash {
      animation: unlock-glow 0.6s ease-out;
    }
    @keyframes unlock-glow {
      0%   { box-shadow: inset 0 0 0 0 #22c55e; background: #f0fdf4; }
      40%  { box-shadow: inset 0 0 0 4px #22c55e; background: #dcfce7; }
      100% { box-shadow: inset 0 0 0 0 #22c55e; background: transparent; }
    }

    .category.is-locked .row {
      border-bottom-color: var(--sev-critical);
    }
    .row:last-child {
      border-bottom: none;
    }
    /* Row hover: subtle lift + shadow */
    .row:hover {
      background: var(--row-bg-hover);
      transform: translateY(-1px);
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.06);
    }
    .category.is-locked .row:hover {
      filter: brightness(0.95);
    }

    /* Long-press progress fill */
    .row .lp-fill {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 0%;
      background: rgba(220, 38, 38, 0.22);
      pointer-events: none;
      transition: width 0.05s linear;
      z-index: 0;
    }
    .row .row-line1,
    .row .row-line2 {
      position: relative;
      z-index: 1;
    }
    .row-line1 {
      display: grid;
      /* 4-column grid that stays consistent across every row so the
         "value arrow placeholder" pairs form vertical columns:
           [ icon ] [ 変更前 value ] [ arrow ] [ 変更後 placeholder ]
         The two data columns share the remaining space 50/50.
         minmax(0, 1fr) on each data column is the trick that lets
         text-overflow: ellipsis work inside grid cells.
         NB: absolutely no backticks inside this CSS template. */
      grid-template-columns: auto minmax(0, 1fr) auto minmax(0, 1fr);
      column-gap: 8px;
      align-items: center;
    }
    .row-icon {
      font-size: 14px;
      line-height: 1;
      transition: transform var(--ease-fast);
    }
    .row-icon.is-llm {
      filter: drop-shadow(0 0 4px rgba(168, 85, 247, 0.55));
      animation: llm-icon-pulse 2.4s ease-in-out infinite;
    }
    @keyframes llm-icon-pulse {
      0%, 100% { filter: drop-shadow(0 0 2px rgba(168, 85, 247, 0.35)); }
      50%      { filter: drop-shadow(0 0 7px rgba(168, 85, 247, 0.70)); }
    }
    .row:hover .row-icon {
      transform: scale(1.1);
    }
    .row-value {
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas,
        "Liberation Mono", monospace;
      font-size: 12.5px;
      background: transparent;
      border: 1px solid var(--border);
      padding: 1px 6px;
      border-radius: 4px;
      font-weight: 500;
      color: var(--text-muted);
      opacity: 0.75;
      /* Specific properties only — "transition: all" was animating
         layout-related things (font-weight) which caused a visible
         flicker whenever hover / is-unmasked / any parent opacity
         changed together.
         NB: no backticks inside this CSS template literal. */
      transition: color var(--ease-fast), border-color var(--ease-fast),
        opacity var(--ease-fast);
    }
    .row.is-unmasked .row-value {
      border-color: var(--text-muted);
      color: var(--text);
      opacity: 1;
      font-weight: 600;
    }
    .row-arrow {
      justify-self: center;
      color: var(--primary);
      font-weight: 800;
      font-size: 15px;
      transition: all var(--ease-fast);
    }
    .row.is-unmasked .row-arrow {
      color: var(--text-muted);
      transform: scaleX(-1);
    }
    .row:hover .row-arrow {
      transform: translateX(2px);
    }
    .row.is-unmasked:hover .row-arrow {
      transform: scaleX(-1) translateX(2px);
    }
    .row-placeholder {
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas,
        "Liberation Mono", monospace;
      font-size: 12px;
      color: var(--primary);
      background: transparent;
      border: 1px solid var(--primary);
      padding: 1px 6px;
      border-radius: 4px;
      font-weight: 600;
      transition: color var(--ease-fast), border-color var(--ease-fast),
        opacity var(--ease-fast);
    }
    .row.is-unmasked .row-placeholder {
      border-color: var(--border);
      color: var(--text-muted);
      opacity: 0.5;
      font-weight: 500;
    }
    .row-line2 {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-top: 4px;
      font-size: 11px;
      color: var(--text-muted);
    }
    .row-count { font-variant-numeric: tabular-nums; }
    .row-llm-badge {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 2px 8px;
      font-size: 10.5px;
      font-weight: 700;
      color: #fff;
      background: linear-gradient(135deg, #a855f7, #6366f1);
      border-radius: 10px;
      letter-spacing: 0.03em;
      box-shadow: 0 1px 3px rgba(99, 102, 241, 0.28);
    }
    .row-llm-badge::before {
      content: "";
      display: inline-block;
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: #fff;
      box-shadow: 0 0 4px rgba(255, 255, 255, 0.8);
    }

    /* --- Severity pills ---------------------------------------------- */
    .sev-pill {
      display: inline-block;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.4px;
      padding: 1px 7px;
      border-radius: 8px;
      text-transform: uppercase;
      transition: transform var(--ease-fast);
    }
    .sev-pill.sev-critical { background: var(--sev-critical-bg); color: var(--sev-critical); border: 1px solid var(--sev-critical); }
    .sev-pill.sev-high     { background: var(--sev-high-bg);     color: var(--sev-high);     border: 1px solid var(--sev-high); }
    .sev-pill.sev-medium   { background: var(--sev-medium-bg);   color: var(--sev-medium);   border: 1px solid var(--sev-medium); }
    .sev-pill.sev-low      { background: var(--sev-low-bg);      color: var(--sev-low);      border: 1px solid var(--sev-low); }

    .row-lock {
      color: var(--danger);
      font-weight: 600;
    }
    .exclude-btn {
      margin-left: auto;
      padding: 2px 8px;
      font: inherit;
      font-size: 10px;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: var(--bg-panel);
      color: var(--text-muted);
      cursor: pointer;
      transition: all var(--ease-fast);
    }
    .exclude-btn:hover:not(:disabled) {
      background: var(--sev-low-bg);
      color: var(--text);
      border-color: var(--text-muted);
    }
    .exclude-btn:disabled {
      opacity: 0.6;
      cursor: default;
      background: var(--sev-low-bg);
      color: var(--sev-low);
    }

    /* Hide the built-in checkbox: we drive state from the row itself.
       The checkbox still exists in the DOM for keyboard accessibility
       (it receives focus via Tab) but is visually suppressed. */
    .row-checkbox {
      position: absolute;
      opacity: 0;
      pointer-events: none;
      width: 1px;
      height: 1px;
    }

    /* --- Preview section (code-block aesthetic) ---------------------- */
    .preview-section {
      flex: 0 0 auto;
      margin-top: 8px;
      padding: 12px 0 12px 0;
      border-top: 1px solid var(--border);
      background: var(--bg);
      position: relative;
      transition: max-height 0.2s ease, padding 0.2s ease, opacity 0.2s ease;
    }
    /* ドラッグ popover 表示中はプレビュー本体を折りたたんで
       カテゴリ選択とリスト表示の画面占有を確保する。
       h3 (プレビューと書かれた見出し) だけ残して何が折りたたまれているか
       はユーザーに見えるようにする (cursor: pointer で開閉可能)。 */
    .preview-section.preview-collapsed {
      max-height: 28px;
      padding-top: 6px;
      padding-bottom: 6px;
      overflow: hidden;
      opacity: 0.7;
    }
    .preview-section.preview-collapsed h3 {
      margin-bottom: 0;
      cursor: pointer;
    }
    .preview-section.preview-collapsed h3::after {
      content: "  \u25B8";  /* ▸ = 折りたたみ中 */
      color: var(--text-muted);
    }
    .preview-section.preview-collapsed .preview {
      display: none;
    }
    .preview-section::before {
      /* Soft gradient fade at the top edge so content scrolling
         behind the preview does not clip abruptly. */
      content: "";
      position: absolute;
      left: 0;
      right: 0;
      top: -14px;
      height: 14px;
      background: linear-gradient(to bottom, rgba(249, 250, 251, 0), var(--bg));
      pointer-events: none;
    }
    .preview-section h3 {
      margin: 0 0 6px 0;
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .preview {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas,
        "Liberation Mono", monospace;
      background: var(--bg-panel);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 12px 14px;
      font-size: 12px;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 22vh;
      min-height: 60px;
      overflow-y: auto;
      color: var(--text);
      scrollbar-width: thin;
      scrollbar-color: rgba(107, 114, 128, 0.25) transparent;
    }
    .preview::-webkit-scrollbar { width: 5px; }
    .preview::-webkit-scrollbar-track { background: transparent; }
    .preview::-webkit-scrollbar-thumb {
      background: rgba(107, 114, 128, 0.25);
      border-radius: 3px;
    }
    .preview::-webkit-scrollbar-thumb:hover {
      background: rgba(107, 114, 128, 0.4);
    }

    /* --- Footer ------------------------------------------------------ */
    footer {
      flex: 0 0 auto;
      padding: 12px 16px;
      border-top: 1px solid var(--border);
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      background: rgba(var(--bg-panel-rgb), 0.9);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
    }

    button.primary,
    button.secondary {
      font: inherit;
      font-size: 13px;
      padding: 8px 16px;
      border-radius: 8px;
      cursor: pointer;
      border: 1px solid transparent;
      transition: background var(--ease-fast), box-shadow var(--ease-fast),
        transform var(--ease-fast), border-color var(--ease-fast);
    }

    button.secondary {
      background: var(--bg-panel);
      border-color: var(--border);
      color: var(--text);
    }
    button.secondary:hover,
    button.secondary:focus-visible {
      background: var(--row-bg-hover);
      outline: none;
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
    }
    button.secondary:active {
      transform: scale(0.97);
      box-shadow: none;
    }

    button.primary {
      background: linear-gradient(135deg, var(--primary) 0%, var(--primary-hover) 100%);
      color: #ffffff;
      font-weight: 600;
      box-shadow: 0 1px 3px rgba(79, 70, 229, 0.3);
    }
    button.primary:hover,
    button.primary:focus-visible {
      background: linear-gradient(135deg, var(--primary-hover) 0%, var(--primary) 100%);
      outline: none;
      box-shadow: 0 2px 8px rgba(79, 70, 229, 0.35);
    }
    button.primary:active {
      transform: scale(0.97);
      box-shadow: 0 0 0 rgba(79, 70, 229, 0.2);
    }

    /* --- 全展開 / 全折畳 toggle ----------------------------------------- */
    .collapse-toggle {
      flex: 0 0 auto;
      align-self: flex-start;
      margin-bottom: 8px;
      padding: 4px 10px;
      border-radius: 12px;
      border: 1px solid var(--border);
      background: transparent;
      color: var(--text-muted);
      font-size: 10px;
      cursor: pointer;
      transition: background var(--ease-fast), color var(--ease-fast),
        border-color var(--ease-fast);
    }
    .collapse-toggle:hover,
    .collapse-toggle:focus-visible {
      background: var(--row-bg-hover);
      border-color: var(--primary);
      color: var(--text);
      outline: none;
    }

    /* --- Drop zone (drag text here to force-mask) ---------------------- */
    .drop-zone {
      flex: 0 0 auto;
      margin-bottom: 10px;
      padding: 10px 12px;
      border: 1px dashed var(--border);
      border-radius: 8px;
      background: var(--row-bg);
      color: var(--text-muted);
      font-size: 11px;
      text-align: center;
      transition: background var(--ease-fast), border-color var(--ease-fast),
        color var(--ease-fast);
      user-select: none;
    }
    .drop-zone.dragover {
      background: rgba(79, 70, 229, 0.08);
      border-color: var(--primary);
      color: var(--primary);
      border-style: solid;
    }
    .drop-zone .drop-hint {
      pointer-events: none;
    }

    /* --- Drop popover (category picker after drop) -------------------- */
    .drop-popover {
      flex: 0 0 auto;
      margin-bottom: 10px;
      padding: 12px;
      border: 1px solid var(--primary);
      border-radius: 8px;
      background: var(--bg-panel);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
      font-size: 12px;
    }
    .drop-popover-header {
      margin-bottom: 10px;
      line-height: 1.4;
    }
    .drop-popover-value {
      display: inline-block;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text);
      font-weight: 600;
      vertical-align: bottom;
    }
    .drop-popover-chips {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px;
      margin-bottom: 8px;
    }
    .drop-popover-chip {
      padding: 6px 8px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--row-bg);
      color: var(--text);
      font-size: 11px;
      cursor: pointer;
      text-align: left;
      transition: background var(--ease-fast), border-color var(--ease-fast),
        transform var(--ease-fast);
    }
    .drop-popover-chip:hover {
      border-color: var(--primary);
      background: rgba(79, 70, 229, 0.08);
    }
    .drop-popover-chip:active { transform: scale(0.97); }
    .drop-popover-chip[data-sev="critical"] { border-left: 3px solid var(--sev-critical); }
    .drop-popover-chip[data-sev="high"]     { border-left: 3px solid var(--sev-high); }
    .drop-popover-chip[data-sev="medium"]   { border-left: 3px solid var(--sev-medium); }
    .drop-popover-chip[data-sev="low"]      { border-left: 3px solid var(--sev-low); }
    .drop-popover-cancel {
      width: 100%;
      padding: 6px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: transparent;
      color: var(--text-muted);
      font-size: 11px;
      cursor: pointer;
    }
    .drop-popover-cancel:hover {
      background: var(--row-bg-hover);
      color: var(--text);
    }
    /* "既に検出済み" ポップオーバー: マッチしたラベル一覧 */
    .drop-popover-existing {
      list-style: none;
      padding: 0;
      margin: 0 0 10px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .drop-popover-existing li {
      padding: 6px 8px;
      border-radius: 6px;
      background: var(--row-bg);
      border-left: 3px solid var(--border);
      font-size: 11px;
      color: var(--text);
    }
    .drop-popover-existing li[data-sev="critical"] { border-left-color: var(--sev-critical); }
    .drop-popover-existing li[data-sev="high"]     { border-left-color: var(--sev-high); }
    .drop-popover-existing li[data-sev="medium"]   { border-left-color: var(--sev-medium); }
    .drop-popover-existing li[data-sev="low"]      { border-left-color: var(--sev-low); }
    .drop-popover-existing-label {
      font-weight: 600;
    }
    .drop-popover-existing-meta {
      color: var(--text-muted);
    }
    .drop-popover-actions {
      display: flex;
      gap: 6px;
      margin-bottom: 8px;
    }
    .drop-popover-action {
      flex: 1;
      padding: 6px 8px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--row-bg);
      color: var(--text);
      font-size: 11px;
      cursor: pointer;
      transition: background var(--ease-fast), border-color var(--ease-fast),
        transform var(--ease-fast);
    }
    .drop-popover-action:hover {
      border-color: var(--primary);
      background: rgba(79, 70, 229, 0.08);
    }
    .drop-popover-action:active { transform: scale(0.97); }
    .drop-popover-action.primary {
      background: var(--primary);
      color: white;
      border-color: var(--primary);
    }
    .drop-popover-action.primary:hover {
      background: var(--primary-hover);
      border-color: var(--primary-hover);
    }

    /* 該当行にジャンプした瞬間の一時ハイライト (2 秒フェード) */
    .row.flash-highlight {
      animation: mask-mcp-flash 2s ease-out;
    }
    @keyframes mask-mcp-flash {
      0%   { background: rgba(251, 191, 36, 0.55); box-shadow: 0 0 0 2px rgba(251, 191, 36, 0.4); }
      80%  { background: rgba(251, 191, 36, 0.12); box-shadow: 0 0 0 0 rgba(251, 191, 36, 0); }
      100% { background: transparent; box-shadow: none; }
    }
  `;

  // Normalise severity to one of the four tiers the CSS knows about.
  // Unknown values fall back to ``low`` so the UI never renders an
  // un-styled row even when a future server-side tier is added.
  const KNOWN_SEVERITIES = new Set(["critical", "high", "medium", "low"]);
  const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
  function normaliseSeverity(sev) {
    const s = String(sev || "").toLowerCase();
    return KNOWN_SEVERITIES.has(s) ? s : "low";
  }
  // Pick the highest-risk (lowest rank) severity from an iterable of
  // row states. Category headers render at this severity so the pill
  // reflects the worst offender in the group.
  function worstSeverity(rows) {
    let best = "low";
    let bestRank = SEVERITY_RANK.low;
    for (const row of rows) {
      const rank = SEVERITY_RANK[row.severity] ?? SEVERITY_RANK.low;
      if (rank < bestRank) {
        best = row.severity;
        bestRank = rank;
      }
    }
    return best;
  }

  // Internal model for one row. Built once in show() and mutated
  // in-place when the user toggles checkboxes.
  function buildRowState(entity) {
    return {
      key: rowKeyOf(entity),
      value: String(entity.value || ""),
      label: String(entity.label || "MASKED"),
      category: String(entity.category || "OTHER"),
      count: Number(entity.count) || (Array.isArray(entity.positions) ? entity.positions.length : 0),
      positions: Array.isArray(entity.positions)
        ? entity.positions
            .map((p) => (Array.isArray(p) ? [Number(p[0]), Number(p[1])] : null))
            .filter((p) => p && Number.isInteger(p[0]) && Number.isInteger(p[1]) && p[1] > p[0])
        : [],
      masked: entity.masked !== false, // default true
      locked: false, // set by show() after force_masked_categories is read
      severity: normaliseSeverity(entity.severity),
      // Gateway-computed ``<ENTITY_TYPE_N>`` placeholder so the row
      // preview shows the exact token the AI service will see.
      // Falls back to ``<LABEL>`` (unnumbered) when the server did
      // not emit one, e.g. if the extension is talking to an older
      // gateway build.
      placeholder: typeof entity.placeholder === "string" && entity.placeholder
        ? entity.placeholder
        : `<${String(entity.label || "MASKED")}>`,
      source: entity.source === "llm" ? "llm" : "regex",
    };
  }

  /**
   * Show the sidebar.
   *
   * @param {Object} aggregatedResponse - Shape:
   *   {
   *     original_text: string,
   *     aggregated: AggregatedEntity[],
   *     audit_id: string,
   *     force_masked_categories: string[],
   *   }
   * @param {string} originalText - Echo of the source text. Used both
   *   as a rendering fallback and to keep ``maskedPositions`` valid
   *   even if ``aggregatedResponse.original_text`` is mutated.
   * @returns {Promise<{
   *   accepted: boolean,
   *   maskedEntityKeys: Set<string>,
   *   maskedPositions: Array<[number, number, string]>,
   * }>}
   */
  async function show(aggregatedResponse, originalText, opts) {
    opts = opts || {};
    // Promise resolved when background LLM augmentation finishes. When
    // provided, we open the sidebar immediately with the regex-only
    // snapshot and re-render after the LLM merges in.
    const llmPending =
      opts.llmPending && typeof opts.llmPending.then === "function"
        ? opts.llmPending
        : null;
    const safeText =
      typeof originalText === "string"
        ? originalText
        : typeof aggregatedResponse?.original_text === "string"
        ? aggregatedResponse.original_text
        : "";
    const aggregated = Array.isArray(aggregatedResponse?.aggregated)
      ? aggregatedResponse.aggregated
      : [];
    const forcedCategories = new Set(
      Array.isArray(aggregatedResponse?.force_masked_categories)
        ? aggregatedResponse.force_masked_categories.map(String)
        : []
    );
    // 「意味として機密」な文 (engine/confidential.js)。マスク対象では
    // ないので aggregated とは別枠で受け取り、警告としてだけ描画する。
    const confidentialHits = Array.isArray(aggregatedResponse?.confidential)
      ? aggregatedResponse.confidential
      : [];

    // Short-circuit only when nothing to review AND no background LLM
    // work in flight — otherwise we'd miss entities the LLM will add.
    // 機密警告だけがある場合も開く: マスクすべき span はゼロでも
    // 「この文は送っていいのか」を問う価値があるのがこの機能の要点。
    if (aggregated.length === 0 && confidentialHits.length === 0 && !llmPending) {
      return {
        accepted: true,
        maskedEntityKeys: new Set(),
        maskedPositions: [],
      };
    }

    // Row/category structures are rebuilt inside applyAggregated() so
    // the sidebar can re-render when the LLM augmentation resolves.
    // Declared here (outer-scope ``let``) so closures created inside
    // the Promise body see reassignments automatically.
    let rows = [];
    let categoryOrder = [];
    let categoryMap = new Map(); // category name → array of rows

    return new Promise((resolve) => {
      // --- Push layout: wrap existing body children in a flex sibling ---
      // Instead of position:fixed (which overlays), we make <body> a
      // flex row. Existing content goes into a wrapper (flex:1) and the
      // sidebar host sits beside it (flex:0 0 auto). This keeps both
      // in the same document flow so they never overlap.
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-mask-mcp-wrapper", "");
      // ``transform: translateZ(0)`` + ``contain: layout`` together
      // promote the wrapper into a containing block for its fixed-
      // position descendants. Without this, ChatGPT / Claude composer
      // boxes and sticky headers (which use ``position: fixed``)
      // render relative to the VIEWPORT and extend across the sidebar
      // area, visually covering our panel. With the wrapper as a
      // containing block, those fixed elements use the wrapper's
      // (flex:1, narrower) box so they stay on the left and the
      // sidebar sits cleanly on the right.
      wrapper.style.cssText =
        "flex:1 1 0;min-width:0;overflow:auto;height:100vh;" +
        "transform:translateZ(0);contain:layout;position:relative;";
      while (document.body.firstChild) {
        wrapper.appendChild(document.body.firstChild);
      }
      document.body.appendChild(wrapper);
      document.body.style.cssText += ";display:flex!important;flex-direction:row!important;margin:0!important;overflow:hidden!important;height:100vh!important;width:100vw!important;";

      const host = document.createElement("div");
      host.setAttribute("data-mask-mcp-sidebar", "");
      host.style.all = "initial";
      host.style.display = "block";
      host.style.height = "100vh";
      // position: relative is REQUIRED for z-index to take effect.
      // Without it the host is a static element and chat UIs like
      // ChatGPT / Claude (with their own stacking contexts + z-index
      // on composers, modals, sticky headers) render ON TOP of our
      // sidebar. Anchoring + max z-index ensures we always win.
      host.style.position = "relative";
      host.style.zIndex = "2147483647";
      // Also create a local stacking context via isolation so any
      // descendant z-index values can never "leak" above the host.
      host.style.isolation = "isolate";

      function sidebarWidth() {
        // Target 400px; on narrow viewports shrink to max 50% so
        // both panes are usable. Never go below 280px (rows + pill
        // get unreadable). On very small screens (<560px total)
        // the math yields 50% which is ~280 — still usable.
        const vw = window.innerWidth;
        const target = 400;
        const maxShare = Math.floor(vw * 0.5);
        const minPx = Math.min(280, Math.floor(vw * 0.5));
        return Math.max(minPx, Math.min(target, maxShare));
      }
      function applySidebarLayout() {
        const sw = sidebarWidth();
        host.style.width = sw + "px";
        host.style.minWidth = sw + "px";
        host.style.maxWidth = sw + "px";
        host.style.flex = `0 0 ${sw}px`;
        // Give wrapper an EXPLICIT pixel width (calc) so chat frames
        // that declare width: 100vw can't override flex:1 and overflow
        // past the sidebar boundary. The chat becomes exactly
        // (100vw - sw)px wide, sidebar is sw px wide, total = 100vw.
        wrapper.style.width = `calc(100vw - ${sw}px)`;
        wrapper.style.maxWidth = `calc(100vw - ${sw}px)`;
        wrapper.style.flex = "1 1 auto";
        // Keep a CSS custom property + global style rule so any chat
        // child that uses `width: 100vw` or `right: 0` with
        // `position: fixed` gets rewritten to respect the narrower
        // viewport. See globalLayoutStyle below.
        globalLayoutStyle.textContent =
          ":root{--mmcp-sidebar-w:" + sw + "px}" +
          "[data-mask-mcp-wrapper] *{max-width:100%!important}" +
          "[data-mask-mcp-wrapper]{contain:layout}";
      }
      // Style element INSIDE document (not shadow DOM) so its rules
      // reach chat-app descendants. Content set by applySidebarLayout.
      const globalLayoutStyle = document.createElement("style");
      globalLayoutStyle.setAttribute("data-mask-mcp-layout", "");
      document.head.appendChild(globalLayoutStyle);
      const shadow = host.attachShadow({ mode: "open" });

      const style = document.createElement("style");
      style.textContent = STYLE;
      shadow.appendChild(style);

      const root = document.createElement("div");
      root.className = "root";
      root.setAttribute("role", "dialog");
      root.setAttribute("aria-modal", "true");
      root.setAttribute("aria-labelledby", "mcp-sb-title");

      // Detect page background and apply matching theme.
      (function applyTheme() {
        try {
          const candidates = [
            document.body,
            document.documentElement,
            document.querySelector("main"),
            document.querySelector("[class*=chat]"),
            document.querySelector("[class*=conversation]"),
          ].filter(Boolean);
          let bgColor = "rgb(255,255,255)";
          for (const el of candidates) {
            const cs = getComputedStyle(el);
            const bg = cs.backgroundColor;
            if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
              bgColor = bg;
              break;
            }
          }
          const m = bgColor.match(/\d+/g);
          const r = parseInt(m[0], 10);
          const g = parseInt(m[1], 10);
          const b = parseInt(m[2], 10);
          const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
          const isDark = luminance < 0.5;
          root.classList.add(isDark ? "dark" : "light");
          root.style.setProperty("--site-bg", bgColor);
        } catch (_) {
          root.classList.add("light");
        }
      })();

      // Push layout — no overlay. The host element is constrained to
      // 400px on the right edge so the chat area stays fully interactive.

      const panel = document.createElement("div");
      panel.className = "panel";
      panel.setAttribute("tabindex", "-1");

      const header = document.createElement("header");
      const title = document.createElement("h2");
      title.id = "mcp-sb-title";
      title.textContent = "マスク対象の確認";

      // Mode indicator pill — reflects the active detection flow so
      // the user knows whether regex alone, regex+LLM, or AI-replace
      // is driving this review.
      const modeLabel = (() => {
        const m = opts.mode;
        if (m === "replace") return "AI 置換 (実験的)";
        if (m === "detect")  return "検出補助 (Regex + AI)";
        return "Regex のみ";
      })();
      const modeCls = (() => {
        if (opts.mode === "replace") return "mode-replace";
        if (opts.mode === "detect")  return "mode-detect";
        return "mode-regex";
      })();
      const modePill = document.createElement("span");
      modePill.className = "mode-pill " + modeCls;
      modePill.textContent = modeLabel;

      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "close-btn";
      closeBtn.setAttribute("aria-label", "閉じる");
      closeBtn.textContent = "\u00d7"; // ×
      header.appendChild(title);
      header.appendChild(modePill);
      header.appendChild(closeBtn);

      const body = document.createElement("div");
      body.className = "body";

      const bulkBar = document.createElement("div");
      bulkBar.className = "bulk-bar";
      const selectAllBtn = document.createElement("button");
      selectAllBtn.type = "button";
      selectAllBtn.className = "bulk-btn";
      selectAllBtn.textContent = "すべて選択";
      const deselectAllBtn = document.createElement("button");
      deselectAllBtn.type = "button";
      deselectAllBtn.className = "bulk-btn";
      deselectAllBtn.textContent = "すべて解除";
      bulkBar.appendChild(selectAllBtn);
      bulkBar.appendChild(deselectAllBtn);
      body.appendChild(bulkBar);

      // --- Hold-duration slider ---
      let lockHoldMs = 1000;
      const holdSliderBar = document.createElement("div");
      holdSliderBar.className = "hold-slider-bar";
      const holdLabel = document.createElement("label");
      holdLabel.textContent = "\ud83d\udd12 解除長押し";
      const holdSlider = document.createElement("input");
      holdSlider.type = "range";
      holdSlider.min = "0";
      holdSlider.max = "1.5";
      holdSlider.step = "0.1";
      holdSlider.value = "1";
      const holdVal = document.createElement("span");
      holdVal.className = "hold-val";
      holdVal.textContent = "1s";
      holdSlider.addEventListener("input", () => {
        lockHoldMs = Math.round(parseFloat(holdSlider.value) * 1000);
        holdVal.textContent = holdSlider.value + "s";
        // Per-row .row-lock hints were removed — nothing to update
        // in the category list. lockHoldMs is picked up on next
        // pointerdown via getHoldMs() inside the row's onDown.
      });
      holdSliderBar.appendChild(holdLabel);
      holdSliderBar.appendChild(holdSlider);
      holdSliderBar.appendChild(holdVal);
      body.appendChild(holdSliderBar);

      // --- Severity filter tabs ---
      const sevTabs = document.createElement("div");
      sevTabs.className = "sev-tabs";
      let activeFilter = "all";
      const SEV_KEYS = ["all", "critical", "high", "medium", "low"];
      const SEV_LABELS = { all: "All", critical: "Critical", high: "High", medium: "Medium", low: "Low" };
      for (const key of SEV_KEYS) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "sev-tab" + (key === "all" ? " active" : "");
        btn.dataset.sev = key;
        btn.textContent = SEV_LABELS[key];
        btn.addEventListener("click", () => {
          activeFilter = key;
          for (const t of sevTabs.children) t.classList.remove("active");
          btn.classList.add("active");
          applySevFilter();
        });
        sevTabs.appendChild(btn);
      }
      body.appendChild(sevTabs);

      // --- 全展開 / 全折畳トグル ---
      // カテゴリは標準で折りたたみ状態なので、一発で全部見たい場合や
      // 逆に畳み直したいケースに対応する小さなリンクを 1 本置く。
      const collapseToggle = document.createElement("button");
      collapseToggle.type = "button";
      collapseToggle.className = "collapse-toggle";
      collapseToggle.textContent = "\u25BE\u3000\u3059\u3079\u3066\u5C55\u958B"; // ▾ すべて展開
      collapseToggle.setAttribute("aria-label", "\u30AB\u30C6\u30B4\u30EA\u306E\u4E00\u62EC\u5C55\u958B / \u6298\u308A\u305F\u305F\u307F");
      let allExpanded = false;
      collapseToggle.addEventListener("click", () => {
        allExpanded = !allExpanded;
        const cats = categoriesWrap.querySelectorAll(".category");
        for (const c of cats) {
          if (allExpanded) c.classList.remove("is-collapsed");
          else c.classList.add("is-collapsed");
        }
        collapseToggle.textContent = allExpanded
          ? "\u25B8\u3000\u3059\u3079\u3066\u6298\u308A\u305F\u305F\u3080" // ▸ すべて折りたたむ
          : "\u25BE\u3000\u3059\u3079\u3066\u5C55\u958B";                // ▾ すべて展開
      });
      body.appendChild(collapseToggle);

      // --- Drop zone + category popover ---
      // サイドバー全体を drop target にしつつ、視覚ヒントとして
      // 常に見える細いバーを置く。drop 発生時に category 選択
      // popover に切り替わる。
      const dropZone = document.createElement("div");
      dropZone.className = "drop-zone";
      const dropHint = document.createElement("span");
      dropHint.className = "drop-hint";
      dropHint.textContent = "\u2795 チャットのテキストをここにドラッグしてマスク対象に追加";
      dropZone.appendChild(dropHint);
      body.appendChild(dropZone);

      const dropPopover = document.createElement("div");
      dropPopover.className = "drop-popover";
      dropPopover.hidden = true;
      body.appendChild(dropPopover);

      function setPreviewCollapsed(flag) {
        // previewSection はこの関数よりも後で生成されるので、closure 経由で
        // ランタイム時に参照する。undefined の間 (初期描画中に誤って呼ばれた
        // 場合) は黙って no-op。
        const ps = typeof previewSection !== "undefined" ? previewSection : null;
        if (!ps) return;
        ps.classList.toggle("preview-collapsed", !!flag);
      }

      function closeDropPopover() {
        dropPopover.replaceChildren();
        dropPopover.hidden = true;
        setPreviewCollapsed(false);
      }

      // ドロップされた value が既に検出済みの aggregated row と一致するか
      // 走査する。完全一致 (case-sensitive) でマッチさせる — 既存 force-mask
      // の match 戦略と揃える。同じ value で複数ラベル (PERSON + JP_SURNAME
      // の重複など) がヒットすることもあるので配列で返す。
      function findExistingMatches(value) {
        if (!value || !Array.isArray(rows) || rows.length === 0) return [];
        return rows.filter((r) => r && r.value === value);
      }

      // 該当行までスクロール + ハイライト。rowControls Map 経由で DOM ノード
      // を取得できるので、scrollIntoView + 一時クラス付与で視覚的に示す。
      function scrollToAndFlashRow(rowKey) {
        const ctl = rowControls.get(rowKey);
        // Map の値は { checkbox, control: { element, ... }, row, setState }。
        // DOM 要素は ctl.control.element (ctl.row はデータオブジェクト)。
        const rowEl = ctl && ctl.control && ctl.control.element;
        if (!rowEl || typeof rowEl.closest !== "function") return;
        // 対象行が折りたたまれているカテゴリ配下なら自動で展開してから
        // スクロール。section.category → 親を辿って is-collapsed を解除。
        const categoryEl = rowEl.closest(".category");
        if (categoryEl && categoryEl.classList.contains("is-collapsed")) {
          categoryEl.classList.remove("is-collapsed");
        }
        try {
          rowEl.scrollIntoView({ behavior: "smooth", block: "center" });
        } catch (_) {
          rowEl.scrollIntoView();
        }
        rowEl.classList.add("flash-highlight");
        setTimeout(() => {
          rowEl.classList.remove("flash-highlight");
        }, 2000);
      }

      // 既存検出マッチ時は popover を出さず、scrollToAndFlashRow で
      // 行を直接ハイライトする方針 (見づらさ軽減)。
      // 旧 showExistingDetectionPopover は onDrop 内で直接呼ばないため削除。

      function openDropPopover(value) {
        setPreviewCollapsed(true);
        dropPopover.replaceChildren();
        const header = document.createElement("div");
        header.className = "drop-popover-header";
        const valEl = document.createElement("div");
        valEl.className = "drop-popover-value";
        valEl.textContent = '"' + value + '"';
        valEl.title = value;
        const hint = document.createElement("small");
        hint.textContent = " をマスクするカテゴリを選択:";
        header.appendChild(valEl);
        header.appendChild(hint);
        dropPopover.appendChild(header);

        const chipsWrap = document.createElement("div");
        chipsWrap.className = "drop-popover-chips";
        // category → default severity (sidebar 色付けと一致)
        const CAT_CHOICES = [
          { cat: "PERSON", sev: "high", label: "人名 / PERSON" },
          { cat: "LOCATION", sev: "medium", label: "地名 / LOCATION" },
          { cat: "ORGANIZATION", sev: "medium", label: "組織 / ORGANIZATION" },
          { cat: "CONTACT", sev: "high", label: "連絡先 / CONTACT" },
          { cat: "FINANCIAL", sev: "critical", label: "金融 / FINANCIAL" },
          { cat: "CREDENTIAL", sev: "critical", label: "認証 / CREDENTIAL" },
          { cat: "IDENTITY", sev: "low", label: "属性 / IDENTITY" },
          { cat: "INTERNAL_ID", sev: "medium", label: "社内 ID" },
          { cat: "OTHER", sev: "medium", label: "その他" },
        ];
        for (const { cat, sev, label } of CAT_CHOICES) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "drop-popover-chip";
          btn.dataset.sev = sev;
          btn.dataset.cat = cat;
          btn.textContent = label + " (" + sev + ")";
          btn.addEventListener("click", () => {
            // content.js へ直接通知 (allowlist と同じルート)
            try {
              window.postMessage({
                source: "mask-mcp-inpage",
                type: "add-forcelist",
                value,
                category: cat,
              }, "*");
            } catch (_) {}
            closeDropPopover();
          });
          chipsWrap.appendChild(btn);
        }
        dropPopover.appendChild(chipsWrap);

        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "drop-popover-cancel";
        cancel.textContent = "キャンセル";
        cancel.addEventListener("click", closeDropPopover);
        dropPopover.appendChild(cancel);
        dropPopover.hidden = false;
      }

      // panel 全体で drag を受ける。dragover の preventDefault を
      // 呼ばないと drop が発生しないので、全イベントで抑止する。
      const onDragEnter = (e) => {
        e.preventDefault();
        dropZone.classList.add("dragover");
      };
      const onDragOver = (e) => { e.preventDefault(); };
      const onDragLeave = (e) => {
        // panel 外に出るタイミング以外でも leave が fire することがあるので、
        // ターゲットが panel 外のときだけハイライトを解除。
        if (!panel.contains(e.relatedTarget)) {
          dropZone.classList.remove("dragover");
        }
      };
      const onDrop = (e) => {
        e.preventDefault();
        dropZone.classList.remove("dragover");
        const raw = e.dataTransfer && e.dataTransfer.getData("text/plain");
        const value = typeof raw === "string" ? raw.trim() : "";
        if (!value) return;
        const existing = findExistingMatches(value);
        if (existing.length > 0) {
          // 既に検出済みの場合は popover を経由せず、その行まで直接
          // スクロール + 黄色フラッシュ。複数マッチは先頭を採用。
          // 親カテゴリが折りたたみ状態なら scrollToAndFlashRow 側で
          // 自動展開してくれる。
          scrollToAndFlashRow(existing[0].key);
        } else {
          openDropPopover(value);
        }
      };
      panel.addEventListener("dragenter", onDragEnter);
      panel.addEventListener("dragover", onDragOver);
      panel.addEventListener("dragleave", onDragLeave);
      panel.addEventListener("drop", onDrop);

      function applySevFilter() {
        const cats = categoriesWrap.querySelectorAll(".category");
        for (const cat of cats) {
          const rows = cat.querySelectorAll(".row");
          let visibleCount = 0;
          for (const r of rows) {
            const show = activeFilter === "all" || r.dataset.severity === activeFilter;
            r.style.display = show ? "" : "none";
            if (show) visibleCount++;
          }
          cat.style.display = visibleCount > 0 ? "" : "none";
        }
      }

      // Track the DOM nodes per row/category so toggles can reach the
      // corresponding checkboxes without touching textContent.
      const rowControls = new Map(); // key → { checkbox, row }
      const categoryControls = new Map(); // category → { toggle, all rows[] }

      function renderCategory(categoryName) {
        const items = categoryMap.get(categoryName) || [];
        const wrap = document.createElement("section");
        wrap.className = "category";
        // デフォルトは折りたたみ状態で描画 — 検出件数が多いときに
        // リスト全体が縦に伸びて該当行を探しづらくなる問題への対処。
        // 「全展開」ボタンで一括展開、該当行ジャンプ時はそのカテゴリ
        // だけ自動展開される (後述 scrollToAndFlashRow を参照)。
        wrap.classList.add("is-collapsed");
        const isLocked = items.every((r) => r.locked) && items.length > 0;
        if (isLocked) wrap.classList.add("is-locked");

        const head = document.createElement("div");
        head.className = "category-header";
        head.setAttribute("role", "button");
        head.setAttribute("tabindex", "0");

        const twisty = document.createElement("span");
        twisty.className = "twisty";
        twisty.textContent = "\u25be"; // ▾

        const name = document.createElement("span");
        name.className = "category-name";
        const nameLabel = document.createElement("span");
        nameLabel.textContent = categoryName;
        name.appendChild(nameLabel);
        // Category severity = worst severity of any row in the group.
        // Renders the same pill style as individual rows so the user
        // can tell at a glance that a PERSON group is actually critical
        // because it hides an API_KEY.
        const groupSeverity = worstSeverity(items);
        wrap.classList.add(`cat-sev-${groupSeverity}`);
        const groupPill = document.createElement("span");
        groupPill.className = `sev-pill sev-${groupSeverity}`;
        groupPill.textContent = groupSeverity;
        name.appendChild(groupPill);
        if (forcedCategories.has(categoryName)) {
          const lockIcon = document.createElement("span");
          lockIcon.className = "lock-icon";
          lockIcon.title = "force-mask: ロック中";
          lockIcon.textContent = "\ud83d\udd12"; // 🔒
          name.appendChild(lockIcon);
        }
        const cnt = document.createElement("span");
        cnt.className = "category-count";
        cnt.textContent = `(${items.length}件)`;
        name.appendChild(cnt);

        const toggle = document.createElement("input");
        toggle.type = "checkbox";
        toggle.className = "category-toggle";
        toggle.setAttribute("aria-label", `${categoryName} を一括切り替え`);
        if (forcedCategories.has(categoryName)) {
          toggle.disabled = true;
          toggle.checked = true;
        }

        // Clicks on the header (but not the toggle) collapse/expand.
        head.appendChild(twisty);
        head.appendChild(name);
        head.appendChild(toggle);

        head.addEventListener("click", (event) => {
          if (event.target === toggle) return;
          wrap.classList.toggle("is-collapsed");
        });
        head.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            wrap.classList.toggle("is-collapsed");
          }
        });

        toggle.addEventListener("click", (event) => {
          event.stopPropagation();
        });
        toggle.addEventListener("change", (event) => {
          if (toggle.disabled) return;
          const checked = !!toggle.checked;
          // Unchecking a category MUST NOT bypass the long-press
          // guard on individual critical rows. If the user is trying
          // to turn the category OFF and any child is critical, run
          // the same native confirm() path the "すべて解除" button
          // uses; on accept, we only clear the non-critical children.
          if (!checked) {
            const criticalKids = items.filter(
              (r) => !r.locked && r.severity === "critical"
            );
            if (criticalKids.length > 0) {
              const cleared = confirmCriticalBulkUncheck(criticalKids.length);
              if (!cleared) {
                // Restore the toggle to match the un-changed row
                // state — user declined, nothing was cleared.
                syncCategoryToggle(categoryName);
                return;
              }
              // Proceed, but leave critical rows masked=true.
              for (const row of items) {
                if (row.locked) continue;
                if (row.severity === "critical") continue;
                row.masked = false;
                const ctl = rowControls.get(row.key);
                if (ctl) ctl.control.setOn(false);
              }
              syncCategoryToggle(categoryName);
              updatePreview();
              return;
            }
          }
          for (const row of items) {
            if (row.locked) continue;
            row.masked = checked;
            const ctl = rowControls.get(row.key);
            if (ctl) ctl.control.setOn(checked);
          }
          syncCategoryToggle(categoryName);
          updatePreview();
        });

        const rowsWrap = document.createElement("div");
        rowsWrap.className = "rows";
        for (const row of items) {
          rowsWrap.appendChild(renderRow(row));
        }

        wrap.appendChild(head);
        wrap.appendChild(rowsWrap);

        categoryControls.set(categoryName, { toggle, items });
        return wrap;
      }

      function renderRow(row) {
        const id = `mcp-sb-${row.key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
        const isCritical = row.severity === "critical";

        // New layout: every row is a ``<div>`` with the whole surface
        // being the interactive target. Critical rows attach a long-
        // press gesture handler to the div itself (not to a tiny SVG
        // ring) so the user can press anywhere on the row. Non-critical
        // rows toggle on a single click/tap.
        const wrap = document.createElement("div");
        wrap.className = `row sev-${row.severity}${row.masked ? "" : " is-unmasked"}`;
        wrap.dataset.severity = row.severity;
        wrap.setAttribute("role", "switch");
        wrap.setAttribute("tabindex", "0");
        wrap.setAttribute("aria-checked", row.masked ? "true" : "false");
        wrap.setAttribute(
          "aria-label",
          `${row.value} を${isCritical ? "長押しで" : "クリックで"}切り替え`
        );

        // Hidden checkbox — kept in the DOM so Tab focus + aria state
        // map cleanly, and so the rest of the sidebar's bulk-action
        // code can still address it via ``rowControls.checkbox``.
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "row-checkbox";
        checkbox.id = id;
        checkbox.checked = row.masked;
        checkbox.dataset.rowKey = row.key;
        if (row.locked) {
          checkbox.disabled = true;
          checkbox.checked = true;
        }
        wrap.appendChild(checkbox);

        // Long-press progress fill (critical only, absolute-positioned
        // behind the text; width animates 0% → 100% during a hold).
        let fill = null;
        if (isCritical || row.locked) {
          fill = document.createElement("div");
          fill.className = "lp-fill";
          if (row.locked) fill.style.background = "var(--sev-critical-bg)";
          wrap.appendChild(fill);
        }

        // ----- Line 1: 🔑 value → <PLACEHOLDER> ------------------------
        const line1 = document.createElement("div");
        line1.className = "row-line1";

        // Row icon picks the most specific marker:
        //   🔒 locked (force-masked)
        //   ✨ LLM-detected (overrides critical/non-critical)
        //   🔑 critical
        //   🔍 non-critical
        // Row-level icon:
        //   ✨ LLM-detected
        //   🔑 critical
        //   🔍 non-critical
        // The 🔒 lock glyph is intentionally NOT used here — it's
        // already shown on the category header for force-masked
        // categories, and peppering it on every child row creates
        // visual noise ("鍵マークが散見している" per user feedback).
        const icon = document.createElement("span");
        icon.className = "row-icon";
        if (row.source === "llm") icon.classList.add("is-llm");
        icon.textContent =
          row.source === "llm"
            ? "\u2728"              // ✨ AI-detected
            : isCritical
              ? "\ud83d\udd11"      // 🔑 critical
              : "\ud83d\udd0d";     // 🔍 non-critical
        line1.appendChild(icon);

        const value = document.createElement("span");
        value.className = "row-value";
        value.textContent = row.value;
        value.title = row.value;
        line1.appendChild(value);

        const arrow = document.createElement("span");
        arrow.className = "row-arrow";
        arrow.textContent = "\u2192"; // →
        line1.appendChild(arrow);

        const ph = document.createElement("span");
        ph.className = "row-placeholder";
        const phText = row.placeholder || `<${row.label}>`;
        ph.textContent = phText;
        ph.title = phText;
        line1.appendChild(ph);

        // ----- Line 2: N件 · [SEV] · 🔒 長押しで解除 -------------------
        const line2 = document.createElement("div");
        line2.className = "row-line2";

        const count = document.createElement("span");
        count.className = "row-count";
        count.textContent = `出現回数 ${row.count}回`;
        count.title = `この値が入力テキスト中に ${row.count} 回出現`;
        line2.appendChild(count);

        if (row.source === "llm") {
          const dotLlm = document.createElement("span");
          dotLlm.textContent = "·";
          line2.appendChild(dotLlm);
          const llmBadge = document.createElement("span");
          llmBadge.className = "row-llm-badge";
          llmBadge.textContent = "AI 検出";
          llmBadge.title = "ローカル LLM が文脈から検出した候補";
          llmBadge.setAttribute("aria-label", "AI 検出項目");
          line2.appendChild(llmBadge);
        }

        // Locked rows no longer get an individual 🔒 hint on line 2
        // — the category header already carries the lock icon for
        // the whole group. See renderCategory() above.

        // USER_DEFINED_* 行はユーザー自身がドラッグで追加した force-mask
        // entry。除外ボタンは「削除」挙動 (storage から entry を消す) に
        // 切り替える。通常の検出行は従来通り allowlist 追加。
        const isUserForceRow = typeof row.label === "string"
          && row.label.startsWith("USER_DEFINED_");
        const excludeBtn = document.createElement("button");
        excludeBtn.className = "exclude-btn";
        excludeBtn.textContent = isUserForceRow
          ? "\u2716 \u524a\u9664"   // ✖ 削除
          : "\u2716 \u9664\u5916";  // ✖ 除外
        excludeBtn.title = isUserForceRow
          ? "force-mask list \u304B\u3089\u524A\u9664"
          : "\u30DE\u30B9\u30AD\u30F3\u30B0\u4E0D\u8981\u30EA\u30B9\u30C8\u306B\u8FFD\u52A0";
        excludeBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          try {
            if (isUserForceRow) {
              // label の USER_DEFINED_ プレフィックスを剥がして元カテゴリを復元
              const cat = row.label.replace(/^USER_DEFINED_/, "") || "OTHER";
              window.postMessage({
                source: "mask-mcp-inpage",
                type: "remove-forcelist",
                value: row.value,
                category: cat,
              }, "*");
            } else {
              window.postMessage({
                source: "mask-mcp-inpage",
                type: "add-allowlist",
                value: row.value,
              }, "*");
            }
          } catch (_) {}
          setState(false);
          excludeBtn.textContent = isUserForceRow
            ? "\u2714 \u524a\u9664\u6E08"   // ✔ 削除済
            : "\u2714 \u9664\u5916\u6E08";  // ✔ 除外済
          excludeBtn.disabled = true;
        });
        line2.appendChild(excludeBtn);

        wrap.appendChild(line1);
        wrap.appendChild(line2);

        // ------ Interaction wiring ---------------------------------
        const syncAria = () => {
          wrap.setAttribute("aria-checked", row.masked ? "true" : "false");
          wrap.classList.toggle("is-unmasked", !row.masked);
        };

        const baseIcon = row.source === "llm"
          ? "\u2728"                 // ✨
          : isCritical
            ? "\ud83d\udd11"         // 🔑
            : "\ud83d\udd0d";        // 🔍

        const unlockRow = () => {
          row.locked = false;
          checkbox.disabled = false;
          // Icon stays as the severity/LLM marker — the 🔒 only ever
          // lived on the category header.
          icon.textContent = baseIcon;
          wrap.classList.remove("is-locked");
          const catEl = wrap.closest(".category");
          if (catEl) catEl.classList.remove("is-locked");
        };

        const setState = (next) => {
          if (row.locked) unlockRow();
          row.masked = !!next;
          checkbox.checked = row.masked;
          syncAria();
          syncCategoryToggle(row.category);
          updatePreview();
        };

        // Interaction model (per user spec):
        //   * critical + masked → long-press to UNMASK. Short tap is
        //     a deliberate no-op (safety against accidental exposure).
        //   * critical + unmasked → ONE tap to RE-MASK.
        //   * Everything else (locked force-masked, high, medium, low)
        //     → plain one-tap toggle for both lock and unlock.
        // Force-locked rows go through setState → unlockRow on first
        // tap which removes is-locked and toggles masked in one shot.
        const requiresHold = () => isCritical && row.masked;

        if (!isCritical) {
          // Non-critical, non-locked path: plain click toggle.
          wrap.addEventListener("click", () => setState(!row.masked));
          wrap.addEventListener("keydown", (event) => {
            if (event.key === " " || event.key === "Enter") {
              event.preventDefault();
              setState(!row.masked);
            }
          });
        } else {
          // Critical OR locked path: single pointer-based state
          // machine. We do NOT attach a click listener at all —
          // everything is decided at pointerup so there's no
          // possibility of click+pointerdown interfering.
          const getHoldMs = () => lockHoldMs;
          let timerId = null;
          let tickId = null;
          let startedAt = 0;
          let holdFired = false;

          const resetFill = () => {
            if (!fill) return;
            fill.style.transition = "width 0.2s ease-out";
            fill.style.width = "0%";
          };
          const clearTimers = () => {
            if (timerId !== null) { clearTimeout(timerId); timerId = null; }
            if (tickId !== null) { clearInterval(tickId); tickId = null; }
          };
          const beginHold = (event) => {
            if (event && event.preventDefault) event.preventDefault();
            startedAt = Date.now();
            holdFired = false;
            if (fill) {
              fill.style.transition = "width 0.05s linear";
              fill.style.width = "0%";
            }
            try {
              if (event && event.pointerId !== undefined) {
                wrap.setPointerCapture(event.pointerId);
              }
            } catch (_) { /* Safari */ }
            const ms = getHoldMs();
            const doToggle = () => {
              clearTimers();
              holdFired = true;
              if (fill) fill.style.width = "100%";
              const wasLocked = row.locked;
              wrap.classList.add("long-press-pulse");
              setTimeout(() => wrap.classList.remove("long-press-pulse"), 450);
              setState(!row.masked);
              if (wasLocked) {
                wrap.classList.add("unlock-flash");
                setTimeout(() => wrap.classList.remove("unlock-flash"), 600);
              }
              setTimeout(resetFill, 350);
            };
            if (ms === 0) {
              doToggle();
              return;
            }
            tickId = setInterval(() => {
              const elapsed = Math.min(ms, Date.now() - startedAt);
              if (fill) fill.style.width = (elapsed / ms) * 100 + "%";
            }, 50);
            timerId = setTimeout(doToggle, ms);
          };

          const onDown = (event) => {
            if (timerId !== null) return; // already holding
            holdFired = false;
            if (requiresHold()) {
              beginHold(event);
            }
            // else: wait for pointerup — it's a click path
          };
          const onUp = () => {
            const wasHolding = timerId !== null;
            clearTimers();
            resetFill();
            if (holdFired) {
              // doToggle already ran → nothing more to do
              return;
            }
            if (wasHolding) {
              // User released before hold completed → cancel, no toggle
              return;
            }
            // Short tap, no hold ran. Toggle ONLY when hold wasn't
            // required (i.e. critical + unmasked → one-click re-mask).
            if (!requiresHold()) {
              setState(!row.masked);
            }
          };

          wrap.addEventListener("pointerdown", onDown);
          wrap.addEventListener("pointerup", onUp);
          wrap.addEventListener("pointercancel", () => {
            clearTimers();
            resetFill();
            holdFired = false;
          });
          wrap.addEventListener("pointerleave", () => {
            clearTimers();
            resetFill();
          });

          // Keyboard mirrors the pointer state machine.
          let keyHeld = false;
          wrap.addEventListener("keydown", (event) => {
            if ((event.key === " " || event.key === "Enter") && !keyHeld) {
              event.preventDefault();
              keyHeld = true;
              onDown({ pointerId: -1, preventDefault() {} });
            }
          });
          wrap.addEventListener("keyup", (event) => {
            if (event.key === " " || event.key === "Enter") {
              event.preventDefault();
              keyHeld = false;
              onUp();
            }
          });
        }

        rowControls.set(row.key, {
          checkbox,
          control: {
            element: wrap,
            isOn: () => !!row.masked,
            setOn: (next) => {
              if (row.locked) return;
              row.masked = !!next;
              checkbox.checked = row.masked;
              syncAria();
            },
          },
          row,
          setState,
        });
        return wrap;
      }

      function syncCategoryToggle(categoryName) {
        const ctl = categoryControls.get(categoryName);
        if (!ctl) return;
        if (ctl.toggle.disabled) return; // locked categories stay checked
        const total = ctl.items.length;
        const checked = ctl.items.filter((r) => r.masked).length;
        if (checked === 0) {
          ctl.toggle.checked = false;
          ctl.toggle.indeterminate = false;
        } else if (checked === total) {
          ctl.toggle.checked = true;
          ctl.toggle.indeterminate = false;
        } else {
          ctl.toggle.checked = false;
          ctl.toggle.indeterminate = true;
        }
      }

      function collectKeepers() {
        // Build the [start, end, label] triples for the rows the user
        // wants masked. Each row contributes one triple per occurrence.
        const triples = [];
        for (const row of rows) {
          if (!row.masked) continue;
          for (const [s, e] of row.positions) {
            triples.push([s, e, row.label]);
          }
        }
        return triples;
      }

      function updatePreview() {
        const triples = collectKeepers();
        previewBox.textContent = applyMasks(safeText, triples);
      }

      // Render every category into a dedicated scroll region. The
      // ``.categories`` wrapper gets ``flex: 1 1 auto; overflow-y: auto``
      // from the stylesheet so only the category list scrolls while
      // the preview below stays pinned in view. We create an empty
      // wrapper here — applyAggregated() below fills it, and re-fills
      // it when the LLM augmentation resolves.
      // --- 機密の可能性がある文の警告 (engine/confidential.js) ------------
      // マスク候補の一覧より **上** に、カテゴリとは独立して出す。
      // これらは置換しない — 置換すると送りたい文そのものが壊れるので、
      // 「送る前に読み直して」とだけ伝えるのがこの UI の役割。
      if (confidentialHits.length > 0) {
        const warn = document.createElement("div");
        warn.className = "confidential-warning";
        const h = document.createElement("div");
        h.className = "confidential-warning-title";
        h.textContent = `⚠ 機密の可能性がある記述が ${confidentialHits.length} 件`;
        warn.appendChild(h);

        const lead = document.createElement("p");
        lead.className = "confidential-warning-lead";
        lead.textContent =
          "以下はマスクされません。送信してよいか確認してください。";
        warn.appendChild(lead);

        for (const hit of confidentialHits) {
          const item = document.createElement("div");
          item.className = "confidential-item";

          const quote = document.createElement("div");
          quote.className = "confidential-quote";
          quote.textContent = hit.text.trim();
          item.appendChild(quote);

          // なぜ引っかかったかを必ず見せる。理由の見えない警告は
          // 「また出た」で無視されるようになる。
          const why = document.createElement("div");
          why.className = "confidential-why";
          const reasons = [];
          if (hit.signals?.explicit) reasons.push(`機密表示: ${hit.signals.explicit}`);
          if (hit.signals?.topic) reasons.push(`話題: ${hit.signals.topic}`);
          if (hit.signals?.secrecy) reasons.push(`非公開: ${hit.signals.secrecy}`);
          if (hit.signals?.prospective) reasons.push(`未確定: ${hit.signals.prospective}`);
          why.textContent = reasons.join(" / ");
          if (reasons.length > 0) item.appendChild(why);

          warn.appendChild(item);
        }

        const note = document.createElement("p");
        note.className = "confidential-warning-note";
        note.textContent =
          "明示的な機密表示と定型的な言い回しのみ検出します。言い換えられた機密は検出できません。";
        warn.appendChild(note);

        body.appendChild(warn);
      }

      const categoriesWrap = document.createElement("div");
      categoriesWrap.className = "categories";
      body.appendChild(categoriesWrap);

      // --- Preview pane (pinned at the bottom of .body) --------------------
      const previewSection = document.createElement("div");
      previewSection.className = "preview-section";
      const previewTitle = document.createElement("h3");
      previewTitle.textContent = "プレビュー";
      // 折りたたみ中に見出しをクリックしたら即座に展開できる。
      // openDropPopover 側が自動で畳んだ状態でもユーザーが明示的に
      // peek できる逃げ道を確保する。
      previewTitle.addEventListener("click", () => {
        if (previewSection.classList.contains("preview-collapsed")) {
          previewSection.classList.remove("preview-collapsed");
        }
      });
      const previewBox = document.createElement("div");
      previewBox.className = "preview";
      previewBox.id = "mcp-sb-preview";
      previewSection.appendChild(previewTitle);
      previewSection.appendChild(previewBox);
      body.appendChild(previewSection);

      // Look up settings once; re-used on every applyAggregated() call.
      const NS = (window.__localMaskMCP = window.__localMaskMCP || {});
      const allowlist = new Set(
        Array.isArray(NS.settings && NS.settings.maskAllowlist)
          ? NS.settings.maskAllowlist
          : []
      );

      // Rebuild the row + category models AND the .categories DOM from
      // a fresh aggregated[] array. Called once at mount, then again
      // each time the LLM augmentation completes so newly-detected
      // entities appear in the open sidebar. User intent (masked/
      // unmasked per value) is preserved across rebuilds.
      // baselineAggregated = 「force-list を除いた検出結果」の snapshot。
      // 初回ペイント・LLM 追加時に更新される。force-list の追加/削除で
      // live re-detect するとき、この baseline + 最新 force-list を merge
      // + overlap 解決 + 再集約して表示する。これにより「田中」を既に
      // 検出している状態で「田中 太郎」を追加すると、両者の重なる箇所は
      // 「田中 太郎」が勝ち、重ならない「田中」は件数が自動で減る。
      let baselineAggregated = [];

      function applyAggregated(aggArr, opts) {
        opts = opts || {};
        const stagger = !!opts.stagger;
        // fromForcelist=true の再計算時は baseline を更新しない
        // (force-list 適用前の snapshot を保持したいため)。
        if (!opts.fromForcelist) {
          baselineAggregated = Array.isArray(aggArr) ? aggArr.slice() : [];
        }
        const preserved = new Map();
        for (const r of rows) preserved.set(r.value, r.masked);

        const fresh = (Array.isArray(aggArr) ? aggArr : []).map(buildRowState);
        for (const row of fresh) {
          if (forcedCategories.has(row.category)) {
            row.locked = true;
            row.masked = true;
          }
          if (allowlist.has(row.value)) {
            row.masked = false;
            row.locked = false;
          }
          // Restore the user's choice for rows that existed before the
          // rebuild. Locked rows never lose their masked=true state.
          if (preserved.has(row.value) && !row.locked) {
            row.masked = preserved.get(row.value);
          }
        }

        rows = fresh;
        categoryOrder = [];
        categoryMap = new Map();
        for (const row of rows) {
          if (!categoryMap.has(row.category)) {
            categoryOrder.push(row.category);
            categoryMap.set(row.category, []);
          }
          categoryMap.get(row.category).push(row);
        }

        while (categoriesWrap.firstChild) {
          categoriesWrap.removeChild(categoriesWrap.firstChild);
        }
        rowControls.clear();
        categoryControls.clear();

        for (const cat of categoryOrder) {
          categoriesWrap.appendChild(renderCategory(cat));
        }
        for (const cat of categoryOrder) {
          syncCategoryToggle(cat);
        }
        // Empty-state placeholder when regex + LLM both returned 0:
        // keeps the sidebar visually coherent so the user knows
        // the analysis actually completed rather than silently
        // vanishing.
        if (categoryOrder.length === 0) {
          const emptyMsg = document.createElement("div");
          emptyMsg.className = "empty";
          emptyMsg.textContent = "✓ PII は検出されませんでした — そのまま送信できます";
          categoriesWrap.appendChild(emptyMsg);
        }
        applySevFilter();
        updatePreview();

        // Stagger-in animation: each .row gets an 80ms-incrementing
        // delay so detections appear sequentially. Only done when
        // opts.stagger === true (i.e. the post-LLM rebuild path).
        if (stagger) {
          const rowEls = categoriesWrap.querySelectorAll(".row");
          rowEls.forEach((el, i) => {
            el.classList.add("row-staggered");
            el.style.animationDelay = i * 80 + "ms";
          });
        }
      }

      // Initial paint: if LLM augmentation is pending we hold off on
      // painting any rows until it resolves — otherwise the user sees
      // a transient "regex-only" masking list that then shuffles as
      // the LLM adds/overrides entries. When llmPending is null we
      // paint the regex-only results immediately as before.
      if (!llmPending) {
        applyAggregated(aggregated);
      }

      // --- LLM pending: centered overlay -------------------------------
      // While the LLM augmentation runs the sidebar shows ONLY the
      // centered overlay — no rows, no preview, no bulk buttons — so
      // the user isn't given a partial "regex-only" list that will
      // be rewritten a moment later. Supporting chrome (bulk-bar /
      // slider / sev-tabs / preview) is hidden until the overlay
      // dismisses; on error we reveal the regex-only fallback.
      // On failure we replace it with a compact top-positioned toast
      // that auto-hides after 4s (regex results stay in place).
      // Supporting UI that should be hidden while we show the overlay.
      // Collected once here so reveal() can flip them back on atomically.
      const chromeToHide = [bulkBar, holdSliderBar, sevTabs, previewSection];
      function hideChrome() {
        for (const el of chromeToHide) el.style.display = "none";
      }
      function revealChrome() {
        for (const el of chromeToHide) el.style.display = "";
      }

      let llmOverlay = null;
      function buildLlmOverlay() {
        const root = document.createElement("div");
        root.className = "llm-overlay";
        const ring = document.createElement("div");
        ring.className = "llm-overlay-spin-wrap";
        const r1 = document.createElement("div");
        r1.className = "llm-overlay-spin";
        const r2 = document.createElement("div");
        r2.className = "llm-overlay-spin ring2";
        ring.appendChild(r1);
        ring.appendChild(r2);
        const label = document.createElement("div");
        label.className = "llm-overlay-label";
        label.textContent =
          opts.mode === "replace" ? "\u2728 AI 置換中\u2026" : "\u2728 AI 分析中\u2026";
        const sub = document.createElement("div");
        sub.className = "llm-overlay-sub";
        sub.textContent =
          opts.mode === "replace"
            ? "ローカル LLM が送信内容を <tag> プレースホルダーに書き換えています。"
            : "ローカル LLM が文脈から追加候補を検出しています。完了次第、一覧に反映されます。";
        root.appendChild(ring);
        root.appendChild(label);
        root.appendChild(sub);
        return root;
      }

      function dismissLlmOverlay() {
        if (!llmOverlay) return;
        const el = llmOverlay;
        llmOverlay = null;
        el.classList.add("is-leaving");
        setTimeout(() => {
          if (el.parentNode) el.remove();
        }, 200);
      }

      function showLlmErrorToast() {
        const toast = document.createElement("div");
        toast.className = "llm-toast";
        const txt = document.createElement("span");
        txt.className = "llm-toast-text";
        txt.textContent =
          "AI 分析に失敗しました — regex / 形態素の結果のみ表示しています";
        toast.appendChild(txt);
        body.insertBefore(toast, categoriesWrap);
        setTimeout(() => {
          if (toast.parentNode) toast.remove();
        }, 4000);
      }

      if (llmPending) {
        hideChrome();
        llmOverlay = buildLlmOverlay();
        body.appendChild(llmOverlay);

        // mergeLlmDetect resolves in ALL paths (success, 0-entity,
        // timeout) — the `.catch` branch here is a safety net for
        // unexpected programming errors, not for LLM failure. We
        // detect LLM failure by inspecting the returned aggResp's
        // _llmStatus field set by injected.js.
        const finishLlm = (updated, hadException) => {
          const nextAgg =
            updated && Array.isArray(updated.aggregated)
              ? updated.aggregated
              : aggregated;
          if (updated && Array.isArray(updated.force_masked_categories)) {
            forcedCategories.clear();
            for (const c of updated.force_masked_categories) {
              forcedCategories.add(String(c));
            }
          }
          const failed =
            hadException ||
            (updated && updated._llmStatus === "failed");
          const rowsInAgg = Array.isArray(nextAgg) ? nextAgg.length : 0;

          // ALWAYS show the sidebar after LLM resolves — even when
          // nothing was detected — so the user can see that the
          // analysis ran and confirm / cancel the send. An empty
          // list renders a "未検出" placeholder (see applyAggregated
          // below, which inserts one if rows.length === 0).
          const shouldStagger = !failed && rowsInAgg > 0;
          applyAggregated(nextAgg, { stagger: shouldStagger });
          revealChrome();
          const lastRowEnd = shouldStagger ? rowsInAgg * 80 + 320 : 0;
          setTimeout(() => {
            dismissLlmOverlay();
            if (failed) showLlmErrorToast();
          }, lastRowEnd);
        };

        llmPending
          .then((updated) => finishLlm(updated, false))
          .catch(() => finishLlm(null, true));
      }

      // Bulk-uncheck gate for the critical tier. Returns ``true`` if
      // the user confirmed the clearance (non-critical rows should be
      // cleared), ``false`` if they cancelled. Centralised so both
      // the per-category toggle and the "すべて解除" button share the
      // exact same confirmation copy.
      function confirmCriticalBulkUncheck(criticalCount) {
        const msg =
          `Critical な ${criticalCount} 件の項目は長押しで個別に解除してください。` +
          `それ以外だけ解除しますか？`;
        try {
          return window.confirm(msg);
        } catch (_) {
          // Extremely locked-down pages (sandboxed iframes, some
          // PWA contexts) can throw when confirm() is called. In
          // that case we abort — critical rows stay masked.
          return false;
        }
      }

      // --- Bulk action handlers (defined here so they can see rows) -------
      selectAllBtn.addEventListener("click", () => {
        for (const row of rows) {
          if (row.locked) continue;
          row.masked = true;
          const ctl = rowControls.get(row.key);
          if (ctl) ctl.control.setOn(true);
        }
        for (const cat of categoryOrder) syncCategoryToggle(cat);
        updatePreview();
      });
      deselectAllBtn.addEventListener("click", () => {
        // "すべて解除" must NOT silently bypass the critical
        // long-press gate. When any non-locked critical row exists,
        // confirm with the user and, on accept, clear only the
        // non-critical / non-locked rows. The user still has to
        // long-press each critical row individually if they want it
        // unchecked.
        const criticals = rows.filter(
          (r) => !r.locked && r.severity === "critical"
        );
        if (criticals.length > 0) {
          const ok = confirmCriticalBulkUncheck(criticals.length);
          if (!ok) return;
          for (const row of rows) {
            if (row.locked) continue;
            if (row.severity === "critical") continue;
            row.masked = false;
            const ctl = rowControls.get(row.key);
            if (ctl) ctl.control.setOn(false);
          }
          for (const cat of categoryOrder) syncCategoryToggle(cat);
          updatePreview();
          return;
        }
        for (const row of rows) {
          if (row.locked) continue;
          row.masked = false;
          const ctl = rowControls.get(row.key);
          if (ctl) ctl.control.setOn(false);
        }
        for (const cat of categoryOrder) syncCategoryToggle(cat);
        updatePreview();
      });

      // --- Footer ----------------------------------------------------------
      const footer = document.createElement("footer");
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "secondary";
      cancelBtn.textContent = "キャンセル (Esc)";
      const confirmBtn = document.createElement("button");
      confirmBtn.type = "button";
      confirmBtn.className = "primary";
      confirmBtn.textContent = "選択したものをマスクして送信 (Enter)";
      footer.appendChild(cancelBtn);
      footer.appendChild(confirmBtn);

      panel.appendChild(header);
      panel.appendChild(body);
      panel.appendChild(footer);

      root.appendChild(panel);
      shadow.appendChild(root);

      document.body.appendChild(host);

      // force-list の追加/削除に応じた再検出。baselineAggregated (force-list
      // 適用前の snapshot) に新 force-list から得た USER_DEFINED 検出を merge、
      // overlap 解決 + 再集約し、applyAggregated に食わせる。
      // 例: 文中 "田中さん … 田中 太郎 …" で baseline に JP_SURNAME "田中" × 2
      //     があり、"田中 太郎" を追加 → 交差する 1 件は "田中 太郎" が勝つ、
      //     交差しない 1 件は "田中" のまま。件数がリアルタイムで減る。
      // 直前の maskForceList (前回 recompute 時の snapshot)。新規追加 entry
      // を差分で検出してそこへスクロール + フラッシュするために使う。
      let previousForcelist = [];

      function recomputeWithForcelist(entries) {
        const engine = window.__localMaskMCP && window.__localMaskMCP.engine;
        if (!engine || typeof engine.resolveOverlaps !== "function") return;
        const ufm = engine.userForceMask;
        const agg = engine.aggregate;
        if (!ufm || !agg || typeof agg.aggregateDetections !== "function") return;
        if (typeof originalText !== "string" || originalText.length === 0) return;

        // baseline の aggregated 行を per-occurrence detection 列に展開。
        // 旧 force-list に由来する USER_DEFINED_* は除外 (毎回 recompute で
        // 作り直すので二重登録を防ぐ)。
        const baselineDets = [];
        for (const row of baselineAggregated) {
          if (!row || typeof row.label !== "string") continue;
          if (row.label.startsWith("USER_DEFINED_")) continue;
          const positions = Array.isArray(row.positions) ? row.positions : [];
          for (const pos of positions) {
            if (!Array.isArray(pos) || pos.length < 2) continue;
            baselineDets.push({
              entity_type: row.label,
              start: Number(pos[0]),
              end: Number(pos[1]),
              text: String(row.value || ""),
              score: 1.0,
              action: row.masked === false ? "allowed" : "masked",
            });
          }
        }
        const ufmDets = ufm.detectUserForceMask(originalText, entries);
        const resolved = engine.resolveOverlaps(baselineDets.concat(ufmDets));
        const nextAgg = agg.aggregateDetections(resolved);
        // 追加された entry (前回スナップショットに無く、今回存在するもの)
        // を差分計算。recompute 後に該当 row をフラッシュするため使う。
        const prevKey = (e) => e.value + "|" + (e.category || "OTHER");
        const prevSet = new Set(previousForcelist.map(prevKey));
        const newlyAdded = entries.filter((e) => e && !prevSet.has(prevKey(e)));
        previousForcelist = entries.slice();

        applyAggregated(nextAgg, { fromForcelist: true });

        // 新規追加があれば、折り畳み状態のカテゴリを自動展開 + 該当 row へ
        // スクロール + 黄色フラッシュ。見えない所に追加される問題を解決。
        for (const added of newlyAdded) {
          const label = "USER_DEFINED_" + (added.category || "OTHER");
          for (const r of rows) {
            if (r.value === added.value && r.label === label) {
              scrollToAndFlashRow(r.key);
              break; // 複数出現でも先頭行だけ flash で十分
            }
          }
        }
      }

      // Live allowlist + forcelist sync — when the user adds/removes entries
      // via drag drop / options page, content script broadcasts new settings.
      function onSettingsUpdated(event) {
        const next = event && event.detail;
        if (!next) return;
        if (Array.isArray(next.maskAllowlist)) {
          const allowSet = new Set(next.maskAllowlist);
          for (const [, ctl] of rowControls) {
            if (allowSet.has(ctl.row.value) && ctl.row.masked) {
              ctl.setState(false);
            }
          }
        }
        if (Array.isArray(next.maskForceList)) {
          // 短時間に複数 storage.onChanged が飛ぶケースに備えて
          // requestAnimationFrame で deduplicate (必要最小限の再描画)。
          if (forceListRafId) cancelAnimationFrame(forceListRafId);
          const entries = next.maskForceList.slice();
          forceListRafId = requestAnimationFrame(() => {
            forceListRafId = 0;
            recomputeWithForcelist(entries);
          });
        }
      }
      let forceListRafId = 0;
      window.addEventListener("mask-mcp:settings-updated", onSettingsUpdated);

      function cleanup() {
        document.removeEventListener("keydown", onKeyDown, true);
        window.removeEventListener("resize", onResize);
        window.removeEventListener("mask-mcp:settings-updated", onSettingsUpdated);
        if (host.parentNode) host.parentNode.removeChild(host);
        if (globalLayoutStyle.parentNode) {
          globalLayoutStyle.parentNode.removeChild(globalLayoutStyle);
        }
        // Unwrap: move children back to <body> and remove wrapper.
        if (wrapper.parentNode === document.body) {
          while (wrapper.firstChild) {
            document.body.appendChild(wrapper.firstChild);
          }
          wrapper.remove();
          document.body.style.cssText = document.body.style.cssText
            .replace(/display:\s*flex\s*!important;?/g, "")
            .replace(/flex-direction:\s*row\s*!important;?/g, "")
            .replace(/overflow:\s*hidden\s*!important;?/g, "")
            .replace(/height:\s*100vh\s*!important;?/g, "")
            .replace(/margin:\s*0\s*!important;?/g, "")
            .replace(/width:\s*100vw\s*!important;?/g, "");
        }
      }

      function onConfirm() {
        const triples = collectKeepers();
        const keys = new Set(rows.filter((r) => r.masked).map((r) => r.key));
        cleanup();
        resolve({
          accepted: true,
          maskedEntityKeys: keys,
          maskedPositions: triples,
        });
      }

      function onCancel() {
        cleanup();
        resolve({
          accepted: false,
          maskedEntityKeys: new Set(),
          maskedPositions: [],
        });
      }

      cancelBtn.addEventListener("click", onCancel);
      confirmBtn.addEventListener("click", onConfirm);
      closeBtn.addEventListener("click", onCancel);

      // --- Focus trap + global keys ---------------------------------------

      function focusableNodes() {
        return Array.from(
          panel.querySelectorAll(
            'button, [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
          )
        ).filter((el) => !el.hasAttribute("disabled"));
      }

      function onKeyDown(event) {
        // Listen on document in capture phase so the host page's own
        // Enter/Escape handlers (chat-app send-on-enter, dialog
        // dismissers, etc.) never fire while the sidebar is open.
        if (event.key === "Escape") {
          event.stopPropagation();
          event.preventDefault();
          onCancel();
          return;
        }
        if (event.key === "Enter") {
          const tag = event.target && event.target.tagName;
          // Don't hijack Enter inside the bulk buttons themselves —
          // the user wants the click handler to fire, not Confirm.
          if (
            tag !== "TEXTAREA" &&
            event.target !== selectAllBtn &&
            event.target !== deselectAllBtn &&
            event.target !== cancelBtn &&
            event.target !== closeBtn
          ) {
            event.stopPropagation();
            event.preventDefault();
            onConfirm();
            return;
          }
        }
        if (event.key === "Tab") {
          const nodes = focusableNodes();
          if (nodes.length === 0) return;
          const first = nodes[0];
          const last = nodes[nodes.length - 1];
          // Active element inside a Shadow DOM is the host's
          // ``shadowRoot.activeElement``, not document.activeElement.
          const active = shadow.activeElement;
          if (event.shiftKey) {
            if (active === first || !panel.contains(active)) {
              event.preventDefault();
              last.focus();
            }
          } else {
            if (active === last || !panel.contains(active)) {
              event.preventDefault();
              first.focus();
            }
          }
        }
      }
      document.addEventListener("keydown", onKeyDown, true);

      // Trigger the slide-in animation on the next frame so the
      // transition actually fires (initial paint has the panel
      // off-screen at translateX(100%)).
      const onResize = () => applySidebarLayout();
      requestAnimationFrame(() => {
        applySidebarLayout();
        window.addEventListener("resize", onResize);
      });

      // Focus the primary confirm button so Enter immediately
      // completes the happy-path flow (mirrors review-modal.js).
      setTimeout(() => confirmBtn.focus(), 0);
    });
  }

  // --- Loading indicator (LLM 分析中) ----------------------------------
  // A tiny always-on-top spinner pinned to the top-right edge while
  // the LLM is being queried. Independent of the main review sidebar
  // so the user sees activity the moment a query starts, even if the
  // main sidebar hasn't rendered yet.
  let loadingHost = null;
  function showLoading(label) {
    if (loadingHost) {
      const lbl = loadingHost.shadowRoot.querySelector(".label");
      if (lbl) lbl.textContent = label || "LLM 分析中…";
      return;
    }
    loadingHost = document.createElement("div");
    loadingHost.setAttribute("data-mask-mcp-loader", "");
    loadingHost.style.cssText =
      "all:initial;position:fixed;top:16px;right:16px;z-index:2147483647;pointer-events:none";
    const shadow = loadingHost.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      .pill {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 16px 10px 14px;
        background: rgba(17, 24, 39, 0.92);
        color: #f9fafb;
        border-radius: 999px;
        font: 500 13px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        letter-spacing: 0.01em;
        box-shadow: 0 4px 18px rgba(0, 0, 0, 0.28), 0 1px 3px rgba(0, 0, 0, 0.18);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        animation: fade-in 0.18s ease-out;
      }
      .spinner {
        width: 16px;
        height: 16px;
        border: 2px solid rgba(255, 255, 255, 0.22);
        border-top-color: #a855f7;
        border-right-color: #6366f1;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }
      .label { white-space: nowrap; }
      @keyframes spin { to { transform: rotate(360deg); } }
      @keyframes fade-in {
        from { opacity: 0; transform: translateY(-6px); }
        to   { opacity: 1; transform: translateY(0); }
      }
    `;
    shadow.appendChild(style);
    const pill = document.createElement("div");
    pill.className = "pill";
    const spin = document.createElement("div");
    spin.className = "spinner";
    const txt = document.createElement("span");
    txt.className = "label";
    txt.textContent = label || "LLM 分析中…";
    pill.appendChild(spin);
    pill.appendChild(txt);
    shadow.appendChild(pill);
    document.body.appendChild(loadingHost);
  }
  function hideLoading() {
    if (!loadingHost) return;
    try { loadingHost.remove(); } catch (_) {}
    loadingHost = null;
  }

  // Replace mode no longer needs a separate page-center overlay —
  // the in-sidebar .llm-overlay handles both detect and replace
  // modes via sidebar.show({ mode, llmPending }). The previous
  // showReplaceOverlay / hideReplaceOverlay functions were dead
  // after commit b3a0ab9 and were removed for clarity.

  NS.sidebar = {
    show,
    applyMasks,
    showLoading,
    hideLoading,
  };
})();
