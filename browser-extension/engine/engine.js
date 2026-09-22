// engine/engine.js — standalone masking pipeline entry point.
// Replicates /v1/extension/sanitize{,/aggregated} shapes using preset
// regex + classification + severity + categories + aggregation +
// force-mask + blocklist. No Presidio (Phase 3), no Sudachi (Phase 2).
// Target accuracy vs Python gateway: 75-80%.
"use strict";

(function attach(root) {
  function resolveDeps() {
    const d = {};
    if (typeof require === "function") {
      const load = (k, p) => { try { d[k] = require(p); } catch (_) {} };
      load("patterns", "./patterns");
      load("classification", "./classification");
      load("severity", "./severity");
      load("categories", "./categories");
      load("aggregate", "./aggregate");
      load("forceMask", "./force-mask");
      load("blocklist", "./blocklist");
      load("userForceMask", "./user-force-mask");
      load("onnxDetector", "./onnx-detector");
      load("confidential", "./confidential");
    }
    const ns = (root && root.__localMaskMCP && root.__localMaskMCP.engine) || {};
    for (const k of ["patterns","classification","severity","categories","aggregate","forceMask","blocklist","userForceMask","onnxDetector","confidential"]) {
      d[k] = d[k] || ns[k];
    }
    return d;
  }

  function generateAuditId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      try { return crypto.randomUUID(); } catch (_) {}
    }
    const hex = "0123456789abcdef";
    let out = "";
    for (let i = 0; i < 36; i++) {
      if (i === 8 || i === 13 || i === 18 || i === 23) out += "-";
      else if (i === 14) out += "4";
      else if (i === 19) out += hex[Math.floor(Math.random() * 4) + 8];
      else out += hex[Math.floor(Math.random() * 16)];
    }
    return out;
  }

  // NFKC-normalise while keeping a map back to the original offsets.
  //
  // Japanese text pasted out of Excel, Word or a form routinely carries
  // full-width digits and punctuation (０９０－１２３４－５６７８,
  // ｔａｒｏ＠ｅｘａｍｐｌｅ．ｃｏｍ). No character class in patterns.js
  // covers those, so every numeric rule silently missed them. Matching
  // against the normalised text fixes all of them at once, but the spans
  // have to come back in ORIGINAL coordinates — applyTagMask and the
  // review sidebar both index the text the user actually typed, and NFKC
  // is not length-preserving (㈱ -> (株) grows, ｶﾞ -> ガ shrinks).
  //
  // map[i] is the original index that normalised character i came from;
  // one trailing sentinel lets a half-open end offset map back too.
  function nfkcWithMap(text) {
    let norm = "";
    const map = [];
    let i = 0;
    while (i < text.length) {
      let consumed = 1;
      let n = text[i].normalize("NFKC");
      if (i + 1 < text.length) {
        // Try a two-unit cluster first so half-width katakana followed by
        // a voiced mark (ｶ + ﾞ) composes to ガ rather than decomposing.
        const pair = (text[i] + text[i + 1]).normalize("NFKC");
        if (pair.length === 1) { n = pair; consumed = 2; }
      }
      for (let k = 0; k < n.length; k++) map.push(i);
      norm += n;
      i += consumed;
    }
    map.push(text.length);
    return { norm, map };
  }

  function collectDetections(text, options) {
    const deps = resolveDeps();
    if (!deps.patterns) throw new Error("mask-mcp engine: patterns missing");
    const disabled = new Set((options && options.disabledCategories) || []);
    const { norm, map } = nfkcWithMap(text);
    const identity = norm === text;
    const out = [];
    for (const { entity_type, pattern, validate } of deps.patterns.getPresetPatterns(disabled)) {
      // Clone so module-level regex lastIndex is never mutated.
      const re = new RegExp(pattern.source, pattern.flags);
      let m;
      while ((m = re.exec(norm)) !== null) {
        if (m.index === re.lastIndex) { re.lastIndex += 1; continue; }
        // Constraints a regex cannot express (e.g. the card check digit).
        if (validate && !validate(m[0])) continue;
        const start = identity ? m.index : map[m.index];
        const end = identity ? m.index + m[0].length : map[m.index + m[0].length];
        out.push({
          entity_type, start, end,
          // Surface the ORIGINAL text: it is what gets substituted, what
          // the sidebar shows, and what the blocklist is keyed on.
          text: text.slice(start, end), score: 1.0, action: "masked",
        });
      }
    }
    return out;
  }

  // Sweep-line overlap resolver.
  //
  // Returns a set of spans that never intersect, so every downstream
  // consumer (aggregateDetections, applyTagMask, the sidebar) sees the
  // same non-overlapping view of the text.
  //
  // Ordering decides which span survives a conflict:
  //   1. leftmost start
  //   2. longest span — the fuller entity beats the fragment, so ML's
  //      「山田太郎」 wins over the surname dictionary's 「山田」.
  //      Score deliberately does NOT outrank length here: regex/dict
  //      detections are hardcoded to 1.0 (collectDetections) while ML
  //      forwards a softmax < 1.0 (onnx-detector.js), so ranking by
  //      score would always shrink a full name back to its fragment.
  //   3. higher severity — a URL carrying embedded credentials matches
  //      both URL (medium) and SECRET (critical) over the same span, and
  //      settling that by label name would quietly downgrade a
  //      credential leak to a link. On a genuine tie, fail safe.
  //   4. higher score, then entity_type — only to make the outcome
  //      deterministic when two rules of equal severity match the exact
  //      same span (e.g. a bare 12-digit run is both MY_NUMBER and
  //      DRIVERS_LICENSE). Without a total order the two entry points
  //      can disagree on the label for one span.
  function resolveOverlaps(results) {
    if (results.length < 2) return results.slice();
    const deps = resolveDeps();
    const sevRank = (label) => {
      if (!deps.severity) return 99;
      const idx = deps.severity.SEVERITY_ORDER.indexOf(deps.severity.severityFor(label));
      return idx === -1 ? 99 : idx; // 0 = critical
    };
    const ordered = results.slice().sort(
      (a, b) =>
        a.start - b.start ||
        (b.end - b.start) - (a.end - a.start) ||
        sevRank(a.entity_type) - sevRank(b.entity_type) ||
        b.score - a.score ||
        (a.entity_type < b.entity_type ? -1 : a.entity_type > b.entity_type ? 1 : 0),
    );
    const keep = [];
    let lastEnd = -1;
    for (const c of ordered) {
      // Spans are half-open [start, end): touching is not overlapping.
      if (c.start < lastEnd) continue;
      keep.push(c);
      lastEnd = c.end;
    }
    return keep;
  }

  // Collect every raw detection (regex/dict/force-mask) without any
  // filtering or overlap resolution. Shared between the sync pipeline
  // (used by tests, gateway-style callers) and the async pipeline that
  // additionally awaits ML/NER detections from the service worker.
  function collectRawDetections(text, opts, deps) {
    let dets = collectDetections(text, { disabledCategories: opts.disabledCategories });
    // ユーザーがサイドバー drop で登録した force-mask list を regex 検出と merge。
    // blocklist より前に積んでおくことで、ブロックリストに入った語を
    // 誤ってユーザーが追加してしまっても blocklist 側が最終的に勝つ
    // (= blocklist が常に最上位の安全装置、という既存不変を維持)。
    if (deps.userForceMask && Array.isArray(opts.userForceMaskEntries) && opts.userForceMaskEntries.length > 0) {
      dets = dets.concat(deps.userForceMask.detectUserForceMask(text, opts.userForceMaskEntries));
    }
    return dets;
  }

  // Apply the post-collection filters in a fixed order: blocklist →
  // minScore → enabledPiiClasses → overlap resolver. Idempotent enough
  // that calling it after merging in async ML detections still yields
  // the right answer.
  function finishPipeline(dets, opts, deps) {
    const minScore = typeof opts.minScore === "number" ? opts.minScore : 0.0;
    const bl = opts.commonNounBlocklist instanceof Set ? opts.commonNounBlocklist
      : new Set(opts.commonNounBlocklist || deps.blocklist.DEFAULT_COMMON_NOUN_BLOCKLIST);
    if (bl.size > 0) dets = dets.filter((d) => !bl.has(d.text));
    if (minScore > 0.0) dets = dets.filter((d) => d.score >= minScore);
    if (opts.enabledPiiClasses) {
      const en = new Set(opts.enabledPiiClasses);
      dets = dets.filter((d) => en.has(deps.classification.classificationFor(d.entity_type)));
    }
    return resolveOverlaps(dets);
  }

  function runPipeline(text, opts, deps) {
    return finishPipeline(collectRawDetections(text, opts, deps), opts, deps);
  }

  // Async variant: same as runPipeline but also invokes the ML detector
  // (transformers.js NER via the service worker) when opts.mlEnabled is
  // truthy. ML failures degrade silently — regex/dict detections always
  // survive even if the SW is asleep / WASM hasn't loaded yet.
  async function runPipelineAsync(text, opts, deps) {
    let dets = collectRawDetections(text, opts, deps);
    if (opts.mlEnabled && deps.onnxDetector) {
      try {
        const mlDets = await deps.onnxDetector.detectViaMl(text);
        if (mlDets.length > 0) dets = dets.concat(mlDets);
      } catch (_) { /* fall through with regex-only */ }
    }
    return finishPipeline(dets, opts, deps);
  }

  // 「意味として機密」な文の警告。**検出 span とは別枠で返す**。
  //
  // これを aggregated に混ぜると、サイドバーは文まるごとをマスク候補
  // として並べてしまう。買収交渉の一文を置換したらプロンプトが壊れる
  // ので、ADDRESS が文を飲み込んでいたバグと同じ失敗になる。
  // あくまで「送る前に見直して」の警告として別フィールドに置き、
  // 同じ文の中の社名・金額・人名は通常の span 検出側がマスクする。
  //
  // opts.confidentialEnabled === false で無効化できる (既定は有効)。
  // hold-out 実測で precision 1.00 / recall 0.40 — 誤警告はほぼ出ない
  // 代わりに、言い換えの 6 割は取りこぼす。
  function collectConfidential(text, opts, deps) {
    if (opts.confidentialEnabled === false) return [];
    if (!deps.confidential) return [];
    try {
      return deps.confidential.detectConfidential(text, {
        threshold: opts.confidentialThreshold,
      });
    } catch (_) {
      return [];
    }
  }

  // /v1/extension/sanitize/aggregated.
  // Returns a Promise when opts.mlEnabled is true (ML inference is
  // async via the SW), otherwise returns the result synchronously
  // wrapped in Promise.resolve. Callers should always ``await`` —
  // the API is uniformly Promise-shaped so the call site doesn't
  // branch on mlEnabled.
  async function maskAggregated(text, options) {
    const opts = options || {};
    const deps = resolveDeps();
    if (!deps.aggregate || !deps.forceMask || !deps.blocklist) {
      throw new Error("mask-mcp engine: deps missing");
    }
    const kws = opts.forceMaskKeywords || deps.forceMask.DEFAULT_KEYWORDS;
    const cats = opts.forceMaskCategories || deps.forceMask.DEFAULT_CATEGORIES;
    const dets = opts.mlEnabled
      ? await runPipelineAsync(text, opts, deps)
      : runPipeline(text, opts, deps);
    let agg = deps.aggregate.aggregateDetections(dets);
    const fired = deps.forceMask.detectForceMaskTrigger(text, kws);
    const forced = deps.forceMask.resolveForcedCategories(fired, cats);
    agg = deps.forceMask.applyForceMask(agg, forced);
    return {
      original_text: text, aggregated: agg, audit_id: generateAuditId(),
      force_masked_categories: forced,
      confidential: collectConfidential(text, opts, deps),
    };
  }

  // /v1/extension/sanitize. Same Promise-uniform shape as maskAggregated.
  async function maskSanitize(text, options) {
    const opts = options || {};
    const deps = resolveDeps();
    const dets = opts.mlEnabled
      ? await runPipelineAsync(text, opts, deps)
      : runPipeline(text, opts, deps);
    const sanitized = deps.aggregate.applyTagMask(text, dets);
    const enriched = dets.map((d) => ({
      entity_type: d.entity_type, start: d.start, end: d.end, score: d.score,
      text: d.text, action: d.action || "masked",
      severity: deps.severity.severityFor(d.entity_type),
    }));
    return {
      audit_id: generateAuditId(), filter_enabled: true,
      original_length: text.length, sanitized_text: sanitized,
      detections: enriched, forwarded: false,
      confidential: collectConfidential(text, opts, deps),
    };
  }

  const api = { maskAggregated, maskSanitize, collectDetections, resolveOverlaps, runPipeline, runPipelineAsync };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") {
    root.__localMaskMCP = root.__localMaskMCP || {};
    root.__localMaskMCP.engine = root.__localMaskMCP.engine || {};
    Object.assign(root.__localMaskMCP.engine, api);
  }
})(typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : globalThis);
