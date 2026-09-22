// tests/engine/overlap.test.mjs — unit tests for the span overlap
// resolver and the tag-substitution pass.
//
// These live outside tests/vectors/*.json because the JSON vectors can
// only feed *text* through the engine, and every regex/dictionary
// detection is hardcoded to score 1.0 (engine.js). The bugs covered
// here only appear once detections carry *differing* scores, which
// happens the moment the ML detector is enabled (onnx-detector.js
// forwards the model softmax, always < 1.0).
//
// Run: node --test tests/engine/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ENGINE = "../../browser-extension/engine/";
const engine = require(ENGINE + "engine.js");
const aggregate = require(ENGINE + "aggregate.js");

const det = (entity_type, start, end, text, score) => ({
  entity_type, start, end, text, score, action: "masked",
});

test("longer span wins over a nested shorter one even when it scores lower", () => {
  // The most common Japanese case once ML is on: the NER model returns
  // the full name 山田太郎 with a softmax score, while the surname
  // dictionary returns 山田 with the hardcoded 1.0.
  const kept = engine.resolveOverlaps([
    det("PROPER_NOUN_PERSON", 3, 7, "山田太郎", 0.87),
    det("JP_SURNAME", 3, 5, "山田", 1.0),
  ]);

  assert.equal(kept.length, 1, "the nested shorter span must be dropped");
  assert.equal(kept[0].entity_type, "PROPER_NOUN_PERSON");
  assert.equal(kept[0].text, "山田太郎");
});

test("partially overlapping spans are reduced to one", () => {
  // 東京都渋谷区 (dict) vs 渋谷区神南1-1 (regex) — neither contains the
  // other, so containment-only resolution leaves both and the tag pass
  // corrupts the string.
  const kept = engine.resolveOverlaps([
    det("JP_PREFECTURE_DICT", 0, 6, "東京都渋谷区", 1.0),
    det("ADDRESS", 3, 11, "渋谷区神南1-1", 1.0),
  ]);

  assert.equal(kept.length, 1, "overlapping spans must not both survive");
});

test("disjoint spans are all kept", () => {
  const kept = engine.resolveOverlaps([
    det("JP_SURNAME", 0, 2, "山田", 1.0),
    det("EMAIL_ADDRESS", 5, 15, "a@b.example", 1.0),
  ]);

  assert.equal(kept.length, 2);
});

test("applyTagMask never emits a partially overwritten placeholder", () => {
  // Regression guard for the corruption itself: even if a caller hands
  // applyTagMask overlapping spans, the output must not contain a torn
  // placeholder such as "<JP_SURNAME_1>ROPER_NOUN_PERSON_1>".
  const out = aggregate.applyTagMask("担当は山田太郎さんです", [
    det("PROPER_NOUN_PERSON", 3, 7, "山田太郎", 0.87),
    det("JP_SURNAME", 3, 5, "山田", 1.0),
  ]);

  // Strip every well-formed <LABEL_n> placeholder; nothing placeholder
  // shaped may be left behind.
  const residue = out.replace(/<[A-Z_]+_\d+>/g, "");
  assert.ok(
    !/[A-Z_]{3,}_\d+>/.test(residue),
    `torn placeholder in output: ${JSON.stringify(out)}`,
  );
});

test("maskAggregated and maskSanitize agree on the label for one span", async () => {
  // A bare 12-digit run matches both MY_NUMBER and DRIVERS_LICENSE over
  // the identical span. Whichever wins, both entry points must agree —
  // the sidebar shows one label while the other is what actually gets
  // substituted into the outgoing text.
  const text = "番号は 123456789012 です";
  const agg = await engine.maskAggregated(text, {});
  const san = await engine.maskSanitize(text, {});

  const aggLabels = agg.aggregated.map((e) => e.label);
  const sanLabels = san.detections.map((d) => d.entity_type);

  assert.deepEqual(
    [...new Set(sanLabels)].sort(),
    [...new Set(aggLabels)].sort(),
    "the two entry points disagree on the label for the same span",
  );
});
