// engine/confidential.js — 文単位の「意味として機密な内容」ゲート。
//
// Chrome Web Store のレビュー (2026-08-16, ★4) が指摘した穴に対応する:
//
//   > 未発表の値上げや買収交渉のような、文章の意味として機密になる
//   > 情報は検出されませんでした
//
// これは PII ではない。マスクすべき span が存在せず、機密性は文の
// *意味* に宿る。したがってこのモジュールは span 検出器ではなく、
// 文ごとにスコアを付けて「送る前に見直したほうがいい」と伝えるための
// ゲートである。
//
// ## なぜ語彙だけで十分でないか (実測)
//
// 初期プロトタイプは「複合名詞 × 秘匿語」の共起で組んだ。自作の
// テストセットでは precision 1.00 / recall 1.00 だったが、チューニング
// 時に想定していなかった言い回しを集めた敵対セットでは
// **precision 0.50 / recall 0.14** まで落ちた。`値上げ` は拾えても
// `単価を上げる` が落ち、`買収` は拾えても `飲み込む` が落ちる。
//
// 対策は 2 つ:
//   1. キーを複合名詞から **述語フレーム** に変える。日本語は膠着語
//      なので語幹で持ち、活用は末尾に落とす (`上げ` が 上げる/上げた/
//      引き上げ を覆う)。これで `単価を上げる` が入る。
//   2. 比喩 (`飲み込む` = 買収) は **追わない**。追うと precision が
//      壊れる。recall の損失として受け入れる。
//
// 期待値は precision ≥0.90 / recall 0.3-0.5。これは「明示された機密と
// 定型的な言い回しを拾う安いゲート」であって、検出器ではない。
// 言い換えまで届かせるには埋め込みか学習済み分類器が要る (後述)。
//
// ## action は masked ではなく flagged
//
// 「買収交渉」を自動置換するとプロンプトが壊れる。これは ADDRESS が
// 文を飲み込んでいたバグと同じ失敗で、ユーザーは機能ごと無効化する。
// ここでは警告を出し、同じ文の中の *構造化された* PII (社名・金額・
// 人名) を通常どおりマスクする側に任せる。
"use strict";

(function attach(root) {
  // ---- 語彙 ------------------------------------------------------------
  // 各ファミリは slotA (何について) × slotB (どうなる) の 2 スロット。
  // 両方が window 文字以内に共起したときだけトピック成立とみなす。
  // 語は「語幹」で持つ — 活用語尾は書かない。
  const FAMILIES = {
    MA_DEAL: {
      slotA: ["買収", "M&A", "TOB", "公開買付", "デューデリ", "資本提携", "株式譲渡", "合併", "事業譲渡", "子会社化"],
      slotB: ["交渉", "協議", "検討", "合意", "基本合意", "LOI", "MOU", "最終段階", "進行", "話", "案件", "スキーム"],
      window: 40,
    },
    PRICING_CHANGE: {
      slotA: ["値上げ", "値下げ", "単価", "価格", "料金", "運賃", "仕切り", "卸", "掛率", "定価", "料金表", "原価", "粗利"],
      slotB: ["上げ", "引き上げ", "下げ", "引き下げ", "改定", "見直し", "変更", "アップ", "据え置", "新しい", "新"],
      window: 40,
    },
    WORKFORCE_ACTION: {
      slotA: ["部署", "人員", "要員", "拠点", "チーム", "人数", "組織", "工場", "支店", "従業員",
              "希望退職", "早期退職", "リストラ", "レイオフ", "整理解雇"],
      slotB: ["半分", "削減", "減ら", "縮小", "統合", "統廃合", "なくな", "閉鎖", "整理", "撤退", "再編", "リストラ", "希望退職", "早期退職", "レイオフ", "募集", "実施"],
      window: 40,
    },
    MARKET_DISCLOSURE: {
      slotA: ["上場", "IPO", "増資", "MBO", "業績予想", "決算", "配当", "株価"],
      slotB: ["予定", "申請", "修正", "下方", "上方", "延期", "中止", "開示", "見込み", "廃止"],
      window: 40,
    },
    PRODUCT_UNRELEASED: {
      slotA: ["次期", "新製品", "新モデル", "新機能", "試作", "開発中", "プロトタイプ", "リコール", "不具合"],
      slotB: ["発表", "発売", "リリース", "仕様", "投入", "公表", "隠", "伏せ", "回収"],
      window: 40,
    },
    DEAL_TERMS: {
      slotA: ["入札", "見積", "契約", "受注", "失注", "コンペ", "提案"],
      slotB: ["価格", "額", "金額", "条件", "内容", "調整", "見込み", "結果"],
      window: 40,
    },
    LEGAL_DISPUTE: {
      slotA: ["訴訟", "提訴", "和解", "行政処分", "立入検査", "内部告発", "係争", "審査"],
      slotB: ["準備", "検討", "進行", "金", "案", "対応", "中"],
      window: 40,
    },
  };

  // 明示的な機密マーカー。これだけは単独で発火してよい —
  // ほぼ無変化で precision が極めて高い、このゲートの核。
  const EXPLICIT_MARKER =
    /社外秘|部外秘|厳秘|極秘|マル秘|㊙|\(秘\)|（秘）|取扱注意|秘密保持|NDA|confidential|internal use only|do not (?:forward|distribute|share)|proprietary and confidential/iu;

  // 秘匿シグナルは 3 レジスタに分ける。formal しか持っていなかったのが
  // 初期プロトタイプの recall が低かった一因。
  const SECRECY = [
    // 改まった言い方
    /社外秘|部外秘|厳秘|極秘|マル秘|㊙|\(秘\)|（秘）|取扱注意|秘密保持|NDA|confidential/iu,
    // 時制・相 — 「まだ外に出していない」
    /未発表|未公開|未公表|非公開|発表前|公表前|リリース前|解禁前|上場前|公表(?:して|されて)?(?:い)?(?:ない|ません)|オフィシャルじゃない|オフィシャルではない/u,
    // 口語の否定可能形 — ここが最も見落とされやすい
    /(?:知られ|漏れ|出せ|言え|話せ|公開でき|公表でき|開示でき|外に出せ|外に出さ|外には出せ|外には出さ)(?:たくない|ない|ぬ|ません)|言わないで|内緒|内密|内々|ないない|オフレコ|ここだけ|口外|他言|伏せ(?:て|る)/u,
  ];

  // 未確定・進行中を示す語。単独では弱いが topic と組むと効く。
  const PROSPECTIVE =
    /予定|方針|検討(?:中|して)|見込み|見通し|進行中|交渉中|最終段階|調整中|来期|次期|来月|来年度|翌期|今後|計画|たたき台|ドラフト|らしい|とのこと/u;

  // 既に公表済みを示す打ち消し。「買収が発表された」と
  // 「買収交渉が進行中」を分けるために必須。
  const PUBLIC_SIGNAL =
    /(?:発表|公表|公開|リリース|開示|報道)(?:され|し)(?:た|ました|ている|ています)|プレスリリース|ニュースで|既報|報道によ/u;

  // 一般論・学習目的を示す語。「M&Aの基礎知識」を落とすため。
  const GENERIC_QUERY =
    /とは|一般論|基礎知識|教えて|解説|読み方|語源|相場観|流れを|おすすめ|勉強|について調べ|方法を|手順/u;

  // ---- 分文 ------------------------------------------------------------
  // 窓が話題をまたいで漏れないよう、文境界で必ず切る。
  function splitSentences(text) {
    const out = [];
    let start = 0;
    const re = /[。．！？\n]|\. /g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const end = m.index + m[0].length;
      if (end > start) out.push({ start, end, text: text.slice(start, end) });
      start = end;
    }
    if (start < text.length) out.push({ start, end: text.length, text: text.slice(start) });
    return out.filter((s) => s.text.trim().length > 0);
  }

  // slotA と slotB が window 文字以内に共起するか。順序は問わない。
  function frameHit(sentence, family) {
    const aHits = [];
    for (const a of family.slotA) {
      const i = sentence.indexOf(a);
      if (i !== -1) aHits.push({ term: a, at: i });
    }
    if (aHits.length === 0) return null;
    for (const a of aHits) {
      for (const b of family.slotB) {
        const j = sentence.indexOf(b);
        if (j === -1) continue;
        if (Math.abs(j - a.at) <= family.window) {
          return { a: a.term, b, distinct: aHits.length };
        }
      }
    }
    return null;
  }

  // 短すぎる断片はノイズでスコアが立つので足切りする。
  const MIN_LENGTH = 12;

  function scoreSentence(s, ctx) {
    const explicit = s.match(EXPLICIT_MARKER);
    // 明示マーカーは単独成立 — 長さ足切りも通さない。
    if (explicit) {
      return { score: 1, families: [], signals: { explicit: explicit[0] }, reason: "explicit" };
    }
    if (s.length < MIN_LENGTH) return null;
    ctx = typeof ctx === "string" ? ctx : s;

    const families = [];
    let frames = null;
    for (const [name, fam] of Object.entries(FAMILIES)) {
      const hit = frameHit(s, fam);
      if (hit) {
        families.push(name);
        frames = frames || hit;
      }
    }
    if (families.length === 0) return null;

    // 秘匿シグナルは文をまたぐ。「工場の統廃合を決議します。対外的には
    // まだ伏せてください。」のように、トピックと「外に出すな」が別の文に
    // 分かれるのは普通の書き方なので、前後 120 字を見る (Purview /
    // GCP DLP の proximity rule と同じ考え方)。トピック側の A×B 窓は
    // 文内に閉じたままにして、話題の混線は防ぐ。
    let secrecy = null;
    for (const re of SECRECY) {
      const m = ctx.match(re);
      if (m) { secrecy = m[0]; break; }
    }
    const prospective = s.match(PROSPECTIVE);
    const isPublic = s.match(PUBLIC_SIGNAL);
    const isGeneric = s.match(GENERIC_QUERY);

    // フレーム成立 = 0.45 を基礎点にし、支持シグナルで積む。
    // 各シグナルは 1 回しか加点しない (繰り返しで段階が上がらない)。
    let score = 0.45;
    if (secrecy) score += 0.45;
    if (prospective) score += 0.2;
    if (families.length > 1) score += 0.1;
    // 既報・一般論は強く減点する。ここが precision の主戦場。
    if (isPublic) score -= 0.6;
    if (isGeneric) score -= 0.5;

    score = Math.max(0, Math.min(1, score));
    return {
      score,
      families,
      signals: {
        topic: frames ? `${frames.a}…${frames.b}` : null,
        secrecy,
        prospective: prospective ? prospective[0] : null,
        public: isPublic ? isPublic[0] : null,
        generic: isGeneric ? isGeneric[0] : null,
      },
      reason: "frame",
    };
  }

  const DEFAULT_THRESHOLD = 0.6;

  // 文単位の検出を返す。span 形 ({start,end,text}) は既存の検出と
  // 同じ形にしてあるが、entity_type ではなく families を持ち、
  // action は "flagged" — マスクはしない。
  function detectConfidential(text, options) {
    const opts = options || {};
    const threshold = typeof opts.threshold === "number" ? opts.threshold : DEFAULT_THRESHOLD;
    const out = [];
    for (const sent of splitSentences(text || "")) {
      const SUPPORT_WINDOW = 120;
      const ctx = text.slice(
        Math.max(0, sent.start - SUPPORT_WINDOW),
        Math.min(text.length, sent.end + SUPPORT_WINDOW),
      );
      const r = scoreSentence(sent.text, ctx);
      if (r && r.score >= threshold) {
        out.push({
          entity_type: "BUSINESS_CONFIDENTIAL",
          start: sent.start,
          end: sent.end,
          text: sent.text,
          score: r.score,
          action: "flagged",
          families: r.families,
          signals: r.signals,
          reason: r.reason,
        });
      }
    }
    return out;
  }

  const api = {
    FAMILIES, EXPLICIT_MARKER, DEFAULT_THRESHOLD,
    splitSentences, scoreSentence, detectConfidential,
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") {
    root.__localMaskMCP = root.__localMaskMCP || {};
    root.__localMaskMCP.engine = root.__localMaskMCP.engine || {};
    Object.assign(root.__localMaskMCP.engine, { confidential: api });
  }
})(typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : globalThis);
