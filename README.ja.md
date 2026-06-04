<h1 align="center">Codex Assistant</h1>

<p align="center">
  ゼロ依存のローカルプロキシ — <a href="https://github.com/openai/codex">Codex CLI</a> から
  単一の <code>base_url</code> で <strong>DeepSeek</strong>、<strong>Xiaomi MiMo</strong>、<strong>OpenAI</strong> にアクセス。
</p>

<p align="center">
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-18%2B-339933?logo=node.js&logoColor=white" alt="Node.js 18+"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="Zero Dependencies">
</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.zh-CN.md">简体中文</a> ·
  <strong>日本語</strong> ·
  <a href="./README.ko.md">한국어</a> ·
  <a href="./README.es.md">Español</a>
</p>

---

Codex CLI は **OpenAI Responses API** を、DeepSeek と MiMo は **Chat Completions** を話します。
Codex Assistant は両者を双方向に変換します — ストリーミング SSE、ツール呼び出し、思考モードのラウンドトリップを含む — Codex クライアントを改変せずに任意の対応モデルを利用できます。

## 機能

- **マルチプロバイダー・ルーティング** — モデル名から DeepSeek / MiMo / OpenAI を自動選択
- **双方向プロトコル変換** — Responses API ↔ Chat Completions、ストリーミング SSE ブリッジ付き
- **プロバイダー別の Reasoning Effort 変換** — Codex の `none | minimal | low | medium | high | xhigh` を各上流のネイティブ形式へマッピング
- **思考モード × ツール呼び出しラウンドトリップ** — `reasoning_content` をキャッシュ・再生し、DeepSeek の思考モードを複数ターンのツール呼び出しでも維持
- **インバウンド認証** — `PROXY_AUTH_KEY` / `PROXY_KEYS`、キー単位でプロバイダーをロック可能
- **セッション継続** — `previous_response_id` をプロバイダー横断で利用可能（LRU 制限ストア）
- **組み込み `web_fetch` ツール** — URL 多用シナリオでサンドボックス制限を回避
- **ツール呼び出しサーキットブレーカー** — ソフト警告 + ハード剥離で暴走ループを防止
- **シングルファイル・ゼロ依存** — `proxy.mjs` 1 本（約 2000 行）、`npm install` 不要

## クイックスタート

### 1. 設定

```bash
git clone https://github.com/wujfeng712-ui/Codex Assistant.git
cd Codex Assistant
cp env.example .env
```

`.env` を編集（最低限）：

```bash
PROXY_AUTH_KEY=sk-proxy-local-$(openssl rand -hex 24)   # 自動生成
DEEPSEEK_API_KEY=sk-...                                  # platform.deepseek.com から取得
```

### 2. プロキシを起動

```bash
node --env-file=.env proxy.mjs
```

> Node 18–19 やバックグラウンド実行は [Advanced Usage](#advanced-usage) を参照。

### 3. Codex CLI をプロキシに向ける

`~/.codex/config.toml` を編集：

```toml
model = "deepseek-v4-flash"
model_provider = "local_proxy"

[model_providers.local_proxy]
name = "local_proxy"
base_url = "http://127.0.0.1:4000/v1"
wire_api = "responses"
requires_openai_auth = true
```

Codex 用の認証キーを設定：

```bash
# ~/.codex/auth.json
{ "OPENAI_API_KEY": "<.env の PROXY_AUTH_KEY と同じ値>" }
```

> **[CC Switch](https://github.com/farion1231/cc-switch) をお使いですか？** 手動編集の代わりに GUI でプロバイダーを追加できます。[CC Switch との連携](#cc-switch-との連携) を参照。

`codex` を実行 — 完了。

## アーキテクチャ

```
┌─────────────┐    Responses API    ┌──────────────┐
│  Codex CLI  │────────────────────▶│ Codex Assistant │
│             │  Authorization:     │    :4000     │
└─────────────┘  Bearer <key>       └──────┬───────┘
                                           │  モデル名でルーティング
                   ┌───────────────────────┼────────────────────────┐
                   │                       │                        │
                   ▼                       ▼                        ▼
          ┌────────────────┐      ┌────────────────┐       ┌──────────────┐
          │   DeepSeek V4  │      │  Xiaomi MiMo   │       │    OpenAI    │
          │ Chat Complet.  │      │ Chat Complet.  │       │  Responses   │
          └────────────────┘      └────────────────┘       └──────────────┘
```

## 設定

すべて環境変数で設定（完全な説明は `env.example` を参照）：

### 認証

| 変数 | デフォルト | 説明 |
|---|---|---|
| `PROXY_AUTH_KEY` | — | 単一インバウンドキー（プロバイダーロックなし） |
| `PROXY_KEYS` | — | マルチキー表：`<key>:<provider>,...`、provider ∈ `deepseek` / `mimo` / `openai` / `*` |

両方空 = 認証無効（非推奨）。

### 上流プロバイダー

| 変数 | デフォルト | 説明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | — | DeepSeek 上流キー |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com/v1` | DeepSeek base URL |
| `DEEPSEEK_MODELS` | `deepseek-v4-pro,deepseek-v4-flash` | 公開するモデル一覧 |
| `MIMO_API_KEY` | — | Xiaomi MiMo 上流キー |
| `MIMO_BASE_URL` | `https://token-plan-cn.xiaomimimo.com/v1` | MiMo base URL |
| `MIMO_MODELS` | `mimo-v2.5-pro` | 公開するモデル一覧（**小文字必須**） |
| `OPENAI_API_KEY` | — | OpenAI 上流キー（オプトイン） |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI base URL |
| `OPENAI_MODELS` | — | 明示的な OpenAI モデル一覧 |
| `OPENAI_MODEL_PREFIXES` | `gpt-,o1,o3,o4,codex-,chatgpt-` | ヒューリスティックなルーティング接頭辞 |

### モデルカタログ

| 変数 | デフォルト | 説明 |
|---|---|---|
| `MODEL_CATALOG_PATH` | — | `proxy-models.json` のパス。上記 `*_MODELS` を上書き。Codex が `model_catalog_json` で読む同じファイル |

### チューニング

| 変数 | デフォルト | 説明 |
|---|---|---|
| `PROXY_PORT` | `4000` | リッスンポート |
| `DEFAULT_PROVIDER` | auto | モデル不明時のフォールバック |
| `LOG_LEVEL` | `info` | `silent` / `error` / `warn` / `info` / `debug` |
| `ACCESS_LOG` | on | `0` でリクエスト毎のアクセスログを抑制 |
| `UPSTREAM_TIMEOUT_MS` | `120000` | 上流リクエストのタイムアウト |
| `STORE_TTL_MS` | `3600000` | レスポンスストアのエントリ TTL |
| `STORE_MAX` | `500` | レスポンスストアの LRU 容量 |
| `GITHUB_TOKEN` | — | 任意。未設定時は `gh auth token` を遅延実行 |

## ルーティング規則

各リクエストはモデル名で以下の優先順位にルーティングされます：

1. **完全一致** — `DEEPSEEK_MODELS` / `MIMO_MODELS` / `OPENAI_MODELS` に該当
2. **接頭辞ヒューリスティック** — `OPENAI_MODEL_PREFIXES` のいずれかで開始 → OpenAI
3. **名前ヒント** — `deepseek` または `mimo` を含む → 対応プロバイダー
4. **フォールバック** — `DEFAULT_PROVIDER`、次にキー設定済みの最初のプロバイダー

## Reasoning Effort 変換

Codex は `none | minimal | low | medium | high | xhigh` を送信します。各上流の受け付け範囲は異なります：

| Codex effort | DeepSeek | MiMo | OpenAI |
|---|---|---|---|
| `none` | `thinking: {type: "disabled"}` | `thinking: {type: "disabled"}` | フィールド削除 |
| `minimal` | `reasoning_effort: "low"` | `reasoning_effort: "low"` | パススルー |
| `low` / `medium` / `high` | パススルー | パススルー | パススルー |
| `xhigh` | `reasoning_effort: "xhigh"` | `high` にクランプ | `high` にクランプ |

> **注意：** DeepSeek は `enable_thinking: false` を黙って無視します。本プロキシでは代わりに `thinking: {type: "disabled"}` を使用します。

## エンドポイント

| メソッド | パス | 認証 | 説明 |
|---|---|---|---|
| `GET` | `/health` | 不要 | ヘルスチェック |
| `GET` | `/v1/models` | 必要 | マージ済みモデル一覧 |
| `POST` | `/v1/responses` | 必要 | Codex CLI メインエンドポイント（Responses API） |
| `POST` | `/v1/chat/completions` | 必要 | Chat Completions のパススルー |
| `GET` | `/cop?url=...` | 必要 | URL 取得（Jina Reader / ネイティブ HTTP） |
| `POST` | `/cop` | 必要 | 任意の method/headers/body での URL 取得 |

## スモークテスト

```bash
./scripts/smoke.sh                    # デフォルトで localhost:4000
./scripts/smoke.sh http://host:4000   # ターゲット指定
MODEL=mimo-v2.5-pro ./scripts/smoke.sh  # 別モデルでテスト
```

エンドポイント、入力形状、認証ゲート、ストリーミング完了、effort 変換、ツール呼び出しラウンドトリップ、プロバイダーロックを含む 30 項目をチェックします。

## CC Switch との連携

[CC Switch](https://github.com/farion1231/cc-switch) は、複数の AI CLI ツール（Claude Code、Codex、Gemini CLI など）のプロバイダー設定をワンクリックで管理・切り替えられる人気のデスクトップアプリです。

### セットアップ

1. CC Switch を開く → **Codex** タブ → **プロバイダーを追加**
2. プロバイダー情報を入力：

   | フィールド | 値 |
   |---|---|
   | 名前 | `Codex Assistant`（任意のラベル） |
   | API Key | `.env` の `PROXY_AUTH_KEY` |
   | Base URL | `http://127.0.0.1:4000/v1` |

3. **有効化** をクリック — CC Switch が `~/.codex/auth.json` への書き込みと `config.toml` の更新を自動で行います。

### マルチプロバイダー切り替え

複数の上流キー（例：DeepSeek 用と MiMo 用）がある場合、`.env` の `PROXY_KEYS` でプロバイダー別のインバウンドキーを作成します：

```bash
PROXY_KEYS=sk-deepseek-aaa:deepseek,sk-mimo-bbb:mimo,sk-all-ccc:*
```

キーごとに CC Switch のプロファイルを作成すれば、プロファイル切り替えで Codex Assistant のルーティング先が変わります。

### CLI での代替手段

ターミナル派の方は [cc-switch-cli](https://github.com/SaladDay/cc-switch-cli) で GUI なしのプロファイル切り替えが可能です：

```bash
# プロファイル一覧
cc-switch list

# Codex Assistant プロファイルに切り替え
cc-switch use Codex Assistant
```

> **ヒント：** プロファイル切り替え後、ターミナルを再起動（または新しいシェルで `codex` を実行）して認証を反映させてください。

## Advanced Usage

- **Node 18–19 起動** — `--env-file` は Node 20 で追加されました。旧バージョンでは：
  ```bash
  set -a && source .env && set +a && node proxy.mjs
  ```
- **バックグラウンド実行**：
  ```bash
  nohup node --env-file=.env proxy.mjs > /tmp/Codex Assistant.log 2>&1 &
  ```
- **マルチキーのプロバイダーロック** — 各インバウンドキーを特定プロバイダーに固定。マルチプロファイル構成向け。`PROXY_KEYS` の書式は `env.example` を参照。
- **モデルカタログの単一情報源** — `MODEL_CATALOG_PATH` を Codex の `model_catalog_json` と同じ JSON に向け、モデル一覧を自動同期。

## トラブルシューティング

| 症状 | 原因 | 解決策 |
|---|---|---|
| `EADDRINUSE :4000` | ポートが使用中 | `lsof -ti:4000 \| xargs kill` または `.env` で `PROXY_PORT` を変更 |
| `401 Unauthorized` | 認証キー不一致 | `~/.codex/auth.json` の `OPENAI_API_KEY` が `.env` の `PROXY_AUTH_KEY` と一致しているか確認 |
| `--env-file: not recognized` | Node.js < 20 | `set -a && source .env && set +a && node proxy.mjs` を使用 |
| 上流タイムアウト | プロバイダーの応答が遅い | `.env` の `UPSTREAM_TIMEOUT_MS` を増加（デフォルト 120 000 ms） |
| モデルが見つからない | `*_MODELS` に未登録 | `DEEPSEEK_MODELS` / `MIMO_MODELS` / `OPENAI_MODELS` に追加、または `MODEL_CATALOG_PATH` を使用 |

## 動作要件

- Node.js 18+
- macOS / Linux / Windows
- 上流 API キーが少なくとも 1 つ（DeepSeek、MiMo、または OpenAI）

## ライセンス

MIT — [LICENSE](./LICENSE) を参照。
