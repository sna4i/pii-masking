// tests/engine/confidential-holdout.test.mjs — 未調整データでの性能の床。
//
// このセットは confidential.js の語彙を一度も参照せずに書いたもので、
// **緑にするために語彙を足してはいけない**。足せばこのセットの数字は
// 上がるが、次の未知のセットでは同じところに戻るだけで、測定器として
// の価値が失われる。
//
// 測定値 (2026-09-22):
//   precision 1.00 / recall 0.40  — 調査時の予測帯 (>=0.90 / 0.3-0.5) 内
//
// precision は「誤警告を出さない」約束なので 1.00 を割ったら回帰。
// recall は語彙方式の天井であり、ここを超えるには埋め込みか学習済み
// 分類器が要る。閾値は「下がったら気づく」ための床として置く。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const confidential = require("../../browser-extension/engine/confidential.js");
const fires = (t) => confidential.detectConfidential(t).length > 0;

const POSITIVE = [
  "来年の春に北関東の物流センターを畳む案が出ています。まだ現場には言えません。",
  "仕入先の切り替えで原価を3%下げられる見通しですが、先方には伏せておいてください。",
  "ライバル企業との業務提携を水面下で進めています。",
  "決算発表前なので株の話は控えてください。",
  "新サービスの月額を1980円にする案、外部に出さないでね。",
  "係争中の件で和解案を検討しています。公表はまだです。",
  "役員人事の内示が来週あります。口外しないように。",
  "второй quarter の受注見込みは未公表の数字です。",
  "This acquisition is still under NDA.",
  "工場の稼働を止める方向で調整中。オフレコで。",
];

const NEGATIVE = [
  "物流センターの見学予約はどうすればいいですか。",
  "原価計算の基本を教えてください。",
  "業務提携のプレスリリースが出ましたね。",
  "決算発表のスケジュールはどこで見られますか。",
  "月額料金のプランを比較したい。",
  "和解案の書き方のテンプレートはありますか。",
  "役員人事のニュースを要約して。",
  "受注管理の一般的なフローを教えて。",
  "M&Aの成功事例を3つ挙げて。",
  "工場の生産性を上げる方法を調べたい。",
  "この英文を日本語に訳して。",
  "明日の天気はどうですか。",
  "売上を伸ばすマーケ施策を提案して。",
  "在庫管理システムのバグを直したい。",
  "新入社員向けの研修資料を作って。",
];

test("precision stays perfect on untuned benign input", () => {
  const wrong = NEGATIVE.filter(fires);
  assert.deepEqual(wrong, [], "a false warning trains users to ignore the feature");
});

test("recall on untuned confidential input does not regress below 0.4", () => {
  const hit = POSITIVE.filter(fires).length;
  const recall = hit / POSITIVE.length;
  assert.ok(
    recall >= 0.4,
    `recall ${recall.toFixed(2)} < 0.40 — the lexicon lost ground`,
  );
});
