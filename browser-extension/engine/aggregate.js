// engine/aggregate.js — port of src/app/services/aggregation.py +
// tag-mask numbering/sub from masking_service.py.
// Depends on engine.{categories,classification,severity}.
"use strict";

(function attach(root) {
  function pick(a, b) { return a || (b && typeof b === "object" ? b : null); }
  function resolveDeps() {
    let c = null, cl = null, s = null;
    if (typeof require === "function") {
      try { c = require("./categories"); } catch (_) {}
      try { cl = require("./classification"); } catch (_) {}
      try { s = require("./severity"); } catch (_) {}
    }
    const ns = (root && root.__localMaskMCP && root.__localMaskMCP.engine) || {};
    return { categories: pick(c, ns.categories), classification: pick(cl, ns.classification), severity: pick(s, ns.severity) };
  }

  // aggregate_detections(detections) → AggregatedEntity[].
  function aggregateDetections(detections) {
    const { categories, classification, severity } = resolveDeps();
    if (!categories || !classification || !severity) {
      throw new Error("mask-mcp engine aggregate: missing deps");
    }
    const order = [];
    const byValue = new Map();
    for (const det of detections) {
      if (!byValue.has(det.text)) { order.push(det.text); byValue.set(det.text, []); }
      byValue.get(det.text).push(det);
    }
    // Numbering pass (matches _tag_mask pass 1 and aggregate_detections).
    const counters = new Map();
    const numbering = new Map();
    const flat = [];
    for (const hits of byValue.values()) for (const h of hits) flat.push(h);
    flat.sort((a, b) => a.start - b.start || a.end - b.end);
    for (const det of flat) {
      const key = det.entity_type + "\x00" + det.text;
      if (!numbering.has(key)) {
        const n = (counters.get(det.entity_type) || 0) + 1;
        counters.set(det.entity_type, n);
        numbering.set(key, n);
      }
    }

    const aggregated = [];
    for (const value of order) {
      const hits = byValue.get(value);
      // Best label = smallest start; tie-break prefers category != OTHER.
      const keyOf = (h) => [h.start, categories.categoryFor(h.entity_type) !== "OTHER" ? 0 : 1];
      let best = hits[0], bestKey = keyOf(best);
      for (let i = 1; i < hits.length; i++) {
        const k = keyOf(hits[i]);
        if (k[0] < bestKey[0] || (k[0] === bestKey[0] && k[1] < bestKey[1])) {
          best = hits[i]; bestKey = k;
        }
      }
      const label = best.entity_type;
      const category = categories.categoryFor(label);
      // Dedupe (start, end) — first-occurrence wins.
      const seen = new Set();
      const positions = [];
      for (const h of hits) {
        const span = h.start + ":" + h.end;
        if (seen.has(span)) continue;
        seen.add(span);
        positions.push([h.start, h.end]);
      }
      positions.sort((a, b) => a[0] - b[0]);
      // Drop polite-phrase false positives mis-tagged as PERSON.
      if ((label === "PERSON" || label === "PROPER_NOUN_PERSON") &&
          severity.isFalsePositivePerson(value)) {
        continue;
      }
      const masked = hits.some((h) => (h.action || "masked") === "masked");
      const n = numbering.get(label + "\x00" + value) || 1;
      aggregated.push({
        value, label, category,
        count: positions.length,
        positions, masked,
        placeholder: "<" + label + "_" + n + ">",
        classification: classification.classificationFor(label),
        severity: severity.severityForSurface(label, value),
      });
    }
    return aggregated;
  }

  // _tag_mask port — 2-pass numbering + reverse-order substitution.
  function applyTagMask(originalText, detections) {
    const counters = new Map();
    const assignments = new Map();
    const sorted = [...detections].sort((a, b) => a.start - b.start || a.end - b.end);
    for (const item of sorted) {
      const surface = originalText.slice(item.start, item.end);
      const key = item.entity_type + "\x00" + surface;
      if (!assignments.has(key)) {
        const n = (counters.get(item.entity_type) || 0) + 1;
        counters.set(item.entity_type, n);
        assignments.set(key, n);
      }
    }
    // Last-wins dedup by (start, end).
    const unique = new Map();
    for (const item of detections) unique.set(item.start + ":" + item.end, item);

    // Drop anything that intersects a span we already accepted. Callers
    // normally hand us the output of engine.resolveOverlaps, which is
    // already disjoint, so this is a guard rather than a filter — but
    // without it a caller passing overlapping spans gets a torn
    // placeholder ("<JP_SURNAME_1>ROPER_NOUN_PERSON_1>"), because the
    // substitution below indexes the *mutated* string with offsets taken
    // from the *original* one.
    const accepted = [];
    let lastEnd = -1;
    for (const item of [...unique.values()].sort(
      (a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start),
    )) {
      if (item.start < lastEnd) continue;
      accepted.push(item);
      lastEnd = item.end;
    }

    const descending = accepted.sort((a, b) => b.start - a.start);
    let result = originalText;
    for (const item of descending) {
      const surface = originalText.slice(item.start, item.end);
      const n = assignments.get(item.entity_type + "\x00" + surface) || 1;
      result = result.slice(0, item.start) + "<" + item.entity_type + "_" + n + ">" + result.slice(item.end);
    }
    return result;
  }

  const api = { aggregateDetections, applyTagMask };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") {
    root.__localMaskMCP = root.__localMaskMCP || {};
    root.__localMaskMCP.engine = root.__localMaskMCP.engine || {};
    Object.assign(root.__localMaskMCP.engine, { aggregate: api });
  }
})(typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : globalThis);
