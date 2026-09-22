# Changelog

## 1.4.0 — 「意味として機密」な文の警告 + 検出エンジンの精度・網羅の修正 (2026-09-22)

Chrome Web Store のレビュー (★4, 2026-08-16) を起点に検出エンジンを棚卸しし、
出荷前に直すべき不具合とレビュー指摘への回答をまとめたリリース。

### 新機能: 機密文の警告 (engine/confidential.js)

> 未発表の値上げや買収交渉のような、文章の意味として機密になる情報は
> 検出されませんでした

PII ではないためマスクすべき span が存在せず、機密性は文の意味に宿る。
よって span 検出器ではなく、文をスコアして `confidential` フィールドで
**別枠**に返し、サイドバー上部に警告として描画する。`aggregated` には
混ぜない — 自動置換すると送りたい文そのものが壊れるため。

- トピックは 2 スロットの述語フレーム (slotA × slotB / 40 字窓) を語幹で保持。
  日本語は膠着語なので `上げ` が 上げる/上げた/引き上げ を覆い、
  `単価を上げる` のような言い換えが入る
- 秘匿シグナルは 3 レジスタ (改まった / 時制相 / 口語否定可能形) を ±120 字で探す。
  「…を決議します。まだ伏せてください。」のように文をまたぐのが普通の書き方
- 比喩 (`飲み込む` = 買収) は意図的に追わない。追うと precision が壊れる
- 未調整の hold-out で **precision 1.00 / recall 0.40**。UI にも限界を明記

### 修正: v1.3.0 のリリースブロッカー

- **ML 有効時に日本語のフルネームで出力が破損** していた。辞書 (score 1.0) と
  NER (softmax < 1.0) が同一 span を取り合い、overlap 解決が両方残したうえで
  `applyTagMask` が元オフセットで変更済み文字列を置換していた
- **クレジットカード番号が未検出** だった。categories / severity / classification /
  surrogates には登録済みなのに `patterns.js` にパターンが無く、
  別ラベルが部分マッチして桁が漏れていた。IIN + Luhn で修正
- **テストスイートが 5 ヶ月間死んでいた**。#38 で `maskAggregated` が async に
  なった際 validator に `await` が付かず、全ケースが `aggregated=[]` を見ていた

### 修正: 誤検出・取りこぼし

- `ADDRESS` が助詞・動詞まで飲み込む (`兵庫県明石市の事務所にいらっしゃいました`)
- `GENDER` が `その他` / `男性ホルモン` / `女性誌` に誤爆
- `BLOOD_TYPE` が `A型肝炎` に誤爆
- `KATAKANA_NAME` が外来語を人名判定 → 文脈ゲート 3 本に置換 (極性反転)
- `田中太郎さん` が姓のみマスクで `太郎` が露出 → 敬称後読みで 1 span に
- 全角数字が全ルールで不可視 → NFKC 正規化 + index map で一括対応
- 大文字の `PASSWORD=` / `API_KEY=` を取りこぼし
- 10 カテゴリで区切り記号が必須 (`顧客番号は12345です` が 0 件)
- `COMPANY` / `IP_ADDRESS` / `URL` / `PHONE_NUMBER` の精度穴
- PEM 秘密鍵が `API_KEY` 配列に同居し、カテゴリ無効化で道連れになる構造

### 追加: 検出ラベル 13 種

法人番号 (mod-9)、適格請求書 T番号、MAC / CIDR / 内部ホスト名、IBAN (mod-97)、
US SSN、UK NINO、暗号資産アドレス、メールヘッダ、Cookie、ローカルユーザーパス、
JSON の PII フィールド、略称企業参照 (A社 / 甲社)。

`BANK_ACCOUNT` / `API_KEY` (AWS secret 側) / `SECRET` (URL 埋め込み認証情報) も拡張。

### テスト

- vector 86 → 175 件、unit テスト 16 件を新設
- 未調整 hold-out を常設 (`confidential-holdout.test.mjs`)。
  緑にするために語彙を足さないこと — 測定器をチューニングすると測定器でなくなる


## 1.3.0 — In-browser ML model (NER) as a non-LLM detection option, with options-page UI (2026-04-29)

### Phase 0b — options-page UI for the ML toggle

The ML detector now has a proper place in `options.html` instead of
requiring users to flip `chrome.storage.local.mlEnabled` from a
DevTools console. Added a new "ブラウザ内 ML 検出" card that mirrors
the existing LocalLLM card's idiom:

- A switch (`#ml-enabled`) that, on click, fires the
  `chrome.permissions.request` flow against the three Hugging Face
  Hub origins. The click is a real user gesture so MV3's gesture
  requirement is satisfied without the DevTools workaround.
- Status pill (`#ml-status`) cycles through `未有効` → `ホスト権限を要求中…` →
  `モデルを取得中… (初回 10-90 秒)` → `✓ 準備完了` (or `失敗: <reason>`
  / `ホスト権限が拒否されました`).
- Returning-user path: on options-page reload, if `mlEnabled` is
  already true and the host permission still holds, the page silently
  prewarms the cached model and shows `✓ 準備完了` without the user
  doing anything. If the permission was revoked from
  `chrome://extensions`, the toggle is forced back to OFF and the
  pill explains the situation.
- Dedicated note that ML currently only fires in standalone mode
  (Phase 0a still routes through gateway when one is reachable; Phase
  0a-design follow-up will wire ML into the gateway and LLM
  augmentation paths too).

`options.js` gains:
- `setMlStatus(state, text)` — same shape as the existing LLM helper.
- `requestMlHostPermission()` — `chrome.permissions.contains` short
  circuit before `chrome.permissions.request`. Falls through to
  `true` if the API itself is unavailable.
- `prewarmMl()` — sends `ML_PREWARM` and resolves the status pill
  based on the response.
- `loadMlSettings()` — boot-time hydration mirroring `loadLlmSettings`.

### Test coverage

- New `tests/integration/test-ml-options-ui.mjs` end-to-end test:
  loads the unpacked extension in headed Chromium, opens the options
  page, clicks the toggle as a real user gesture, asserts the status
  pill flips to `✓ 準備完了` and that `chrome.storage.local.mlEnabled`
  flips to `true`. Verifies the OFF path resets state.
- The existing `test-ml-pipeline.mjs` continues to PASS unchanged.

### No behavioural change to the engine / pipeline

The actual ML inference path (offscreen → transformers.js →
distilbert-multilingual-NER) is unchanged from the Phase 0a fixes
shipped in #39 / #40. This PR is purely UI plumbing on top of the
existing message protocol.

## 1.3.0 — In-browser ML model (NER) as a non-LLM detection option (2026-04-28)

Adds **transformers.js + Xenova/distilbert-base-multilingual-cased-ner-hrl**
running entirely inside the extension as a third detection backend
alongside regex and the optional LocalLLM. Disabled by default; users
opt in via a settings flag and the model downloads on first use.

### Architecture

- The full transformers.js bundle (`transformers.min.js`, 868 KB) and
  ONNX Runtime WASM (`ort-wasm-simd-threaded.jsep.wasm`, 21 MB) ship in
  the extension package under `vendor/transformers/`. Total Store zip
  grew from 176 KB → 5.3 MB compressed (22 MB unpacked).
- **Inference runs in the service worker** (background.js, now an ES
  module). Content scripts post `{type: "ML_DETECT", text}` messages
  and receive aggregated entity spans back. SW caches the pipeline
  in memory across calls; survives re-init by re-reading the model
  from on-disk transformers.js cache.
- The model itself (~135 MB int8 q8) is **not bundled** — transformers.js
  fetches it from HF Hub on first use and caches in IndexedDB. This
  needs runtime host permission for `huggingface.co` /
  `cdn-lfs.huggingface.co` / `cdn-lfs-us-1.hf.co`, which is requested
  via `chrome.permissions.request()` when the user enables ML mode.

### New / changed files

- `vendor/transformers/` — vendored transformers.js v3.5+ (Apache-2.0).
- `engine/onnx-detector.js` — content-script-side wrapper that sends
  ML_DETECT messages and maps NER entity_groups (PER/LOC/ORG) back to
  PROPER_NOUN_PERSON / PROPER_NOUN_LOCATION / PROPER_NOUN_ORG so the
  existing severity / category / classification maps cover them
  without modification.
- `background.js` — gains `ML_DETECT` and `ML_PREWARM` handlers,
  switches to ES module via manifest "type": "module", uses static
  `import` for transformers.js.
- `engine/engine.js` — refactored into `collectRawDetections` +
  `finishPipeline`; added `runPipelineAsync` that awaits the ML
  detector when `opts.mlEnabled`. `maskAggregated` and `maskSanitize`
  are now async.
- `injected.js` — `engineOpts()` reads `mlEnabled` from settings and
  passes through; both engine entry points are now `await`-ed.
- `content.js` — broadcasts `mlEnabled` in the settings payload,
  re-broadcasts on `chrome.storage.onChanged`.
- `manifest.json` / `manifest.store.json` — `optional_host_permissions`
  for HF Hub origins, `content_security_policy.extension_pages` with
  `wasm-unsafe-eval`, vendor files in `web_accessible_resources`,
  background SW marked `"type": "module"`. Store version bumped
  v1.2.0 → v1.3.0.

### How to enable (no UI yet — Phase 0a MVP)

```js
// In an extension page (popup / options / chrome://extensions devtools):
await chrome.permissions.request({
  origins: [
    "https://huggingface.co/*",
    "https://cdn-lfs.huggingface.co/*",
    "https://cdn-lfs-us-1.hf.co/*",
  ],
});
await chrome.storage.local.set({ mlEnabled: true });
chrome.runtime.sendMessage({ type: "ML_PREWARM" }, console.log);
```

The next time a chat composer fires, the engine will append NER
detections to the regex / dictionary / force-mask results before
the overlap resolver merges them.

### Phase 0b (next)

- Options page UI for the ML toggle (permission request flow,
  download progress, model-loaded status).
- Model size disclosure in PRIVACY.md and Store listing description.

## 1.2.0 — LocalLLM on Chrome Web Store via optional_host_permissions (2026-04-24)

Store manifest bumped v1.1.0 → v1.2.0. Reunites the LocalLLM
integration with the Web Store build — previously stripped in v1.1.0
because `http://*/*` as an install-time `host_permissions` entry was
incompatible with Store review expectations for a chat-assistant
extension.

### Headline

- **LocalLLM (Ollama / LM Studio / llama.cpp) now ships to the Chrome
  Web Store build**, disabled by default, enabled at runtime via
  `chrome.permissions.request`. No host access is granted at install
  time; the user authorises the exact LLM URL they configured when
  they flip the master switch or press 接続確認.

### Background

v1.1.0 stripped LLM support out of the Store variant entirely because
declaring `http://*/*` in `host_permissions` (install-time) risked
Store rejection — that pattern effectively asks for access to every
HTTP site on install, which is a red flag for reviewers even though
the actual SW is host-locked to the user-chosen URL.

v1.2.0 moves `http://*/*` to `optional_host_permissions` in
`manifest.store.json`. Install now requires no host access at all for
LLM. When the user explicitly configures an LLM endpoint and toggles
the feature on, Chrome shows its native permission prompt for **only
that URL**, and the user consents per-install. Denial gracefully
disables the feature with `localLlmEnabled` flipped back to `false`.

### User-visible changes

- **ローカル LLM 連携 card is back in the Store build's options
  page** — same UI as the dev build. Previously hidden behind
  `STORE-STRIP` markers.
- **Permission prompt on enable / 接続確認** — Chrome shows its
  native "この拡張機能に <URL> へのアクセスを許可しますか？" dialog
  exactly once per URL per profile. Granted hosts are remembered by
  Chrome until the user revokes them from `chrome://extensions`.
- **Denial → graceful disable** — if the user dismisses / denies the
  prompt, the options page reverts `localLlmEnabled` to `false`,
  shows an inline explanation, and leaves the URL field intact so
  the user can retry.
- **Host-lock + sender-ID protections unchanged** — the service
  worker still rejects any fetch whose host does not match
  `chrome.storage.local.localLlmUrl`, and still drops messages from
  foreign extension IDs.

### Technical notes

- `engine/surrogates.js` and `engine/llm-prompts.js` now ship in the
  Store bundle (previously deleted by `scripts/build-store.sh`).
- `manifest.store.json` — added
  `optional_host_permissions: ["http://*/*"]`. `host_permissions`
  still lists only the 5 chat-provider hosts.
- `STORE-STRIP:START … STORE-STRIP:END` markers removed around LLM
  blocks in `content.js` (2 ENGINE_FILES entries) and `options.html`
  (the entire ローカル LLM 連携 card).
- `scripts/build-store.sh` updated: no longer deletes
  `engine/surrogates.js` / `engine/llm-prompts.js`; `STORE-STRIP`
  scrub step narrowed to the remaining dev-only blocks (none after
  this PR, but the mechanism stays in place for future use).
- `options.js` gained `requestLlmHostPermission(url)` which wraps
  `chrome.permissions.request({origins: [toOriginPattern(url)]})`
  and handles denial / revocation.

### Security posture (unchanged from v0.5.0)

- **No LLM traffic to the extension developer** — the SW refuses any
  host other than the user-configured URL.
- **No third-party cloud** — Anthropic, OpenAI, and friends never
  receive LLM queries.
- **Fail-closed on replace mode** / **fail-open on detect mode** —
  unchanged.

## 1.1.0 — Chrome Web Store public release (2026-04-22)

Store manifest bumped v1.0.1 (queued hotfix) → v1.1.0 (feature release).
Bundles every improvement since v1.0.0 into one Store submission:

- Claude.ai relative-URL send intercept fix (original v1.0.1 hotfix)
- PREFECTURE_CITY category (都道府県+市区町村単体)
- Static dictionary fallback layer: JP surnames (top 50), 47
  prefectures, 20 designated cities, 33 world countries (JP + EN),
  26 Western first names
- 30+ vendor-specific API key detectors, with Perplexity + OpenRouter
  added in this batch
- Drag-and-drop force-mask with 9-category picker popover
- Real-time re-detection on force-list change (overlap resolver picks
  the broader span; count updates immediately)
- Categories collapsed by default + all-expand toggle
- Existing-detection drop jumps straight to the row (scroll + flash)
- Preview pane auto-collapses while the drop popover is open
- Console log prefix renamed to `[pii-guard]` for branding consistency
- Verbose diagnostic logs from the forcelist-chain debug campaign
  removed now that the flow is verified
- `dist/browser-extension-store.zip` 144KB / 33 files — no `http://*/*`
  host permission, no LLM engine files, LLM options card stripped

See the 0.x entries below for per-feature design notes.

## 0.8.0 — Sidebar UX batch: live re-detect + collapse + auto-expand (2026-04-22)

Follow-up polish on the drag-to-sidebar force-mask flow. Groups PRs
#18 through #24 which iterated on real user feedback.

### Layout

- **Categories default to collapsed** (#18). The sidebar used to show
  every row expanded; with larger inputs this buried the rows users
  wanted to reach. Header only by default, click / bulk toggle to
  expand.
- **▾ すべて展開 / ▸ すべて折りたたむ toggle** above the drop zone (#18).
- **Preview pane auto-collapses while drop popover is open** (#19).
  Popover would otherwise share vertical space with a fixed preview
  at the bottom and squeeze the category list. Preview restores on
  popover close; click the "プレビュー" heading to peek while open.

### Live re-detect

- **Force-list change triggers in-place re-detection** (#22). Adding
  or removing a force-mask entry no longer requires resending the
  message — the sidebar recomputes with the existing baseline and
  renders immediately.
- **Longest-span wins** on overlap (#22). If "田中" is already
  detected and user adds "田中 太郎" via drag-drop, the overlapping
  "田中" is absorbed into the broader mask and the JP_SURNAME count
  drops accordingly. Non-overlapping "田中" occurrences stay.
- **Auto-expand + yellow flash on newly-added row** (#24). New entries
  land in their chosen category even when that category is collapsed
  — `scrollToAndFlashRow` expands it, scrolls, and runs the 2s flash
  so users can't miss the change.

### Drag-drop interaction fixes

- **Existing detections skip the popover** (#20). Dragging a word that
  already has a detection scrolls + flashes the existing row directly
  instead of showing a list-of-matches popover. Less visual clutter.
- **scrollToAndFlashRow uses the right DOM reference** (#21). The
  `rowControls` Map value shape had drifted from its inline comment
  (`{checkbox, row}`) to the real one (`{checkbox, control: {element,
  ...}, row, setState}`). The DOM element lives at
  `ctl.control.element`. Fixed with defensive guards.

### Branding

- Console log prefix renamed from `[mask-mcp]` → `[pii-guard]` across
  sidebar.js, content.js, injected.js, engine/bundle.js,
  browser-extension/README.md. Internal protocol identifiers
  (`mask-mcp-inpage` / `mask-mcp-content` postMessage tags,
  `mask-mcp:settings-updated` / `mask-mcp:engine-ready` CustomEvent
  names, `data-mask-mcp-*` DOM attributes, `mask-mcp-flash` CSS
  keyframe) are unchanged to preserve storage and compat.
- Verbose diagnostic logs added for the forcelist hop chain (added
  #22 / #24) removed now that the flow is verified. Operational
  warnings and gateway/LLM status messages kept.

## 0.7.0 — Drag-to-sidebar force-mask (2026-04-22)

Adds a drag-and-drop flow for manually flagging text that the detection
pipeline missed or needs to force-mask regardless of context.

### UX

- The sidebar now shows a dashed "drop zone" bar below the severity filter
  tabs: "テキストをここにドラッグしてマスク対象に追加".
- Any text selection from the host page (chat composer, previous AI
  response, anywhere with contenteditable/textarea drag support) can be
  dropped onto the sidebar.
- On drop, a small inline popover shows 9 category chips (PERSON /
  LOCATION / ORGANIZATION / CONTACT / FINANCIAL / CREDENTIAL / IDENTITY /
  INTERNAL_ID / OTHER) colour-coded by each category's default severity.
  Clicking a chip commits the entry.

### Persistence

- New storage key: `chrome.storage.local.maskForceList`.
- Format: `[{ value: string, category: string }]`. Matches are
  case-sensitive and exact (no regex expansion, no fuzzy/substring —
  strict to avoid unexpected mass-masking).
- Global scope (same list applies on every supported service).
- Cross-tab live sync via `chrome.storage.onChanged` → `broadcastSettings`
  → `mask-mcp:settings-updated` CustomEvent.

### Engine

- New module `engine/user-force-mask.js`. `detectUserForceMask(text,
  entries)` emits one detection per occurrence, with entity_type =
  `USER_DEFINED_<CATEGORY>`.
- `engine.runPipeline` merges these with regex/dictionary detections BEFORE
  the common-noun blocklist, so blocklist remains the final safety net.
- `USER_DEFINED_*` labels are registered in category / severity /
  classification maps so they render in their chosen category's section
  with the proper severity colour.

### Row-level management

- Rows in the sidebar whose label starts with `USER_DEFINED_` now show a
  `✖ 削除` button instead of `✖ 除外`. Clicking sends `remove-forcelist`
  which removes the entry from `maskForceList`. This closes the
  add-remove loop without needing the options page.

### Files

- new: `browser-extension/engine/user-force-mask.js`
- modified: `browser-extension/{content,injected,sidebar}.js`
- modified: `browser-extension/engine/{engine,categories,severity,classification}.js`
- modified: `browser-extension/manifest{,.store}.json` (new resource entry)

## 0.6.0 — Dictionary-based fallback detection layer (2026-04-22)

Adds a curated static dictionary for PII detection that fires even when
Sudachi / Presidio are disabled (standalone mode). Mirrors the same data
between `browser-extension/engine/dictionaries.js` and
`src/app/services/analyzers/dictionaries.py`.

### New categories

- `JP_SURNAME` — top 50 Japanese surnames (multi-char only, unambiguous
  with common nouns; single-char surnames like 林/森/川 intentionally
  excluded). severity=high, category=PERSON.
- `JP_PREFECTURE_DICT` — all 47 prefectures (単体検出用; complements
  `PREFECTURE_CITY` which requires prefecture+city). severity=medium.
- `JP_DESIGNATED_CITY` — 20 政令指定都市 complete. severity=medium.
- `WORLD_COUNTRY` — G20 + major Asian country names, JP + EN notations.
  severity=medium.
- `WESTERN_FIRST_NAME` — 26 business-common Western first names,
  curated to avoid ambiguity with common nouns. severity=high.

### Additional vendor API keys

- Perplexity: `pplx-[A-Za-z0-9]{32,}`
- OpenRouter: `sk-or-v1-[A-Za-z0-9]{40,}`

### Implementation notes

- ASCII-only boundary assertions `(?<![A-Za-z])...(?![A-Za-z])` used for
  English patterns (instead of `\b`) so Python's Unicode `\w` doesn't
  falsely suppress matches next to Japanese characters.
- `browser-extension/engine/dictionaries.js` loads before `patterns.js`
  (ENGINE_FILES ordering in content.js); patterns.js reads the
  pre-compiled regex via the shared `window.__localMaskMCP.engine`
  namespace, or falls back to `require("./dictionaries.js")` in Node.
- Store build pipeline (`scripts/build-store.sh`) correctly includes
  `dictionaries.js` in the distributable. Size delta: +~4 KB uncompressed.

## 0.5.1 — Claude.ai interception fix + adapter coverage (2026-04-18)

Follow-up patch to v0.5.0 addressing a reproducible "sidebar never
opens on claude.ai" report from field testing.

### Fixes

- **Relative URL resolution** — the fetch / XHR hooks now resolve
  `fetch("/api/…")` style relative URLs to absolute via
  `new URL(raw, location.href)` before running adapter matchers.
  Claude.ai's SPA emits relative paths exclusively; the previous
  code fed those straight into the `^https?://claude\.(ai|com)/`
  anchor, which could never match, so no POST ever reached
  `processBody`. Confirmed against the user-reported URL
  `/api/organizations/<uuid>/chat_conversations/<uuid>/completion`.

### Coverage

- Claude adapter match / body extractors broadened to handle
  current API shapes:
    * Allow-list: `send_message`, `messages`, `send` (in addition
      to legacy `completion`, `append_message`, `retry_completion`,
      `chat_conversations`)
    * Deny-list: added `render_status`, `count`, `stream_events`,
      `usage`, `analytics`, `telemetry`, `ratings` on top of the
      existing `title`, `feedback`, `star`, `archive`, `share`,
      `export`, `leave`, `rename`, `latest`, `preview`
    * `extractInputs` / `replaceInputs` now also read top-level
      `text` / `query` / `message` string fields and a top-level
      `content: [{type:"text", text:…}]` array — used by projects
      conversations and the newer send_message variants

### Diagnostics

- Provider-host POST / XHR logging (deduped per URL) so any future
  "sidebar doesn't open" report can be triaged with a single
  console snippet:

      [mask-mcp] provider POST (adapter matched):      <url>
      [mask-mcp] provider POST (NO adapter match):     <url>
      [mask-mcp] provider XHR (adapter matched):       <url>
      [mask-mcp] provider XHR (NO adapter match):      <url>
      [mask-mcp] <adapter>: adapter matched but body had no user text —
          keys: <top-level-keys>                       <url>

  These are intentionally under-verbose (logOnce per unique URL).

## 0.5.0 — Local-LLM proxy + context-aware detection (2026-04-18)

End-to-end local-LLM augmentation. The extension can now route
outbound PII text through a user-configured Ollama / LM Studio /
llama.cpp server for contextual detection or tag-based
replacement. All traffic stays on the user's machine or LAN —
no extension author involvement.

### Highlights

- **Three operation modes** selectable in `options.html`:
    * `Regex のみ` — original v0.4 behaviour
    * `検出補助 (Regex + AI)` — LLM augments regex/Sudachi; entities
      with the same surface are replaced by LLM-labelled versions
    * `AI 置換 (実験的)` — LLM rewrites the full message into
      `<tag_N>` placeholders; outbound payload never contains the
      original text
- **Mode pill** in the sidebar header so the active dispatch is
  always visible at a glance.
- **Unique numbered tags** (`applyUniqueTagsToReplace` in
  injected.js): same surface → same tag, distinct values →
  distinct numbers. 1:1 mapping preserved for a future
  "restore tags in AI response" feature.
- **Model management panel**: 7 curated models with on-disk +
  VRAM chips, badges (軽量 / 推奨 / 高精度 / 最高精度 / 代替),
  one-click **ダウンロード** (streaming NDJSON with progress bar)
  and **削除** (`DELETE /api/delete`).

### Architecture

- Service worker proxy for every LLM call — bypasses Chrome's
  Private Network Access block and enforces sender-id + host-lock
  so the SW can't be repurposed as a generic proxy.
- `think: false` + `format: "json"` + `num_predict: 2048` in every
  Ollama request so Qwen3 thinking variants emit visible JSON.
- Two-tier retry budget: 6× warming-up on `500/503 "loading model"`,
  2× on AbortError.
- Inner bridge timeout = `cfg.timeoutMs × 3 + 30s` so the
  postMessage bridge outlives the SW retry loop.
- `_llmStatus` field (`failed` / `ok_empty` / `ok_entities`) lets
  the sidebar distinguish "LLM returned nothing" from "LLM never
  responded".

### UX

- In-sidebar centered overlay (not a top-right pill) for both
  analyze and replace paths, with double-ring pulsing spinner.
- Row stagger-in on reveal (80 ms × index).
- ✨ sparkle icon + purple `AI 検出` badge on LLM-detected rows.
- Final row interaction rules: long-press **only** on critical
  rows currently masked; everything else (incl. locked
  force-masked) is one-tap.
- Chat pane shrinks via `transform: translateZ(0)` +
  `contain: layout` on the wrapper so `position: fixed` composers
  respect the sidebar's reservation — always side-by-side,
  never covered.
- 4-column grid on each row — value / arrow / placeholder line
  up vertically across every entry. `text-overflow: ellipsis`
  on long values with `title` tooltip.
- `出現回数 N回` instead of `N件` for per-row counts.
- 🔒 lock icon only on category headers (not every row).
- Sidebar host gets `position: relative` + `z-index: 2147483647`
  + `isolation: isolate` so no chat CSS can overlay the panel.

### Detection

- Vendor-specific API-key regex coverage: OpenAI (`sk-proj-` /
  `sk-ant-` / etc.), Anthropic, Notion (`ntn_` + legacy
  `secret_`), GitHub (`ghp_` / `gho_` / `github_pat_`), Slack
  (`xox[baprs]-`), Google (`AIza…` / `ya29.`), AWS
  (`AKIA/ASIA/…`), Stripe, Twilio, SendGrid, Groq, Replicate,
  Tavily, GitLab (`glpat-`), Mailgun, npm, Fireworks, Airtable,
  Linear, Figma, Discord, Cloudflare, JWT, Bearer headers, PEM
  private key blocks.
- COMPANY char class tightened to katakana + CJK + latin so
  hiragana particles break the match ("株式会社アクメの田中部長"
  no longer captures the whole phrase).
- LLM denylist (job titles / credential-type names / polite
  phrases / common tech) runs as a post-filter so Qwen3
  over-detection is neutralised client-side.

### Security

- Fail-closed on replace mode (any LLM failure aborts the entire
  outbound request).
- Fail-open on detect mode (LLM timeout → regex-only sidebar
  with an error toast).
- Main branch protection enabled (PR required, linear history,
  no force-push / deletion, conversation resolution).

### Known limits

- 9B thinking models take 20–60 s on cold start; the retry loop
  covers this transparently.
- Gemini Bard-frontend `f.req` framing remains detect-only;
  rewriting it back is out of scope until the framing is round-
  trip safe.

## 0.4.0 — v1.0.0 Chrome Web Store build (2026-04-15)

Stabilization pass between 0.3.0 and the 0.5.0 local-LLM work.
Shipped as the v1.0.0 Web Store submission under
`manifest.name = "PII Guard"`.

- Sidebar modernised — glass header, category cards, segment-
  control severity tabs, gradient primary button, micro-
  animations.
- Theme auto-sync to host background (luminance < 0.5 activates
  dark palette).
- Hold-duration slider 0 s – 1.5 s for force-masked categories.
- Before/After arrow visualisation with reverse-arrow + green
  right-border marker for unmasked rows.
- Per-row 除外 button writes directly to
  `chrome.storage.local.maskAllowlist`; other open tabs
  auto-unmask matching rows on the fly via CustomEvent
  `mask-mcp:settings-updated`.
- Options page — allowlist CRUD + JSON import/export.
- Socket.IO / manus.im WebSocket hook for chats that bypass
  fetch/XHR.
- Chrome Web Store submission package: icons, screenshots,
  `PRIVACY.md`, `STORE.md`, `STORE_DESCRIPTION.md`.
- Fail-closed on masking-pipeline error (rejected fetch instead
  of silent pass-through).

## 0.3.0 — Severity colors + long-press critical guard (2026-04-15)

Wave C of Milestone 7/8 — frontend + backend half of the new
severity tiering. Gateway-side schema field lands alongside.

- `sidebar.js` — every row carries a left coloured border
  matching `entity.severity` (red `#dc2626` / orange `#f97316`
  / amber `#eab308` / gray `#6b7280`) plus a
  `[critical|high|medium|low]` pill after the entity label.
  Category headers render at the worst severity of their
  children. Critical rows replace the native checkbox with a
  custom `<svg>`-based long-press control: press and hold 800 ms
  (50 ms tick animation on `stroke-dashoffset`) to toggle. Early
  release / pointer leave / cancel resets the ring without
  toggling. Works on touch via `pointer*` events. When a
  critical row is ALSO in `force_masked_categories` the control
  is replaced with a disabled lock glyph. Bulk "すべて解除"
  now confirms with a native `window.confirm` and only clears
  non-critical / non-locked rows on accept.
- `review-modal.js` — same severity palette + long-press guard
  for parity. Rows sort severity-first (critical → low) so the
  riskiest detections float to the top while original detection
  indices are preserved for `collectSelected`.
- `manifest.json` — version bumped to `0.3.0`.

## 0.2.0 — UI masking control layer (2026-04-15)

Wave B of Milestone 8 — frontend half of the new aggregated
detection layer. Wave A (backend aggregation, force-mask trigger,
15 new business-document presets) shipped on `main` immediately
before this.

- `sidebar.js` (new) — Shadow-DOM-scoped right-side panel at
  `z-index: 2147483647` on `document.body`. Hand-rolled CSS
  variables (indigo `#4f46e5`, danger `#dc2626`, gray `#f9fafb`,
  rounded-xl `12px`, `0 10px 25px rgba(0,0,0,0.12)` shadow). Slide-in
  animation via `transform: translateX(...)`. Click-outside on the
  semi-transparent overlay does NOT auto-cancel — explicit
  Confirm/Cancel only. Renders one row per unique
  `(category, value)` pair with a `(N件)` count badge instead of
  listing every occurrence. Tri-state category checkboxes,
  per-row checkboxes, bulk すべて選択 / すべて解除, plus a live
  preview pane that re-applies tag substitutions client-side on
  every checkbox change. Categories listed in
  `force_masked_categories` show 🔒 and have their checkboxes
  `disabled` so neither row nor parent toggle nor bulk actions
  can ever uncheck them. Focus trap wraps Tab through the panel;
  Enter confirms; Esc cancels. No `innerHTML` on untrusted
  strings.
- `injected.js` — dispatch layer reads
  `window.__localMaskMCP.settings.uiMode` (default `"sidebar"`)
  on every intercept and routes to the matching helper:
  - `"sidebar"` → `POST /v1/extension/sanitize/aggregated` then
    `sidebar.show(aggResp, originalText)`. Result is a flat
    `[start, end, label]` triple list fed into the new
    `applyTriples()` helper (back-to-front substitution).
  - `"modal"` → unchanged Phase 2 path (`/sanitize` then
    `reviewModal.show(...)`).
  - Either UI helper missing or `interactive: false` → auto-mask
    via the gateway-sanitised text.
- `content.js` — inject `sidebar.js` between `review-modal.js`
  and `injected.js` so both helpers exist before the first fetch.
  Adds `GATEWAY_AGGREGATED_URL` + a new
  `handleSanitizeAggregated` bridge sharing a `callGateway()`
  helper with the legacy handler. Settings broadcast now
  includes `uiMode` and re-fires when either
  `interactive` or `uiMode` changes in `chrome.storage`.
- `popup.html` / `popup.css` / `popup.js` — new `UI モード` radio
  group (`サイドバー` / `モーダル`). Defaults to サイドバー and
  normalises any non-`modal` value back to サイドバー so a corrupt
  storage entry can never leave the radio blank.
- `background.js` — `onInstalled` seeds three keys (`enabled`,
  `interactive`, `uiMode`) instead of two; `uiMode` defaults
  `"sidebar"`.
- `manifest.json` — adds `sidebar.js` to
  `web_accessible_resources`. Version bumped to `0.2.0`.

## 0.1.1 — Interactive review UI (2026-04-15)

- `review-modal.js` (new) — Shadow-DOM-scoped overlay on
  `document.body` at `z-index: 2147483647`. Every gateway detection
  becomes a checkbox row with a colour-coded entity badge and a
  contextual snippet. Enter confirms, Esc cancels, Tab cycles focus.
  No `innerHTML` on untrusted strings: every node is built via
  `createElement` / `textContent`.
- `injected.js` — reads the `interactive` setting from
  `chrome.storage.local` (via postMessage from `content.js`) and,
  when on, awaits `reviewModal.show(detections, text)`. On confirm,
  rebuilds the masked payload client-side from the ticked indices
  using the `<ENTITY_TYPE>` tag strategy. On cancel, rejects the
  fetch / aborts the XHR so no payload leaves the browser.
- `content.js` — injects `review-modal.js` before `injected.js` and
  re-broadcasts the `interactive` setting on every
  `chrome.storage.onChanged`.
- `popup.html` / `popup.js` / `popup.css` — new "送信前に確認する
  (インタラクティブ・モード)" toggle, default ON. Popup widened
  from 260px to 300px for the Japanese label.
- `background.js` — seeds both `enabled` and `interactive` to
  `true` on first install.
- `manifest.json` — adds `review-modal.js` to
  `web_accessible_resources`.

## 0.1.0 — Phase 1 (2026-04-15)

Initial scaffolding.

- Chrome MV3 manifest targeting Claude.ai, ChatGPT, Gemini, Manus,
  and the local gateway at `127.0.0.1:8081`.
- Split content script + injected script pattern: `content.js` runs
  in the isolated world for `chrome.*` access; `injected.js` runs in
  the page's MAIN world and monkey-patches `window.fetch` and
  `XMLHttpRequest.prototype.send`.
- Per-service adapter registry with `match` / `extractInputs` /
  `replaceInputs`. Four adapters shipped: Claude.ai is the primary
  target; ChatGPT / Gemini / Manus are partial and flagged in the
  README.
- Service worker (`background.js`) keeps per-tab detection counts
  and renders them on the toolbar badge.
- Minimal popup — enabled toggle, gateway health probe, per-tab
  count, link to the gateway Swagger UI.
- Icons generated from Pillow inside the existing
  `local-mask-mcp:latest` runtime image; see
  `scripts/generate-icons.py`.

Depends on gateway-side `POST /v1/extension/sanitize` +
`CORSMiddleware` (both shipped in the same feature branch).
