// engine/patterns.js — pure-JS port of src/app/services/analyzers/presets.py.
// Every preset category exposes { entity_type, pattern: RegExp } tuples
// with /gu flags. UMD-ish attach: CommonJS (Node) + window.__localMaskMCP.engine.
"use strict";

(function attach(root) {
  // Dictionary module (JP surnames / prefectures / world countries / ...).
  // Loaded via ENGINE_FILES ordering (content.js) before this file, or
  // required directly in Node/CommonJS contexts (tests).
  const dicts =
    (typeof module === "object" && module.exports && typeof require === "function")
      ? (() => { try { return require("./dictionaries.js"); } catch (_) { return null; } })()
      : (root && root.__localMaskMCP && root.__localMaskMCP.engine && root.__localMaskMCP.engine.dictionaries) || null;

  // Shorthand so the table below stays readable. ``validate`` is
  // optional: when present, collectDetections drops a match for which it
  // returns false. Needed where a regex cannot express the constraint —
  // card numbers carry a check digit, and without verifying it a 16-digit
  // order number masks as a credit card.
  const T = (entity_type, pattern, validate) =>
    validate ? { entity_type, pattern, validate } : { entity_type, pattern };

  // ---- 住所 ------------------------------------------------------------
  // 以前は都道府県を `.{2,3}県` というワイルドカードで書いていたため
  // 「隣の県」が都道府県として通り、続く `[^\s、。,]{0,20}` が貪欲に
  // 助詞や動詞まで飲み込んでいた:
  //   本件は隣の県の市場で検証する -> ADDRESS「は隣の県の市場で検証する」
  //   兵庫県明石市の事務所に…      -> ADDRESS「兵庫県明石市の事務所に…」
  // dictionaries.js が持つ 47 都道府県の正確なリストで anchor し、街区
  // 部分に使える文字を住所に出うるものだけに制限する。
  const PREF_ALT = dicts
    ? dicts.JP_PREFECTURES.join("|")
    : "北海道|東京都|京都府|大阪府";
  // 市区町村。[市区町村郡] を除外した char class で「最初の suffix」で止める。
  const CITY_PART = "[^\\s、。,市区町村郡]{1,6}[市区町村郡]";
  // 街区 (町名・丁目・番地)。先頭は漢字/カタカナ/数字に限る — ここを
  // 「の」始まりまで許すと「明石市の事務所」を住所として飲んでしまう。
  // 2 文字目以降は「丸の内」のような地名のために「の」を許す。
  const STREET_PART =
    "[\\p{Script=Han}\\p{Script=Katakana}0-9０-９]" +
    "[\\p{Script=Han}\\p{Script=Katakana}0-9０-９ーの\\-‐－]*";
  const PREFECTURE_CITY_RE = new RegExp(`(?:${PREF_ALT})${CITY_PART}`, "gu");
  const ADDRESS_RE = new RegExp(`(?:${PREF_ALT})${CITY_PART}${STREET_PART}`, "gu");

  // Luhn (ISO/IEC 7812-1) check digit — every payment card carries one.
  function luhnValid(surface) {
    const digits = surface.replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) return false;
    let sum = 0;
    let double = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let d = digits.charCodeAt(i) - 48;
      if (double) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
      double = !double;
    }
    return sum % 10 === 0;
  }

  // 法人番号 (国税庁) のチェックディジット。
  // 先頭 1 桁 = 9 − ((2·Σ偶数位 + Σ奇数位) mod 9)。位は下位から 1 始まり。
  // 13 桁の裸マッチは FP が高いので、この検証と必ず対で使う。
  function corporateNumberValid(surface) {
    const d = surface.replace(/\D/g, "");
    if (d.length !== 13) return false;
    const check = Number(d[0]);
    const body = d.slice(1); // 12 桁
    let sum = 0;
    for (let i = 0; i < 12; i++) {
      // body[11] が 1 位。i=11 -> pos 1
      const pos = 12 - i;
      sum += Number(body[i]) * (pos % 2 === 0 ? 2 : 1);
    }
    return check === 9 - (sum % 9);
  }

  // IBAN (ISO 13616) の mod-97 検証。先頭 4 文字を末尾に回し、英字を
  // A=10..Z=35 に開いた 10 進大数の 97 剰余が 1 になる。
  function ibanValid(surface) {
    const s = surface.replace(/[\s-]/g, "").toUpperCase();
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
    const rearranged = s.slice(4) + s.slice(0, 4);
    let rem = 0;
    for (const ch of rearranged) {
      const part = ch >= "A" && ch <= "Z"
        ? String(ch.charCodeAt(0) - 55)
        : ch;
      for (const digit of part) rem = (rem * 10 + Number(digit)) % 97;
    }
    return rem === 1;
  }

  const BUILTIN_PATTERNS = {
    // 都道府県+市区町村 単体 (兵庫県明石市 / 東京都渋谷区 など)。
    // 中間 char class は [市区町村郡] を除外して「最初の suffix」で
    // 止まるようにしている。これがないと「明石市大久保町」のように
    // 町名まで貪欲に飲み込まれる。street が続くフル住所は ADDRESS が
    // longer span を取るため衝突しない。
    PREFECTURE_CITY: [T("PREFECTURE_CITY", PREFECTURE_CITY_RE)],
    // 住所 (町名・番地まで含むフル住所)。PREFECTURE_CITY + 街区部分。
    ADDRESS: [T("ADDRESS", ADDRESS_RE)],
    // 年齢 / 性別
    AGE: [T("AGE", /\d{1,3}\s*(?:歳|才)/gu)],
    // 「その他」は業務文書で最頻出の語なので性別ラベルから外す。
    // 後続が漢字/カタカナなら複合語 (男性ホルモン / 女性誌) とみなす。
    GENDER: [T("GENDER", /(?:男性|女性)(?![\p{Script=Han}\p{Script=Katakana}ー])/gu)],
    // 金額
    MONETARY_AMOUNT: [
      T("MONETARY_AMOUNT", /[¥￥]\s*[\d,]+(?:\.\d+)?(?:\s*円)?/gu),
      T("MONETARY_AMOUNT", /\d[\d,]*\s*(?:円|ドル|万円|億円)/gu),
      T("MONETARY_AMOUNT", /\$\s*[\d,]+(?:\.\d+)?/gu),
    ],
    // 日付
    DATE: [
      T("DATE", /\d{4}[/\-年]\d{1,2}[/\-月]\d{1,2}日?/gu),
      T("DATE", /(?:令和|平成|昭和|大正)\s*\d{1,2}\s*年(?:\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?)?/gu),
    ],
    // 会社名 — char class は [カタカナ + 漢字 + 半角英数 + 社名記号] に限定
    // することで、ひらがな助詞 (の / から / で / に / を / も / は / が …)
    // で必ず break する。これで「株式会社アクメの田中部長から連絡」が
    // `株式会社アクメ` で止まる (以前は全文を 1 entity 化していた)。
    COMPANY: [
      T(
        "COMPANY",
        // 法人格の直後が一般名詞のときは社名ではない (株式会社設立の件)。
        /(?:株式会社|有限会社|合同会社|一般社団法人|一般財団法人|NPO法人|学校法人|医療法人)\s*(?!設立|登記|概要|制度|一覧|様|御中|各位|とは|について)[\p{Script=Katakana}\p{Script=Han}A-Za-z0-9・ー＆&\-]{1,20}/gu,
      ),
      T(
        "COMPANY",
        // 検出は NFKC 正規化後のテキストに対して行うため、合字 ㈱ / ㈲ は
        // この時点で (株) / (有) に展開されている。リテラル ㈱ だけを
        // 書いていると「アクメ㈱」を取りこぼす。展開形を並べておけば
        // 元テキストが ㈱ でも (株) でも同じように当たる。
        /[\p{Script=Katakana}\p{Script=Han}A-Za-z0-9・ー＆&\-]{1,20}(?:株式会社|有限会社|合同会社|\(株\)|\(有\)|㈱|㈲|Inc\.|Corp\.|Ltd\.|LLC|Co\.,?\s*Ltd\.)/gu,
      ),
    ],
    // 通信
    // オクテットを 0-255 に制限。以前は \d{1,3} だったため
    // 999.888.777.666 や Node の v22.16.0 まで IP として拾っていた。
    IP_ADDRESS: [T("IP_ADDRESS", /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.])/gu)],
    // 末尾 1 文字を「句読点でない」に強制することで、文末の . や
    // 閉じ括弧を URL に巻き込まない (https://example.com/a. → …/a)。
    URL: [T("URL", /https?:\/\/[^\s<>"'、。）)]*[^\s<>"'、。）).,;:!?！？]/gu)],
    // クレジットカード — IIN で絞ったうえで Luhn 検証する。
    //
    // 以前は patterns.js にパターン自体が無く (categories / severity /
    // classification / surrogates には CREDIT_CARD が登録済みだった)、
    // 実際には別ラベルが部分マッチして桁が漏れていた:
    //   4111-1111-1111-1111 -> 4<POSTAL_CODE_1>-1<POSTAL_CODE_1>
    //   4111 1111 1111 1111 -> <MY_NUMBER_1> 1111
    //   4111111111111111    -> 素通り
    // IIN を列挙せず 13-19 桁 + Luhn だけにすると、Luhn は 1/10 の確率で
    // 偶然通るため発注番号等が誤検出される。両方を課している。
    CREDIT_CARD: [
      // Visa / Mastercard / JCB / Discover / UnionPay — 16 桁 (4-4-4-4)
      T(
        "CREDIT_CARD",
        /\b(?:4\d{3}|5[1-5]\d{2}|2(?:2[2-9]\d|[3-6]\d{2}|7[01]\d|720)|35(?:2[89]|[3-8]\d)|6(?:011|5\d{2}|4[4-9]\d)|62\d{2})[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/gu,
        luhnValid,
      ),
      // American Express — 15 桁 (4-6-5)
      T("CREDIT_CARD", /\b3[47]\d{2}[ -]?\d{6}[ -]?\d{5}\b/gu, luhnValid),
      // Diners Club — 14 桁 (4-6-4)
      T("CREDIT_CARD", /\b3(?:0[0-5]\d|[68]\d{2})[ -]?\d{6}[ -]?\d{4}\b/gu, luhnValid),
    ],
    // マイナンバー / 口座 / 免許 / パスポート
    // 12 桁。区切りは「無し / 半角空白 / ハイフン」のみ受け、\s は使わない。
    // \s は改行を含むため、以前は
    //   "C-00045872\n2026-09-22 18:15 INFO ..."
    // の 00045872 と次行の 2026 を 1 span として飲み込み、ログ行を
    // 丸ごと破壊していた。前後の境界も課して長い数字列の内部に
    // 食い込まないようにする。
    MY_NUMBER: [T("MY_NUMBER", /(?<![\d-])\d{4}[ -]?\d{4}[ -]?\d{4}(?![\d-])/gu)],
    // 以前は 普通/当座/貯蓄 のいずれかが literal で必要だったため、
    // 「口座番号 1234567」のような最も普通の書き方で 0 件だった。
    BANK_ACCOUNT: [
      T("BANK_ACCOUNT", /(?:普通|当座|貯蓄)\s*(?:口座)?\s*(?:番号)?\s*[:：]?\s*\d{6,8}/gu),
      T("BANK_ACCOUNT", /(?:口座番号|口座\s*No\.?|Account\s*(?:Number|No\.?))\s*(?:は|[:：=＝])?\s*\d{6,8}(?!\d)/giu),
    ],
    // 運転免許証番号 — 12 桁。区切りを必須にしている点が重要で、以前は
    // 全ての区切りが optional だったため実質 /\b\d{12}\b/ に退化し、
    // マイナンバー (同じ 12 桁) と完全に同一 span を取り合っていた。
    // 同一 span を 2 ラベルが取ると maskAggregated と maskSanitize で
    // tie-break がずれ、サイドバーの表示と実際に送信される文字列が
    // 食い違う。区切り無しの 12 桁は MY_NUMBER に委ねる。
    DRIVERS_LICENSE: [
      // 文脈語が添えられていれば区切り無しの 12 桁でも免許証と判断する。
      // これが無いと「運転免許証番号：第123456789012号」が
      // マイナンバー扱いになり、サイドバーの表示が実態とずれる。
      T("DRIVERS_LICENSE", /(?:運転)?免許(?:証)?(?:番号|No\.?)?[^\S\n]*(?:は|が|[:：=＝])?[^\S\n]*第?[ -]?\d{12}(?![\d-])/gu),
      T("DRIVERS_LICENSE", /(?<![\d-])\d{2}[ -]\d{2}[ -]\d{6}[ -]\d{2}(?![\d-])/gu),
    ],
    PASSPORT: [T("PASSPORT", /\b[A-Z]{2}\d{7}\b/gu)],
    // シークレット — API_KEY とは独立したカテゴリに置く。
    //
    // 以前はこの 2 本が API_KEY: 配列の中に物理的に同居していたため、
    // getPresetPatterns に disabledCategories:["API_KEY"] を渡すと
    // PEM 秘密鍵の検出まで道連れで消えた。現状この引数は UI から
    // 渡されていないので実害は出ていないが、カテゴリ絞り込みの UI を
    // 後から足した人が踏む罠なので、気づいた時点で分離しておく。
    SECRET: [
      T("SECRET", /(?:password|secret|token|api_key|apikey|access_token)\s*[=:]\s*\S{8,}/giu),
      // URL に埋め込まれた認証情報。DB_CONNECTION はスキームを 6 個
      // ハードコードしているので amqp / mssql / clickhouse 等を取りこぼす。
      T("SECRET", /\b[a-z][a-z0-9+.\-]{1,20}:\/\/[^\s:@\/]{1,64}:[^\s@\/]{1,128}@[^\s"'<>、。]{1,255}/giu),
      // .env / CI の変数ダンプ。キー名に秘密を示す語が入っているものだけ
      // 拾うので、HOME=/root のような無害な行には当たらない。
      T("SECRET", /(?:^|\n)\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]{0,48}(?:SECRET|TOKEN|KEY|PASSWORD|PASSWD|PWD|CREDENTIAL|PRIVATE|APIKEY)[A-Za-z0-9_]{0,24}\s*=\s*(?:"[^"\n]{4,}"|'[^'\n]{4,}'|[^\s#\n]{4,})/giu),
      T("SECRET", /-----BEGIN(?:\s[A-Z]+)?\s(?:RSA|EC|OPENSSH|DSA|PGP)?\s?PRIVATE KEY-----[\s\S]*?-----END(?:\s[A-Z]+)?\s(?:RSA|EC|OPENSSH|DSA|PGP)?\s?PRIVATE KEY-----/gu),
    ],
    // DB 接続 / API キー / シークレット
    DB_CONNECTION: [
      T("DB_CONNECTION", /(?:mysql|postgresql|postgres|mongodb|redis|sqlite):\/\/[^\s]+/gu),
      T("DB_CONNECTION", /(?:database|db_name|dbname|DB_HOST|DB_NAME)\s*[=:]\s*[^\s,;]+/gu),
    ],
    API_KEY: [
      // --- Generic catch-alls (kept for backwards compat) ------------
      // ``i`` フラグは generic 系のみ。.env / CI の変数ダンプや
      // Authorization ヘッダは PASSWORD= / API_KEY= のように大文字で
      // 書かれることが多く、小文字限定では取りこぼす。逆に下の
      // ベンダー固有プレフィックス (AKIA / ghp_ / SG.) は大文字小文字が
      // 仕様の一部なので ``i`` を付けない — 付けると精度が落ちる。
      T("API_KEY", /(?:sk|pk|api[_\-]?key|access[_\-]?key)[_\-][\w\-]{20,}/giu),

      // --- Vendor-specific well-known token formats ------------------
      // Patterns below anchor on the exact prefix each vendor uses
      // (typically a 2–10 char opaque namespace) so they fire reliably
      // without the false positives generic "sk-anything" would
      // produce. Ordered vaguely by popularity. Documented in
      // README.md and browser-extension/README.md.

      // OpenAI — classic / project / service-account / legacy-null
      T("API_KEY", /\bsk-(?:proj|svcacct|None)-[A-Za-z0-9_\-]{20,}/gu),
      T("API_KEY", /\bsk-[A-Za-z0-9]{32,}\b/gu),
      // Anthropic
      T("API_KEY", /\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_\-]{80,}/gu),
      // Notion — new `ntn_` integration tokens + legacy `secret_`
      T("API_KEY", /\bntn_[A-Za-z0-9]{40,}\b/gu),
      T("API_KEY", /\bsecret_[A-Za-z0-9]{43}\b/gu),
      // GitHub — classic PAT family + fine-grained PAT
      T("API_KEY", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/gu),
      T("API_KEY", /\bgithub_pat_[A-Za-z0-9_]{80,}\b/gu),
      // Slack — bot / user / app / admin / refresh
      T("API_KEY", /\bxox[baprs]-[A-Za-z0-9\-]{10,}/gu),
      // Google Cloud / Firebase
      T("API_KEY", /\bAIza[A-Za-z0-9_\-]{35}\b/gu),
      T("API_KEY", /\bya29\.[A-Za-z0-9_\-]{40,}/gu),
      // AWS — access key IDs (AKIA/ASIA/…)
      T("API_KEY", /\b(?:AKIA|ASIA|AROA|AIDA|ANPA|ANVA|APKA|ABIA|ACCA)[A-Z0-9]{16}\b/gu),
      // AKIA… は「アクセスキー ID」で、実際に権限を持つのは secret 側。
      // ID だけ隠しても意味が薄いので secret も拾う。
      T("API_KEY", /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY|secretAccessKey)\s*[=:]\s*["']?[A-Za-z0-9\/+=]{40}["']?/giu),
      // Hugging Face
      T("API_KEY", /\bhf_[A-Za-z0-9]{34,}\b/gu),
      // Stripe — secret / publishable / restricted (live|test) + webhook secret
      T("API_KEY", /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{24,}\b/gu),
      T("API_KEY", /\bwhsec_[A-Za-z0-9]{32,}\b/gu),
      // Twilio — Account SID (AC) + API Key SID (SK)
      T("API_KEY", /\b(?:AC|SK)[a-f0-9]{32}\b/gu),
      // SendGrid
      T("API_KEY", /\bSG\.[A-Za-z0-9_\-]{22}\.[A-Za-z0-9_\-]{43}\b/gu),
      // Groq
      T("API_KEY", /\bgsk_[A-Za-z0-9]{40,}\b/gu),
      // Replicate
      T("API_KEY", /\br8_[A-Za-z0-9]{37,}\b/gu),
      // Tavily
      T("API_KEY", /\btvly-[A-Za-z0-9]{16,}\b/gu),
      // GitLab — personal access token / runner token
      T("API_KEY", /\b(?:glpat|glrt)-[A-Za-z0-9_\-]{20,}/gu),
      // Mailgun
      T("API_KEY", /\bkey-[a-f0-9]{32}\b/gu),
      // npm — automation / publishing
      T("API_KEY", /\bnpm_[A-Za-z0-9]{36}\b/gu),
      // Fireworks AI
      T("API_KEY", /\bfw_[A-Za-z0-9]{24,}\b/gu),
      // Airtable — personal access tokens
      T("API_KEY", /\bpat[A-Za-z0-9]{14}\.[a-f0-9]{64}\b/gu),
      // Linear
      T("API_KEY", /\blin_(?:api|oauth)_[A-Za-z0-9]{32,}\b/gu),
      // Figma
      T("API_KEY", /\bfigd_[A-Za-z0-9_\-]{40,}/gu),
      // Perplexity
      T("API_KEY", /\bpplx-[A-Za-z0-9]{32,}\b/gu),
      // OpenRouter
      T("API_KEY", /\bsk-or-v1-[A-Za-z0-9]{40,}\b/gu),
      // Discord bot token
      T("API_KEY", /\b[MN][A-Za-z\d]{23}\.[\w\-]{6}\.[\w\-]{27,}\b/gu),
      // Cloudflare API tokens (40 base64url chars after slash-free prefix)
      T("API_KEY", /\bcf-[A-Za-z0-9_\-]{40,}/gu),
      // Supabase service_role / anon keys are JWTs — covered below
      // JWT — three base64url segments. Greedy but safe: header ``eyJ``
      T("API_KEY", /\beyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/gu),
      // Authorization: Bearer <token>
      T("API_KEY", /\bBearer\s+[A-Za-z0-9\-_.~+/]{16,}=*/giu),
      // Generic "Authorization:" header value
      T("API_KEY", /(?:Authorization|X-Api-Key)\s*:\s*\S{16,}/giu),
    ],
    // プロジェクト / 内部 ID
    INTERNAL_ID: [
      T("INTERNAL_ID", /\b(?:PRJ|PJ|PROJ|PROJECT)[_\-][\w\-]{3,20}\b/gu),
      T("INTERNAL_ID", /\b(?:EMP|STAFF)[_\-]\d{4,10}\b/gu),
      T("INTERNAL_ID", /\b(?:TICKET|ISSUE|TASK)[_\-]\d{3,10}\b/gu),
    ],
    // 電話 (日本)
    PHONE_NUMBER_JP: [
      // 区切りは「ハイフン統一」か「括弧で囲う」のどちらか。以前は
      // [-(] と [-)] が独立していたため 03-1234)5678 が通っていた。
      T("PHONE_NUMBER", /(?<![\d-])0\d{1,4}(?:-\d{1,4}-|\(\d{1,4}\))\d{3,4}(?![\d-])/gu),
      T("PHONE_NUMBER", /(?<![\d-])0[789]0\d{8}(?![\d-])/gu),
    ],
    // メール (寛容 — 新 gTLD 対応)
    EMAIL_ADDRESS: [T("EMAIL_ADDRESS", /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,63}\b/gu)],
    // カタカナ名 — 文脈ゲート方式。
    //
    // 以前は /[ァ-ヶー]{4,}/ = 「4 文字以上のカタカナは人名」という
    // 無条件ルールで、アプリケーション / インストール / ホルモン /
    // ワクチン のような外来語を軒並み人名として拾っていた。
    // blocklist.js で打ち消そうとしても、日本語の外来語は新語が無限に
    // 増える開いた語彙なので、否定リストは原理的に追いつかない。
    //
    // そこで極性を反転し、「人名が置かれる文脈」という閉じた条件で
    // 拾う。閉じたルールは開いた語彙に対して収束する。
    // blocklist は残すが、この 3 ルールが捕らえた run にだけ効かせる
    // (例: 「マネージャーさん」は (b) に当たるが blocklist が落とす)。
    // 文脈の無い裸の言及は諦める — そこは ML (NER) の担当。
    KATAKANA_NAME: [
      // (a) 中黒を挟むフルネーム: マイケル・ジョーダン
      T("KATAKANA_NAME", /[ァ-ヶー]{2,10}[・･][ァ-ヶー]{2,12}/gu),
      // (b) 敬称・役職が後続: ジョンソン部長 / アクメさん
      T(
        "KATAKANA_NAME",
        /[ァ-ヶー]{2,12}(?=\s*(?:さん|サン|様|さま|氏|くん|君|ちゃん|先生|殿|部長|課長|係長|社長|専務|常務|取締役|主任|本部長|支店長))/gu,
      ),
      // (c) 氏名を宣言する語が前置: 氏名: タナカタロウ
      T(
        "KATAKANA_NAME",
        /(?<=(?:氏名|名前|本名|姓名|フルネーム|フリガナ|ふりがな|カナ|セイメイ|担当者?|申込者|契約者|お客様|受取人|宛名)\s*(?:は|[:：=＝])[^\S\n]*)[ァ-ヶー]{2,12}(?:[ 　][ァ-ヶー]{2,12})?/gu,
      ),
    ],
    // 略称の企業参照 (A社 / 甲社)。
    //
    // A社・甲社はそれ自体が既に仮名なので、マスクしても privacy の
    // 利得はほぼ無く、置換するとプロンプトが読みにくくなるだけ。
    // それでも拾う理由は (i) 別の場所にある対応表と突き合わせると実名に
    // 戻せる、(ii) 「甲社との協議」のような文が機密判定の材料になる、の
    // 2 点。したがって severity は low に置き、マスクではなく提示に留める。
    COMPANY_ABBREV: [
      T(
        "COMPANY_ABBREV",
        /(?<![\p{Script=Han}\p{Script=Katakana}A-Za-z0-9])(?:[A-Za-zＡ-Ｚａ-ｚ]|甲|乙|丙|丁)社(?![\p{Script=Han}])/gu,
      ),
    ],
    // ---- 日本の事業者識別番号 ------------------------------------------
    // 法人番号は文脈付きと裸の 2 形。裸の 13 桁は FP が高いので
    // チェックディジット検証を必須にしている。
    CORPORATE_NUMBER: [
      T("CORPORATE_NUMBER", /(?:法人番号|会社法人等番号)\s*(?:は|[:：=＝])?\s*\d{13}(?!\d)/gu, corporateNumberValid),
      T("CORPORATE_NUMBER", /(?<![\d\-/])[1-9]\d{12}(?![\d\-/])/gu, corporateNumberValid),
    ],
    // 適格請求書発行事業者登録番号 (インボイス制度, 2023-)。請求書に必須
    // なので「この請求書を要約して」の形で日常的に貼られる。
    // Tron の暗号資産アドレスも T 始まりなので、順序はこちらを先に。
    INVOICE_REG_NUMBER: [
      T("INVOICE_REG_NUMBER", /(?<![A-Za-z0-9])[Tt][\s\-‐]?\d{13}(?!\d)/gu),
    ],

    // ---- 所属先 ----------------------------------------------------------
    // 学校・園の名称。子供の居場所が特定できるため PII として扱う。
    // 「学校の制度について」のような一般名詞用法に当たらないよう、
    // 校種を表す接尾辞を必須にし、その手前に名称部分を要求する。
    SCHOOL_NAME: [
      T(
        "SCHOOL_NAME",
        /[\p{Script=Han}\p{Script=Katakana}A-Za-z0-9ー・]{1,20}(?:小学校|中学校|高等学校|高校|大学院|大学|専門学校|高等専門学校|幼稚園|保育園|こども園|認定こども園|養護学校|支援学校)/gu,
      ),
    ],
    // 端末識別子。ラベル語が添えられている場合のみ拾う — 形だけでは\n    // 一般的なハイフン付き文字列と区別できない。
    DEVICE_ID: [
      T(
        "DEVICE_ID",
        /(?:端末(?:識別子|ID|番号)|デバイス(?:ID|識別子)|device[_\s-]?id|udid|idfa|advertising[_\s-]?id)[^\S\n]*(?:は|が|[:：=＝])?[^\S\n]*[A-Za-z0-9][\w\-]{5,}/giu,
      ),
    ],

    // ---- 社内ネットワーク ------------------------------------------------
    MAC_ADDRESS: [
      T("MAC_ADDRESS", /(?<![\w:.\-])(?:[0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}(?![\w:.\-])/gu),
    ],
    IP_CIDR: [
      T("IP_CIDR", /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}\/(?:3[0-2]|[12]?\d)(?![\d.])/gu),
    ],
    // 社内ホスト名。公開 TLD ではなく内部専用 TLD で終わるものだけ。
    INTERNAL_HOSTNAME: [
      T(
        "INTERNAL_HOSTNAME",
        /(?<![\w.\-])[a-z0-9][a-z0-9\-]{0,62}(?:\.[a-z0-9][a-z0-9\-]{0,62})*\.(?:local|internal|intranet|corp|lan|localdomain)(?![\w.\-])/giu,
      ),
    ],

    // ---- 国際的な識別子 --------------------------------------------------
    IBAN: [
      T("IBAN", /(?<![A-Z0-9])[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,3})?(?![A-Z0-9])/gu, ibanValid),
    ],
    // 米国 SSN。先頭 000/666/9xx、中 00、末尾 0000 は発行されない。
    // 広告で使われる予約帯 987-65-432x も除外する。
    US_SSN: [
      T("US_SSN", /(?<![\d\-])(?!000|666|9\d\d)(?!987-65-432)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\d\-])/gu),
    ],
    // 英国 NINO。HMRC が発行しない接頭字 (D/F/I/Q/U/V 始まり、O 2文字目) を除外。
    UK_NINO: [
      T("UK_NINO", /(?<![A-Z0-9])[ABCEGHJ-PRSTW-Z][ABCEGHJ-NPRSTW-Z]\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D](?![A-Z0-9])/gu),
    ],

    // ---- 暗号資産 --------------------------------------------------------
    // 拡張秘密鍵 (*prv) はウォレット全体の掌握に直結するので最優先。
    CRYPTO_ADDRESS: [
      T("CRYPTO_ADDRESS", /(?<![A-Za-z0-9])(?:xprv|yprv|zprv|xpub|ypub|zpub)[1-9A-HJ-NP-Za-km-z]{100,112}(?![A-Za-z0-9])/gu),
      T("CRYPTO_ADDRESS", /(?<![A-Za-z0-9])bc1[02-9ac-hj-np-z]{11,71}(?![A-Za-z0-9])/gu),
      T("CRYPTO_ADDRESS", /(?<![A-Za-z0-9])0x[a-fA-F0-9]{40}(?![A-Za-z0-9])/gu),
    ],

    // ---- 貼り付けの形そのものが PII を運ぶケース --------------------------
    // 転送メールのヘッダ貼り付けは、1 回で最も多くの PII が流入する経路。
    EMAIL_HEADER: [
      T("EMAIL_HEADER", /(?:^|\n)(?:From|To|Cc|Bcc|Reply-To|Message-ID)\s*:\s*[^\n]{3,200}/giu),
    ],
    COOKIE_HEADER: [
      T("COOKIE_HEADER", /(?:^|\n)(?:Set-)?Cookie\s*:\s*[^\n]{8,}/giu),
    ],
    // スタックトレースを貼ると OS ユーザー名がほぼ必ず混入する。
    LOCAL_USER_PATH: [
      T("LOCAL_USER_PATH", /(?:[A-Za-z]:\\Users\\|\/(?:home|Users)\/)[A-Za-z0-9._\-]{2,32}(?![A-Za-z0-9._\-])/gu),
    ],
    // API レスポンスのデバッグは開発者の最頻用途。PII キーの値だけ拾う。
    PII_JSON_FIELD: [
      T(
        "PII_JSON_FIELD",
        /"(?:e?mail(?:_?address)?|phone(?:_?number)?|tel|ssn|my_?number|address|birth(?:day|date)|dob|password|token)"\s*:\s*"[^"]{1,200}"/giu,
      ),
    ],

    // 業務文書系
    // ラベル語 (顧客番号 / 契約番号 …) の直後の区切りは optional。
    // 以前は \s*[:：=]\s* が必須だったため、日本語で自然な
    // 「顧客番号は12345です」「社員番号 A-9981」を 1 件も拾えなかった。
    // 区切りを緩めた分、値側を 3 文字以上の英数/ハイフンに絞って
    // 「顧客番号について相談したい」のような文に当たらないようにする。
    // 前後に数字やハイフンが続く場合は郵便番号ではない。境界が無いと
    // "ORD-20260920-785412" の中の "920-7854" に食い込んで注文番号を
    // 破壊し、"1234-5678-9012" では "234-5678" だけ隠して前後の桁を
    // 露出させていた。
    POSTAL_CODE: [T("POSTAL_CODE", /〒\s?\d{3}-\d{4}(?![\d-])|(?<![\d-])\d{3}-\d{4}(?![\d-])/gu)],
    DEPARTMENT: [
      T("DEPARTMENT", /\b(?:DEPT|DIV|DIVISION)[_\-]\d{2,6}\b/gu),
      T("DEPARTMENT", /(?:部署コード|部門コード)[^\\S\\n]*(?:は|が|[:：=＝])?[^\\S\\n]*[\w\-ー－]{3,}/gu),
    ],
    CONTRACT_NUMBER: [
      T("CONTRACT_NUMBER", /\b(?:CONTRACT|CNTR|AGR)[_\-][\w\-]{3,20}\b/gu),
      T("CONTRACT_NUMBER", /契約(?:番号|No\.?)[^\\S\\n]*(?:は|が|[:：=＝])?[^\\S\\n]*[\w\-ー－]{3,}/gu),
    ],
    PURCHASE_ORDER: [
      T("PURCHASE_ORDER", /\b(?:PO|P\.O\.|ORDER)[_\-]\d{4,10}\b/gu),
      T("PURCHASE_ORDER", /発注(?:番号|No\.?)[^\\S\\n]*(?:は|が|[:：=＝])?[^\\S\\n]*[\w\-ー－]{3,}/gu),
    ],
    CUSTOMER_ID: [
      T("CUSTOMER_ID", /\b(?:CUST|CUSTOMER|CLT)[_\-]\d{4,10}\b/gu),
      T("CUSTOMER_ID", /顧客(?:番号|ID|コード)[^\\S\\n]*(?:は|が|[:：=＝])?[^\\S\\n]*[\w\-ー－]{3,}/gu),
    ],
    INVOICE_NUMBER: [
      T("INVOICE_NUMBER", /\b(?:INV|INVOICE)[_\-]\d{4,10}\b/gu),
      T("INVOICE_NUMBER", /請求(?:書)?(?:番号|No\.?)[^\\S\\n]*(?:は|が|[:：=＝])?[^\\S\\n]*[\w\-ー－]{3,}/gu),
    ],
    EMPLOYEE_ID: [
      T("EMPLOYEE_ID", /(?:社員|従業員|スタッフ)(?:番号|ID|コード)[^\\S\\n]*(?:は|が|[:：=＝])?[^\\S\\n]*[\w\-ー－]{3,}/gu),
      T("EMPLOYEE_ID", /\b(?:STAFF|WORKER)[_\-]\d{3,10}\b/gu),
    ],
    MEMBER_ID: [
      T("MEMBER_ID", /会員(?:番号|ID|コード)[^\\S\\n]*(?:は|が|[:：=＝])?[^\\S\\n]*[\w\-ー－]{3,}/gu),
      T("MEMBER_ID", /\bMEMBER[_\-]\d{4,10}\b/gu),
    ],
    PATIENT_ID: [
      T("PATIENT_ID", /\b(?:PATIENT|MRN)[_\-]\d{4,10}\b/gu),
      T("PATIENT_ID", /(?:患者|診療)(?:番号|ID)[^\\S\\n]*(?:は|が|[:：=＝])?[^\\S\\n]*[\w\-ー－]{3,}/gu),
    ],
    SKU: [
      T("SKU", /\bSKU[_\-][\w\-]{3,20}\b/gu),
      T("SKU", /(?:製品|商品)(?:コード|番号)[^\\S\\n]*(?:は|が|[:：=＝])?[^\\S\\n]*[\w\-ー－]{3,}/gu),
    ],
    // 後続が漢字/カタカナなら別語 (A型肝炎 / B型インフルエンザ) とみなす。
    BLOOD_TYPE: [T("BLOOD_TYPE", /(?:AB|A|B|O)型(?![\p{Script=Han}\p{Script=Katakana}ー])/gu)],
    ANNUAL_INCOME: [
      T("ANNUAL_INCOME", /年収\s*[\d,]+\s*万?円?/gu),
      T("ANNUAL_INCOME", /月収\s*[\d,]+\s*万?円?/gu),
    ],
    PATENT_NUMBER: [
      T("PATENT_NUMBER", /(?:特許|特願|特公|特開)\s*\d{4}-?\d{6,}/gu),
      T("PATENT_NUMBER", /\b(?:JP|US|EP|WO)\s*\d{7,}\b/gu),
    ],
    ASSET_NUMBER: [
      T("ASSET_NUMBER", /\b(?:ASSET|FA)[_\-]\d{4,10}\b/gu),
      T("ASSET_NUMBER", /資産(?:番号|コード)[^\\S\\n]*(?:は|が|[:：=＝])?[^\\S\\n]*[\w\-ー－]{3,}/gu),
    ],
    LICENSE_NUMBER: [T("LICENSE_NUMBER", /\b(?:LIC|LICENSE)[_\-][\w\-]{4,20}\b/gu)],

    // ---- 辞書ベース fallback カテゴリ (dictionaries.js) -------------
    // Sudachi / Presidio が有効化されていない standalone 状態でも、
    // 日本の主要苗字・都道府県・政令指定都市・主要国名・Western 名
    // を確実にマスク対象にする。各カテゴリは dictionaries.js の
    // pre-compiled regex を参照。dicts が null の場合 (依存解決失敗)
    // は黙ってスキップする。
    ...(dicts ? {
      JP_SURNAME: [
        // ラベル付きの氏名フィールドは「山田 太郎」のように姓と名が
        // 空白で分かれる。敬称が付かないので下の敬称ルールでは届かず、
        // 姓だけ隠して名が露出していた。名だけ残すのはマスクしないより
        // 悪い — 残った語に「ここは人名」と印を付けて渡すことになる。
        T(
          "JP_SURNAME",
          new RegExp(
            "(?<=(?:氏名|名前|本名|姓名|フルネーム|受取人|宛名|担当者?|申込者|契約者)"
              + "[^\\S\\n]*(?:は|が|[:：=＝])[^\\S\\n]*)"
              + `(?:${dicts.JP_SURNAMES.join("|")})`
              + "[ 　]?[\\p{Script=Han}\\p{Script=Katakana}ヶヵー]{1,4}",
            "gu",
          ),
        ),
        // 姓+名を 1 span にまとめる。敬称が後続するときだけ名まで伸ばす。
        //
        // 以前は姓しか当たらず「田中太郎さん」が「<JP_SURNAME_1>太郎さん」に
        // なっていた。これはマスクしないより悪い — 残った「太郎」に対して
        // 「ここは人名だ」と印を付けて読めるまま渡すことになる。
        //
        // 敬称リストに役職 (部長 等) と助詞 (は 等) を入れていないのは
        // 意図的で、「は」を入れると「山田電機は好調」が人名になり、
        // 「部長」を入れると役職まで名前に飲み込まれる。役職が続く
        // 「田中部長」は下の素の JP_SURNAME_RE が「田中」で拾う。
        T(
          "JP_SURNAME",
          new RegExp(
            `(?:${dicts.JP_SURNAMES.join("|")})` +
              "[\\p{Script=Han}\\p{Script=Katakana}ヶヵー]{1,4}" +
              "(?=\\s*(?:さん|サン|様|さま|氏|くん|君|ちゃん|先生|殿|どの))",
            "gu",
          ),
        ),
        T("JP_SURNAME", dicts.JP_SURNAME_RE),
      ],
      JP_PREFECTURE_DICT: [T("JP_PREFECTURE_DICT", dicts.JP_PREFECTURE_RE)],
      JP_DESIGNATED_CITY: [T("JP_DESIGNATED_CITY", dicts.JP_DESIGNATED_CITY_RE)],
      WORLD_COUNTRY: [
        T("WORLD_COUNTRY", dicts.WORLD_COUNTRY_JP_RE),
        T("WORLD_COUNTRY", dicts.WORLD_COUNTRY_EN_RE),
      ],
      WESTERN_FIRST_NAME: [T("WESTERN_FIRST_NAME", dicts.WESTERN_FIRST_NAME_RE)],
    } : {}),
  };

  // Mirror of presets.get_preset_patterns(disabled_categories).
  function getPresetPatterns(disabledCategories) {
    const disabled = disabledCategories instanceof Set
      ? disabledCategories : new Set(disabledCategories || []);
    const out = [];
    for (const [category, patterns] of Object.entries(BUILTIN_PATTERNS)) {
      if (disabled.has(category)) continue;
      for (const p of patterns) out.push(p);
    }
    return out;
  }

  const api = { BUILTIN_PATTERNS, getPresetPatterns };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") {
    root.__localMaskMCP = root.__localMaskMCP || {};
    root.__localMaskMCP.engine = root.__localMaskMCP.engine || {};
    Object.assign(root.__localMaskMCP.engine, { patterns: api });
  }
})(typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : globalThis);
