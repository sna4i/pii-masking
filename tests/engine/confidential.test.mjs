// tests/engine/confidential.test.mjs — sentence-level "confidential by
// meaning" gate.
//
// Kept out of tests/vectors/*.json because this detector is scored and
// sentence-scoped rather than a span match, and because the adversarial
// set below is the point: an earlier lexicon prototype scored 1.00/1.00
// on hand-written cases and collapsed to precision 0.50 / recall 0.14 on
// phrasings it had not been tuned for. That set is now permanent, and
// the gate is tuned for PRECISION — recall is explicitly given up on.
//
// Run: node --test tests/engine/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const confidential = require("../../browser-extension/engine/confidential.js");

const fires = (text) => confidential.detectConfidential(text).length > 0;

// ---- Must fire ---------------------------------------------------------
// The two cases from the Chrome Web Store review, plus phrasings the
// first prototype missed because it keyed on compound nouns instead of
// predicate frames.
const POSITIVE = [
  "来期から主力製品を10%値上げする方針だが、まだ社外には公表していない。",
  "A社との買収交渉が最終段階に入っている。基本合意は来月を予定。",
  "第3四半期に国内工場2拠点の閉鎖と200名規模の人員削減を実施する予定。",
  "次期モデルの発表は11月だが、仕様はまだ伏せておいてほしい。",
  "【機密】A社との買収交渉が最終段階に入っている。",
  "来年度の価格改定について、社外秘で検討中です。",
  "例の件、来月から単価を上げる話、まだ誰にも言わないでね。",
  "新しい料金表、競合に知られたくないので添付は消してください。",
  "次の四半期、部署が半分になるらしい。まだオフィシャルじゃない。",
  "この資料は取扱注意です。",
];

// ---- Must not fire -----------------------------------------------------
// Topic words in benign contexts, already-public news, and ordinary
// questions. A false positive here trains users to ignore the warning.
const NEGATIVE = [
  "来週の定例会議は予定通り15時から行います。",
  "昨日のニュースで、A社の買収が発表されました。",
  "電気料金の値上げがプレスリリースで公表されました。",
  "このアプリのインストール手順を教えてください。",
  "田中さんの連絡先は tanaka@example.co.jp です。",
  "来期の目標を達成するために頑張りましょう。",
  "買収防衛策について一般論を教えてください。",
  "M&Aの基礎知識を勉強したいのですが、おすすめの本は?",
  "ガソリンの値上げが家計に響きますね。",
  "リストラという言葉の語源を教えて。",
  "上場企業の決算書の読み方を解説して。",
  "特許出願の一般的な流れを説明してください。",
  "次期バージョンのReactの新機能について教えて。",
  "入札価格の相場観ってどう調べるの?",
  "この訴訟ドラマの続きが気になる。",
];

test("fires on the review's examples and on paraphrases of them", () => {
  const missed = POSITIVE.filter((t) => !fires(t));
  assert.deepEqual(missed, [], `missed ${missed.length}/${POSITIVE.length}`);
});

test("stays silent on benign topic mentions and public news", () => {
  const wrong = NEGATIVE.filter((t) => fires(t));
  assert.deepEqual(wrong, [], `false positives: ${wrong.length}/${NEGATIVE.length}`);
});

test("an explicit confidentiality marker fires on its own", () => {
  // The one signal strong enough not to need a topic.
  assert.ok(fires("この資料は社外秘です。"));
  assert.ok(fires("Internal Use Only - do not forward."));
});

test("a single topic term alone never fires", () => {
  // Otherwise every mention of 買収 or 値上げ warns, and the feature
  // gets switched off.
  assert.ok(!fires("買収について。"));
  assert.ok(!fires("値上げ。"));
});

test("reports which family and signals fired, for the UI", () => {
  const [hit] = confidential.detectConfidential(
    "来期から主力製品を10%値上げする方針だが、まだ社外には公表していない。",
  );
  assert.ok(hit, "expected a detection");
  assert.equal(typeof hit.start, "number");
  assert.equal(typeof hit.end, "number");
  assert.ok(hit.families.includes("PRICING_CHANGE"));
  assert.ok(hit.signals.secrecy, "the secrecy signal should be reported");
});

test("scores each sentence independently", () => {
  const hits = confidential.detectConfidential(
    "天気の話です。来期から単価を上げる予定、まだ内密に。明日は晴れ。",
  );
  assert.equal(hits.length, 1, "only the middle sentence is confidential");
  assert.ok(hits[0].text.includes("単価"));
});

test("does not fire on very short fragments", () => {
  // Purview applies a length floor to its analogous message classifiers;
  // without one, a two-word fragment scores on noise.
  assert.ok(!fires("値上げ検討"));
});
