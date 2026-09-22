# プライバシーポリシー — PII Guard

最終更新: 2026-09-22 (v1.4.0 機密文の警告機能を追加)

## 概要

PII Guard (本拡張機能) は、ブラウザで AI チャットサービスを利用する際に、送信前のテキストから個人情報 (PII) を検出してマスキングする目的で動作します。**既定では、すべての処理はあなたのブラウザ内で完結し、拡張機能の開発者および第三者への通信は一切行いません。**

v1.2.0 の Chrome Web Store ビルドは **optional LocalLLM 連携を同梱** していますが、**初期状態では完全に無効**です。ユーザーがオプション画面で明示的に有効化し、かつ Chrome のランタイム権限プロンプト (`chrome.permissions.request`) で対象ホストを自ら許可した場合に限り、PII 検出クエリがユーザー指定の**ローカル/LAN 上の LLM サーバー** (Ollama / LM Studio / llama.cpp 等) に送信されます。送信先はあなたが明示的に入力した URL に限定され、Service Worker の host-lock 検証により、それ以外のホストへの送信は物理的に不可能です。ユーザーがランタイム権限を拒否した場合、LLM 機能は自動的に無効化されます。

v1.3.0 では **ブラウザ内 ML 検出** (transformers.js + DistilBERT-multilingual NER) を新たに同梱しました。これも **初期状態では完全に無効** で、ユーザーがオプション画面でトグルを ON にし、Chrome のランタイム権限プロンプトで Hugging Face Hub のホストを許可した場合のみ、有効化時の **1 回限り** モデルファイル (約 135MB) が `huggingface.co` および `cdn-lfs.huggingface.co` / `cdn-lfs-us-1.hf.co` から取得されます。モデル取得時に **ユーザーの入力テキストや個人情報が一緒に送信されることはありません** — Hugging Face Hub にはモデル ID と File 名のみが伝わります。取得後はブラウザの IndexedDB にキャッシュされ、それ以降の **PII 検出推論はオフラインで端末内のみで実行** されます。

**PII や問い合わせテキストは、本拡張機能の開発者、Anthropic、OpenAI、Hugging Face、その他いかなる第三者クラウドサービスにも送信されません。** LLM 連携の送信先はあなたが事前に許可したローカル/LAN 上のエンドポイントに限定されます。ML 検出はモデル取得後の推論で外部通信を一切行いません。

v1.4.0 では **「意味として機密」な文の警告** を追加しました。未発表の値上げや進行中の買収交渉のように、書式ではなく文の意味が機密になる記述を検出し、送信前に警告を表示します。**この判定は拡張機能に同梱された語彙とルールだけで端末内で完結し、外部への通信は一切発生しません。** モデルのダウンロードも不要です。検出された文は**マスクされず**、警告として提示されるだけで、送信するかどうかはユーザーが判断します。

## 収集する情報

### ローカルストレージに保存する情報

`chrome.storage.local` API 経由で以下を保存します:

| キー | 内容 | 目的 |
|---|---|---|
| `enabled` | マスキング機能の ON/OFF | ユーザー設定の永続化 |
| `interactive` | 送信前確認モードの ON/OFF | 同上 |
| `uiMode` | サイドバー / モーダルの選択 | 同上 |
| `maskAllowlist` | マスキング除外する文字列の配列 | 同上 |
| `mask_mcp_pref_hybrid` | エンジン動作モード | 同上 |
| `localLlmEnabled` (v0.5.0+) | ローカル LLM 連携の ON/OFF | 既定 `false` |
| `localLlmUrl` (v0.5.0+) | ユーザー指定の LLM サーバー URL | 空または未設定なら LLM 連携は動作しない |
| `localLlmModel` (v0.5.0+) | 使用モデル名 | 例: `qwen3:4b` |
| `localLlmMode` (v0.5.0+) | 動作モード (`detect` / `replace`) | 既定 `detect` |
| `localLlmTimeoutMs` (v0.5.0+) | LLM タイムアウト (ms) | 既定 120000 |
| `localLlmKind` (v0.5.0+) | LLM サーバーの API 形式 (`ollama` / `openai-compat`) | 接続確認で自動判定 |
| `localLlmHostGranted` (v1.2.0+) | ランタイム権限で許可されたホスト | ユーザーが承認した URL のみ LLM 連携可能 |
| `mlEnabled` (v1.3.0+) | ブラウザ内 ML 検出 (NER) の ON/OFF | 既定 `false`。ON 時のみ Hugging Face Hub からモデル取得 + IndexedDB に常駐 |

これらはすべてあなたの端末内の Chrome ストレージにのみ保存され、本拡張機能の開発者を含む第三者がアクセスすることはありません。

### 一時的にメモリで扱う情報

- AI チャット入力時の本文テキスト (PII 検出のため)
- 検出された PII の位置・種類・重要度
- タブごとのマスク件数 (バッジ表示用)

これらの情報は **ブラウザのメモリ内にのみ存在し**、ファイルや外部サービスには一切送信・保存しません。

## 外部送信

**既定では送信しません。** 本拡張機能は初期状態で完全オフラインで動作し、PII 検出ロジックはすべて拡張機能内にバンドルされた JavaScript コードで実行されます。リモート CDN からのコード読み込みも行いません。

対象 AI サービス (claude.ai / chatgpt.com / openai.com / gemini.google.com / manus.im) **本来の通信** はそのまま通過させますが、その通信はあなたとそのサービス間の直接接続であり、本拡張機能の開発者には届きません。

## ローカル LLM 連携 (v0.5.0+ / v1.2.0 Store build)

v0.5.0 以降 (および v1.2.0 Chrome Web Store ビルド) では、オプション画面でユーザーが明示的に有効化した場合に限り、次の 1 つだけ例外的な外部通信が発生します:

- **送信先**: オプション画面 `エンドポイント URL` にユーザーが入力した URL (例: `http://localhost:11434`)
- **送信内容**: 検出または置換対象のテキスト本文、および検出指示用のシステムプロンプト
- **送信プロトコル**: HTTP POST (`/api/chat` または `/v1/chat/completions`)
- **送信タイミング**: AI チャット画面で送信するメッセージ 1 件ごとに 1 回
- **送信しない情報**: 閲覧しているページの URL、Cookie、タブ情報、他のタブの内容、アカウント情報
- **許可するホスト**: `chrome.storage.local.localLlmUrl` に保存された URL のホスト/プロトコルと完全一致するもののみ。Service Worker が受信する `LLM_FETCH` メッセージを host-lock で検証し、他ホストへの転用は物理的に不可能です (違反時は `forbidden: host mismatch` でリジェクト)。
- **拡張機能 ID 検証**: Service Worker は `sender.id !== chrome.runtime.id` のメッセージをすべて拒否するため、他の拡張機能から本拡張のプロキシを悪用することはできません。
- **デフォルトでは無効**: `localLlmEnabled: false` が初期値。ユーザーが自発的にトグルを ON にするまで一切の外部通信は発生しません。
- **ランタイム権限 (v1.2.0 Store build)**: Chrome Web Store 版では `optional_host_permissions` を採用しており、拡張機能のインストール時には一切のホスト権限を要求しません。ユーザーが LLM URL を設定し「接続確認」または有効化トグルを操作したタイミングで、Chrome が権限プロンプト (`chrome.permissions.request`) を表示し、ユーザーが対象ホストのみを明示的に承認した場合に初めて LLM 通信が可能になります。権限を拒否した場合、LLM 機能は自動的に無効化されます (`localLlmEnabled` は `false` に戻ります)。
- **拡張機能開発者、Anthropic、OpenAI 等第三者クラウドへは送信しません**: 送信先はあなたが指定した自宅/社内 PC 上の Ollama 等であり、拡張機能の開発者が運営するサーバー、Anthropic や OpenAI のような生成 AI プロバイダ、その他いかなる第三者クラウドサービスにも送信されません。

このローカル LLM 連携を無効化したい場合は、オプション画面の「LLM 補助検出を有効化」スイッチを OFF にしてください。`localLlmUrl` を空に戻しても連携は無効化されます。

## ブラウザ内 ML 検出 (v1.3.0+)

v1.3.0 以降、オプション画面の「ブラウザ内 ML 検出を有効化」スイッチを ON にすると、以下の **1 回限りのモデル取得** および **以降のオフライン推論** が動作します:

- **取得先**: `https://huggingface.co/Xenova/distilbert-base-multilingual-cased-ner-hrl` および `https://cdn-lfs.huggingface.co/*` / `https://cdn-lfs-us-1.hf.co/*` (Hugging Face 公式 CDN)
- **取得内容**: モデル重み (約 135 MB int8 量子化版)、トークナイザー設定 JSON、モデルメタデータ JSON。**ユーザーの入力テキスト・PII・閲覧情報・個人情報は一切送信されません**
- **取得タイミング**: ML 検出機能を **初めて有効化した時の 1 回のみ**。以降はブラウザの IndexedDB にキャッシュされ再取得は発生しません
- **推論実行場所**: モデル取得後はブラウザ内部 (Offscreen Document + ONNX Runtime Web + WebAssembly) で実行され、**ネットワーク通信は一切発生しません**
- **デフォルトでは無効**: `mlEnabled: false` が初期値。ユーザーが自発的にトグルを ON にするまで Hugging Face Hub への通信は一切発生しません
- **ランタイム権限**: Chrome Web Store 版では `optional_host_permissions` を採用しており、インストール時にはホスト権限を要求しません。ユーザーがトグルを ON にした瞬間に Chrome が権限プロンプトを表示し、許可した場合のみモデル取得通信が可能になります
- **キャッシュの削除**: モデルキャッシュは Chrome の通常のサイトデータ管理 UI、または拡張機能アンインストール時に削除されます

ML 検出を無効化したい場合は、オプション画面の「ブラウザ内 ML 検出を有効化」スイッチを OFF にしてください。OFF 後はモデルキャッシュは保持されますが (再有効化を高速化するため)、推論は実行されません。完全にキャッシュを削除したい場合は Chrome の `chrome://settings/siteData` から該当 origin のデータを削除してください。

## 必要な権限

| 権限 | 用途 |
|---|---|
| `storage` | 上記の設定・除外リスト保存 |
| `activeTab` | アクティブタブのマスク件数を拡張アイコンに表示 |
| `host_permissions` (claude.ai, chatgpt.com, *.openai.com, gemini.google.com, *.manus.im) | これら 5 サービス上での content script 注入 (他サイトでは一切動作しません) |
| `optional_host_permissions` (`http://*/*`, v1.2.0 Store build) | ユーザーが指定したローカル/LAN 上の LLM サーバーへの HTTP 接続を行うため。**インストール時には要求されず**、ユーザーが LLM 機能を有効化した時点で Chrome がランタイム権限プロンプトを表示し、ユーザーの明示的な承認後にのみ付与されます。**Service Worker は `chrome.storage.local.localLlmUrl` と一致するホストのみ許可**し、それ以外のホストへのリクエストは `forbidden: host mismatch` でリジェクトされます |
| `host_permissions` (`http://*/*`, dev build のみ) | dev ビルド (non-Store) では従来どおりインストール時に要求されます。Store 配布版には含まれません |
| `optional_host_permissions` (`https://huggingface.co/*`, `https://cdn-lfs.huggingface.co/*`, `https://cdn-lfs-us-1.hf.co/*`, v1.3.0+) | ブラウザ内 ML 検出有効化時に **1 回限り** モデルファイル (約 135MB) を取得するため。**インストール時には要求されず**、ユーザーが ML 機能を有効化した時点で Chrome がランタイム権限プロンプトを表示します。モデル取得後の推論は完全オフラインで行われ、これら 3 ホストへの再通信は発生しません |
| `offscreen` (v1.3.0+) | ML 検出のための Offscreen Document を生成するため。ONNX Runtime Web の WASM backend は Service Worker 仕様で禁じられている `dynamic import()` を使用するため、隠しページ context が必要です。Offscreen Document は外部にレンダリングされず、ML 推論専用に内部使用されます |

## データの保持と削除

- ストレージに保存された設定・除外リストは、Chrome の通常の拡張機能管理 UI から拡張機能をアンインストールすると同時に削除されます
- 拡張機能内 options ページから「全削除」ボタンで除外リストを即時クリアできます

## 第三者への提供

提供しません。

## 子供のプライバシー

本拡張機能は 13 歳未満の子供を対象としていません。

## 変更履歴

このプライバシーポリシーが変更された場合、本拡張機能のリポジトリ (https://github.com/yuya4i/pii-masking) の `browser-extension/PRIVACY.md` を更新します。

## 連絡先

質問や懸念がある場合は、リポジトリの issue として報告してください:
https://github.com/yuya4i/pii-masking/issues
