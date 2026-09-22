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

  // Shorthand so the table below stays readable.
  const T = (entity_type, pattern) => ({ entity_type, pattern });

  const BUILTIN_PATTERNS = {
    // 都道府県+市区町村 単体 (兵庫県明石市 / 東京都渋谷区 など)。
    // 中間 char class は [市区町村郡] を除外して「最初の suffix」で
    // 止まるようにしている。これがないと「明石市大久保町」のように
    // 町名まで貪欲に飲み込まれる。street が続くフル住所は ADDRESS が
    // longer span を取るため衝突しない。
    PREFECTURE_CITY: [
      T(
        "PREFECTURE_CITY",
        /(?:北海道|(?:東京|京都|大阪)(?:都|府)|.{2,3}県)(?:[^\s、。,市区町村郡]{1,6}[市区町村郡])/gu,
      ),
    ],
    // 住所 (番地まで含むフル住所)
    ADDRESS: [T("ADDRESS", /(?:北海道|(?:東京|京都|大阪)(?:都|府)|.{2,3}県)(?:[^\s、。,]{1,6}[市区町村郡])[^\s、。,]{0,20}/gu)],
    // 年齢 / 性別
    AGE: [T("AGE", /\d{1,3}\s*(?:歳|才)/gu)],
    GENDER: [T("GENDER", /(?:男性|女性|その他)/gu)],
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
        /(?:株式会社|有限会社|合同会社|一般社団法人|一般財団法人|NPO法人|学校法人|医療法人)\s*[\p{Script=Katakana}\p{Script=Han}A-Za-z0-9・ー＆&\-]{1,20}/gu,
      ),
      T(
        "COMPANY",
        /[\p{Script=Katakana}\p{Script=Han}A-Za-z0-9・ー＆&\-]{1,20}(?:株式会社|有限会社|合同会社|㈱|㈲|Inc\.|Corp\.|Ltd\.|LLC|Co\.,?\s*Ltd\.)/gu,
      ),
    ],
    // 通信
    IP_ADDRESS: [T("IP_ADDRESS", /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/gu)],
    URL: [T("URL", /https?:\/\/[^\s<>"'、。）]+/gu)],
    // マイナンバー / 口座 / 免許 / パスポート
    MY_NUMBER: [T("MY_NUMBER", /\b\d{4}\s*\d{4}\s*\d{4}\b/gu)],
    BANK_ACCOUNT: [T("BANK_ACCOUNT", /(?:普通|当座|貯蓄)\s*(?:口座)?\s*(?:番号)?\s*[:：]?\s*\d{6,8}/gu)],
    // 運転免許証番号 — 12 桁。区切りを必須にしている点が重要で、以前は
    // 全ての区切りが optional だったため実質 /\b\d{12}\b/ に退化し、
    // マイナンバー (同じ 12 桁) と完全に同一 span を取り合っていた。
    // 同一 span を 2 ラベルが取ると maskAggregated と maskSanitize で
    // tie-break がずれ、サイドバーの表示と実際に送信される文字列が
    // 食い違う。区切り無しの 12 桁は MY_NUMBER に委ねる。
    DRIVERS_LICENSE: [T("DRIVERS_LICENSE", /\b\d{2}[\s-]\d{2}[\s-]\d{6}[\s-]\d{2}\b/gu)],
    PASSPORT: [T("PASSPORT", /\b[A-Z]{2}\d{7}\b/gu)],
    // DB 接続 / API キー / シークレット
    DB_CONNECTION: [
      T("DB_CONNECTION", /(?:mysql|postgresql|postgres|mongodb|redis|sqlite):\/\/[^\s]+/gu),
      T("DB_CONNECTION", /(?:database|db_name|dbname|DB_HOST|DB_NAME)\s*[=:]\s*[^\s,;]+/gu),
    ],
    API_KEY: [
      // --- Generic catch-alls (kept for backwards compat) ------------
      T("API_KEY", /(?:sk|pk|api[_\-]?key|access[_\-]?key)[_\-][\w\-]{20,}/gu),
      T("SECRET", /(?:password|secret|token|api_key|apikey|access_token)\s*[=:]\s*\S{8,}/gu),

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
      T("API_KEY", /\bBearer\s+[A-Za-z0-9\-_.~+/]{16,}=*/gu),
      // Generic "Authorization:" header value
      T("API_KEY", /(?:Authorization|X-Api-Key)\s*:\s*\S{16,}/giu),
      // PEM private keys (RSA / EC / OpenSSH / generic)
      T("SECRET", /-----BEGIN(?:\s[A-Z]+)?\s(?:RSA|EC|OPENSSH|DSA|PGP)?\s?PRIVATE KEY-----[\s\S]*?-----END(?:\s[A-Z]+)?\s(?:RSA|EC|OPENSSH|DSA|PGP)?\s?PRIVATE KEY-----/gu),
    ],
    // プロジェクト / 内部 ID
    INTERNAL_ID: [
      T("INTERNAL_ID", /\b(?:PRJ|PJ|PROJ|PROJECT)[_\-][\w\-]{3,20}\b/gu),
      T("INTERNAL_ID", /\b(?:EMP|STAFF)[_\-]\d{4,10}\b/gu),
      T("INTERNAL_ID", /\b(?:TICKET|ISSUE|TASK)[_\-]\d{3,10}\b/gu),
    ],
    // 電話 (日本)
    PHONE_NUMBER_JP: [
      T("PHONE_NUMBER", /0\d{1,4}[-(]\d{1,4}[-)]\d{3,4}/gu),
      T("PHONE_NUMBER", /\b0[789]0\d{8}\b/gu),
    ],
    // メール (寛容 — 新 gTLD 対応)
    EMAIL_ADDRESS: [T("EMAIL_ADDRESS", /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,63}\b/gu)],
    // カタカナ名 (ヒューリスティック)
    KATAKANA_NAME: [T("KATAKANA_NAME", /[ァ-ヶー]{4,}/gu)],
    // 業務文書系
    POSTAL_CODE: [T("POSTAL_CODE", /〒?\d{3}-\d{4}/gu)],
    DEPARTMENT: [
      T("DEPARTMENT", /\b(?:DEPT|DIV|DIVISION)[_\-]\d{2,6}\b/gu),
      T("DEPARTMENT", /(?:部署コード|部門コード)\s*[:：=]\s*[\w\-]+/gu),
    ],
    CONTRACT_NUMBER: [
      T("CONTRACT_NUMBER", /\b(?:CONTRACT|CNTR|AGR)[_\-][\w\-]{3,20}\b/gu),
      T("CONTRACT_NUMBER", /契約(?:番号|No\.?)\s*[:：=]\s*[\w\-]+/gu),
    ],
    PURCHASE_ORDER: [
      T("PURCHASE_ORDER", /\b(?:PO|P\.O\.|ORDER)[_\-]\d{4,10}\b/gu),
      T("PURCHASE_ORDER", /発注(?:番号|No\.?)\s*[:：=]\s*[\w\-]+/gu),
    ],
    CUSTOMER_ID: [
      T("CUSTOMER_ID", /\b(?:CUST|CUSTOMER|CLT)[_\-]\d{4,10}\b/gu),
      T("CUSTOMER_ID", /顧客(?:番号|ID|コード)\s*[:：=]\s*[\w\-]+/gu),
    ],
    INVOICE_NUMBER: [
      T("INVOICE_NUMBER", /\b(?:INV|INVOICE)[_\-]\d{4,10}\b/gu),
      T("INVOICE_NUMBER", /請求(?:書)?(?:番号|No\.?)\s*[:：=]\s*[\w\-]+/gu),
    ],
    EMPLOYEE_ID: [
      T("EMPLOYEE_ID", /(?:社員|従業員|スタッフ)(?:番号|ID|コード)\s*[:：=]\s*[\w\-]+/gu),
      T("EMPLOYEE_ID", /\b(?:STAFF|WORKER)[_\-]\d{3,10}\b/gu),
    ],
    MEMBER_ID: [
      T("MEMBER_ID", /会員(?:番号|ID|コード)\s*[:：=]\s*[\w\-]+/gu),
      T("MEMBER_ID", /\bMEMBER[_\-]\d{4,10}\b/gu),
    ],
    PATIENT_ID: [
      T("PATIENT_ID", /\b(?:PATIENT|MRN)[_\-]\d{4,10}\b/gu),
      T("PATIENT_ID", /(?:患者|診療)(?:番号|ID)\s*[:：=]\s*[\w\-]+/gu),
    ],
    SKU: [
      T("SKU", /\bSKU[_\-][\w\-]{3,20}\b/gu),
      T("SKU", /(?:製品|商品)(?:コード|番号)\s*[:：=]\s*[\w\-]+/gu),
    ],
    BLOOD_TYPE: [T("BLOOD_TYPE", /(?:AB|A|B|O)型/gu)],
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
      T("ASSET_NUMBER", /資産(?:番号|コード)\s*[:：=]\s*[\w\-]+/gu),
    ],
    LICENSE_NUMBER: [T("LICENSE_NUMBER", /\b(?:LIC|LICENSE)[_\-][\w\-]{4,20}\b/gu)],

    // ---- 辞書ベース fallback カテゴリ (dictionaries.js) -------------
    // Sudachi / Presidio が有効化されていない standalone 状態でも、
    // 日本の主要苗字・都道府県・政令指定都市・主要国名・Western 名
    // を確実にマスク対象にする。各カテゴリは dictionaries.js の
    // pre-compiled regex を参照。dicts が null の場合 (依存解決失敗)
    // は黙ってスキップする。
    ...(dicts ? {
      JP_SURNAME: [T("JP_SURNAME", dicts.JP_SURNAME_RE)],
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
