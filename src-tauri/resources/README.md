<h1 align="center">Codex Assistant</h1>

<p align="center">
  <strong>💡 让 Codex CLI 通过单一 base_url 访问 DeepSeek、小米 MiMo 与 OpenAI 的全功能本地代理 + Web 管理界面 + 桌面应用</strong>
</p>

<p align="center">
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-18%2B-339933?logo=node.js&logoColor=white" alt="Node.js 18+"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="Zero Dependencies">
  <img src="https://img.shields.io/github/v/release/wujfeng712-ui/Codex-Assistant?label=version" alt="Release version">
</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <strong>简体中文</strong> ·
  <a href="./README.ja.md">日本語</a> ·
  <a href="./README.ko.md">한국어</a> ·
  <a href="./README.es.md">Español</a>
</p>

---

## ✨ 是什么？

Codex CLI 使用 **OpenAI Responses API**，而 DeepSeek 和 MiMo 使用 **Chat Completions API**。  
Codex Assistant 在两者之间**双向转换** — 包含流式 SSE、工具调用与思考模式回合 — 让你在不修改 Codex 客户端的前提下，使用任意支持的模型。

**新增功能（v1.1.0+）：**
- 🖥️ **Web 可视化管理界面** — 提供商管理、环境变量配置、日志查看、一键启停
- 💻 **桌面应用版** — C# 启动器 + Edge --app 模式，免安装，解压即用
- 🔐 **API Key 加密存储** — AES-256-GCM + PBKDF2，磁盘上无明文密钥
- 🔄 **配置导入/导出** — 跨设备迁移配置（含密钥加密迁移）
- 🔔 **自动更新** — 检测 GitHub Releases 新版本并自动升级

---

## 🚀 快速开始（推荐：桌面应用版）

### 方式一：桌面应用（推荐，Windows）

1. 从 [Releases](https://github.com/wujfeng712-ui/Codex-Assistant/releases) 页面下载 `CodexAssistant.zip`
2. 解压到任意纯英文目录！纯英文目录！纯英文目录（无需安装）
3. 双击 `CodexAssistant.exe` 启动
4. 首次启动会自动生成访问密钥，并在浏览器中打开管理界面

> 💡 桌面应用使用 Edge `--app` 模式（无边框窗口），体积远小于 Electron 方案。

### 方式二：Web UI 版（手动启动）

```bash
git clone https://github.com/wujfeng712-ui/Codex-Assistant.git
cd Codex-Assistant

# 双击运行（Windows）
启动UI.cmd
```

启动后自动打开浏览器，访问 `http://127.0.0.1:8788/`（端口自动检测）。

---

## 📖 Web 管理界面使用指南

管理界面提供四个主要页面：

### 🎛️ 仪表盘（Dashboard）

| 功能 | 说明 |
|------|------|
| 代理状态 | 实时显示代理运行/停止状态，一键启停 |
| 运行时间 | 代理启动后自动计时，停止后自动清零 |
| 当前模型 | 显示已应用的模型，无模型时提示配置 |
| 提供商状态 | 显示已配置的提供商数量 |
| Codex 控制 | 启动/停止 Codex 或 Codex++ |
| 版本信息 | 显示当前版本，一键检查更新 |

#### 颜色主题

点击侧边栏底部🌙/☀️按钮切换浅色/深色模式，选择会保存在 `localStorage` 中。

### ⚙️ 提供商管理

| 操作 | 说明 |
|------|------|
| 添加提供商 | 填写名称、Base URL、API Key、协议类型、模型列表 |
| 编辑提供商 | 修改任意字段，API Key 以加密形式存储 |
| 删除提供商 | 确认后删除，同时清除关联的模型配置 |
| 应用配置到 Codex | 将当前选中的模型写入 `~/.codex/config.toml` |
| 测试连接 | 调用 `/v1/models` 验证 Base URL 和 API Key 是否有效 |
| 导入/导出 | 跨设备迁移配置（详见下方「配置迁移」） |

> ⚠️ **安全提示**：导出配置时，API Key 以**加密态**保存在 JSON 文件中（通过 `CAENC:base64...` 格式）。  
> 导出文件包含 `PROXY_AUTH_KEY` 明文（用于解密迁移），请妥善保管，切勿分享给不可信的第三方。  
> 如怀疑有泄露风险，请在各提供商管理平台作废当前 API Key 并重新生成。

### 🔧 环境配置

在界面中直接修改代理的环境变量，无需手动编辑 `.env` 文件：

| 变量 | 说明 |
|------|------|
| `PROXY_PORT` | 代理监听端口（默认 4000） |
| `DEFAULT_PROVIDER` | 模型未知时的回退提供商 |
| `LOG_LEVEL` | 日志级别（`silent`/`error`/`warn`/`info`/`debug`）|
| `UPSTREAM_TIMEOUT_MS` | 上游请求超时（默认 120000ms）|
| `STORE_TTL_MS` | 响应存储条目 TTL |
| `STORE_MAX` | 响应存储 LRU 容量 |
| `MAX_CONSECUTIVE_TOOL_CALLS` | 工具调用熔断器阈值 |

修改后点击「保存环境配置」即可生效（部分变量需重启代理）。

### 📝 运行日志

- 每次代理启动生成独立日志文件，命名格式：`proxy-YYYY-MM-DD-HH-MM-SS.log`
- 按保留天数自动清理过期日志
- 界面内可直接查看最近日志，支持按级别过滤

---

## 🔄 配置迁移（导入/导出）

### 导出配置

1. 在「提供商管理」页面点击「导出配置」
2. 确认弹出的安全提示（配置包含敏感信息）
3. 浏览器自动下载 `codex-assistant-config-YYYY-MM-DD.json`

**导出内容包含：**
- 所有提供商配置（API Key 为加密态 `CAENC:...`）
- `PROXY_AUTH_KEY` 明文（用于导入时解密 Key）
- 模型列表
- 环境变量配置（`PROXY_PORT`、`LOG_LEVEL` 等）

### 导入配置

1. 在目标机器上点击「导入配置」
2. 选择之前导出的 JSON 文件
3. 系统自动：
   - 用导出文件中的 `PROXY_AUTH_KEY` 解密所有 API Key
   - 用本机的 `PROXY_AUTH_KEY` 重新加密（确保密钥隔离）
   - 写入 `user/provider-configs.json`
   - 恢复模型列表和环境变量

> ⚠️ 导入后，若某些提供商的 API Key 无法解密（如导出文件被篡改），界面会提示「以下提供商需重新填写 API Key」。

---

## 🔐 API Key 加密机制

所有 API Key 在磁盘上均以加密形式存储：

```
存储格式：CAENC:<base64>
加密算法：AES-256-GCM
密钥派生：PBKDF2（100,000 次迭代，SHA-256）
主密钥：PROXY_AUTH_KEY（自动生成或手动指定）
```

**即使 `provider-configs.json` 被泄露，攻击者也必须在知道 `PROXY_AUTH_KEY` 的情况下才能解密 API Key。**

- 首次访问 Web UI 时，系统自动生成 `PROXY_AUTH_KEY`（48 位十六进制字符串）
- 也可在 `user/.env` 中手动指定：`PROXY_AUTH_KEY=sk-proxy-local-xxxx`
- 导出配置时，`PROXY_AUTH_KEY` 以明文形式包含在 JSON 中（用于跨设备解密）

---

## 🔔 自动更新

系统每次启动 Web UI 时自动检查 [GitHub Releases](https://github.com/wujfeng712-ui/Codex-Assistant/releases) 是否有新版本：

1. 点击侧边栏底部「检查版本更新」
2. 若有新版本，点击「一键更新」
3. 系统自动下载、解压、替换文件并重启

版本信息保存在 `version.json` 中：

```json
{
  "version": "1.1.0",
  "build": 1,
  "releasedAt": "2026-05-29",
  "changelog": "Initial release with auto-update support"
}
```

---

## 🏗️ 架构

```
┌─────────────────┐    Responses API     ┌──────────────────┐
│   Codex CLI    │────────────────────▶│  Codex Assistant  │
│                 │  Authorization:     │     :4000 (代理)   │
└─────────────────┘  Bearer <key>    └────────┬─────────┘
                                           │  按模型名路由
                           ┌───────────────┼──────────────────┐
                           │               │                  │
                           ▼               ▼                  ▼
          ┌────────────────┐  ┌────────────────┐   ┌──────────────┐
          │   DeepSeek V4  │  │  小米 MiMo    │   │    OpenAI    │
          │ Chat Completions │  │ Chat Completions│   │  Responses   │
          └────────────────┘  └────────────────┘   └──────────────┘

  Web 管理界面（端口 8788）
  ┌─────────────────────────────────────────────┐
  │  Dashboard │ 提供商 │ 环境配置 │ 运行日志  │
  └─────────────────────────────────────────────┘
```

---

## ⚙️ 手动配置（不使用 Web UI）

如果不使用 Web 管理界面，可手动配置：

### 1. 配置环境变量

```bash
mkdir -p user
cp env.example user/.env
```

编辑 `user/.env`：

```bash
# 必填：生成代理访问密钥
PROXY_AUTH_KEY=sk-proxy-local-$(openssl rand -hex 24)

# 可选：DeepSeek
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
DEEPSEEK_MODELS=deepseek-v4-pro,deepseek-v4-flash

# 可选：小米 MiMo
MIMO_API_KEY=...
MIMO_BASE_URL=https://token-plan-cn.xiaomimimo.com/v1
MIMO_MODELS=mimo-v2.5-pro

# 可选：OpenAI
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1
```

### 2. 启动代理

```bash
node --env-file=user/.env proxy.mjs
```

### 3. 让 Codex CLI 指向代理

编辑 `~/.codex/config.toml`：

```toml
model = "deepseek-v4-flash"
model_provider = "local_proxy"

[model_providers.local_proxy]
name = "local_proxy"
base_url = "http://127.0.0.1:4000/v1"
wire_api = "responses"
requires_openai_auth = true
```

设置 Codex 鉴权密钥（`~/.codex/auth.json`）：

```json
{ "OPENAI_API_KEY": "<同 user/.env 中的 PROXY_AUTH_KEY>" }
```

运行 `codex` — 完成。

---

## 🎯 路由规则

每个请求按以下优先级根据模型名进行路由：

1. **精确匹配** — 模型出现在 `DEEPSEEK_MODELS` / `MIMO_MODELS` / `OPENAI_MODELS`
2. **前缀启发** — 模型以 `OPENAI_MODEL_PREFIXES` 中任一项开头 → OpenAI
3. **名称提示** — 模型包含 `deepseek` 或 `mimo` → 对应提供商
4. **回退** — `DEFAULT_PROVIDER`，再退回到第一个已配置密钥的提供商

---

## 🧠 思考强度翻译

Codex 发送 `none | minimal | low | medium | high | xhigh`。各上游接受的格式不同：

| Codex effort | DeepSeek | MiMo | OpenAI |
|-------------|-----------|------|---------|
| `none` | `thinking: {type: "disabled"}` | `thinking: {type: "disabled"}` | 字段移除 |
| `minimal` | `reasoning_effort: "low"` | `reasoning_effort: "low"` | 透传 |
| `low` / `medium` / `high` | 透传 | 透传 | 透传 |
| `xhigh` | `reasoning_effort: "xhigh"` | 限制为 `high` | 限制为 `high` |

> **注意：** DeepSeek 会静默忽略 `enable_thinking: false`。本代理改用 `thinking: {type: "disabled"}`。

---

## 📡 API 端点

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| `GET` | `/health` | 否 | 健康检查 |
| `GET` | `/v1/models` | 是 | 合并后的模型列表 |
| `POST` | `/v1/responses` | 是 | Codex CLI 主端点（Responses API）|
| `POST` | `/v1/chat/completions` | 是 | 直接 Chat Completions 透传 |
| `POST` | `/v1/images/generations` | 是 | 图像生成（DALL-E，需配置 `OPENAI_API_KEY`）|
| `GET` | `/cop?url=...` | 是 | URL 抓取（Jina Reader / 原生 HTTP）|
| `POST` | `/cop` | 是 | 自定义方法/请求头/请求体的 URL 抓取 |

### Web UI 端点（端口 8788）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/` | 管理界面 HTML |
| `GET` | `/ui-frontend.css` | 界面样式 |
| `GET` | `/ui-frontend.js` | 界面逻辑 |
| `GET` | `/api/providers` | 获取所有提供商配置 |
| `POST` | `/api/providers` | 保存提供商配置 |
| `DELETE` | `/api/providers/:name` | 删除提供商 |
| `GET` | `/api/env` | 获取环境变量 |
| `POST` | `/api/env` | 保存环境变量 |
| `POST` | `/api/proxy/start` | 启动代理 |
| `POST` | `/api/proxy/stop` | 停止代理 |
| `GET` | `/api/proxy/status` | 获取代理状态 |
| `GET` | `/api/codex/start-app` | 启动 Codex CLI |
| `GET` | `/api/codex/start-codexpp` | 启动 Codex++ |
| `POST` | `/api/codex/stop` | 停止 Codex |
| `GET` | `/api/export-config` | 导出配置 |
| `POST` | `/api/import-config` | 导入配置 |
| `GET` | `/api/check-update` | 检查版本更新 |
| `POST` | `/api/apply-update` | 执行更新 |

---

## 🧪 冒烟测试

```bash
./scripts/smoke.sh                    # 默认使用 localhost:4000
./scripts/smoke.sh http://host:4000   # 自定义目标
MODEL=mimo-v2.5-pro ./scripts/smoke.sh  # 测试不同模型
```

执行 30 项检查，覆盖端点、入参形态、鉴权门、流式完成、思考强度翻译、工具调用回合与供应商锁定。

---

## 🔧 进阶用法

### Node 18–19 启动

`--env-file` 在 Node 20 才引入。旧版本请使用：

```bash
set -a && source .env && set +a && node proxy.mjs
```

### 后台模式

```bash
nohup node --env-file=.env proxy.mjs > /tmp/codex-assistant.log 2>&1 &
```

### 多密钥供应商锁定

在 `.env` 中使用 `PROXY_KEYS` 创建按供应商隔离的入站密钥：

```bash
PROXY_KEYS=sk-deepseek-aaa:deepseek,sk-mimo-bbb:mimo,sk-all-ccc:*
```

然后创建多个 Codex 配置，切换时更改 `config.toml` 中的 `model_provider`。

### 模型清单单一来源

将 `MODEL_CATALOG_PATH` 指向 Codex 使用的同一份 JSON 文件（`config.toml` 中的 `model_catalog_json`），自动保持模型列表同步：

```bash
MODEL_CATALOG_PATH=~/.codex/proxy-models.json
```

---

## 🛠️ 配合 CC Switch 使用

[CC Switch](https://github.com/farion1231/cc-switch) 是一款热门桌面应用，可一键管理和切换多种 AI CLI 工具（Claude Code、Codex、Gemini CLI 等）的供应商配置。

### 设置

1. 打开 CC Switch → **Codex** 选项卡 → **添加供应商**
2. 填写供应商信息：

   | 字段 | 值 |
   |------|-----|
   | 名称 | `Codex Assistant`（或你喜欢的标签）|
   | API Key | 你的 `PROXY_AUTH_KEY`（来自 `user/.env`）|
   | Base URL | `http://127.0.0.1:4000/v1` |

3. 点击 **启用** — CC Switch 会自动写入 `~/.codex/auth.json` 并更新 `config.toml`。

---

## ❓ 常见问题

| 症状 | 原因 | 解决方案 |
|------|------|----------|
| `EADDRINUSE :4000` | 端口被占用 | 更改 `PROXY_PORT` 在 `.env` 中；代理会优先尝试 4000，若被自己占用则杀旧进程重用，若被其他软件占用则从 4001 逐个尝试 |
| `401 Unauthorized` | 鉴权密钥不匹配 | 确认 `~/.codex/auth.json` 中的 `OPENAI_API_KEY` 与 `user/.env` 中的 `PROXY_AUTH_KEY` 一致 |
| `代理异常退出` | 端口冲突或启动失败 | 查看 `log/` 目录中的代理日志 |
| 运行时间显示 `--` | 代理未启动或计时器未初始化 | 启动代理后等待 5 秒，运行时间会自动显示 |
| 导出配置后无法导入 | `PROXY_AUTH_KEY` 不匹配 | 确保导入时目标机器的 `PROXY_AUTH_KEY` 正确；或手动重新填写 API Key |
| 任务未完成就中断 | web_fetch 死循环检测触发 | 已修复：v1.1.0+ 中 `isStuckLoop` 不再中断循环，改为继续用缓存结果；`MAX_FETCH_LOOPS` 已从 5 提升到 8 |

---

## 📦 项目结构

```
Codex-Assistant/
├── proxy.mjs              # 代理核心（路由、协议转换、鉴权、流处理）
├── ui-server.mjs         # Web UI 后端（提供商 CRUD、进程管理、静态服务）
├── ui-frontend.html      # 管理界面 HTML
├── ui-frontend.css       # 管理界面样式（浅色/深色主题）
├── ui-frontend.js        # 管理界面前端逻辑
├── src/
│   ├── shared.mjs        # 共用工具函数
│   ├── protocol.mjs      # 协议翻译（Responses ↔ Chat Completions）
│   ├── crypto-store.mjs  # API Key 加密存储（AES-256-GCM）
│   ├── web-fetch.mjs    # 内置 web_fetch 工具实现
│   └── updater.mjs      # 自动更新逻辑
├── user/                  # 用户专属配置（不提交到 Git）
│   ├── .env              # 环境变量（代理端口、日志级别等）
│   ├── provider-configs.json  # 提供商配置（API Key 加密存储）
│   └── proxy-models.json # 模型清单（可选）
├── dist/                  # 桌面应用分发文件
│   └── CodexAssistant.exe  # C# 启动器（Edge --app 模式）
├── scripts/
│   └── smoke.sh         # 冒烟测试脚本
├── tests/
│   └── protocol.test.mjs # 协议转换单元测试
├── env.example            # 环境变量模板
├── proxy-models.example.json  # 模型清单模板
├── package.json           # Node.js 项目配置
├── version.json          # 版本信息
└── 启动UI.cmd           # Windows 启动脚本
```

---

## 🔐 安全注意事项

- **API Key 保护**：所有 API Key 在磁盘上以加密形式存储（`CAENC:base64...`），使用 AES-256-GCM + PBKDF2 加密。
- **入站鉴权**：所有 `/v1/*` 端点均受 `PROXY_AUTH_KEY` 保护（唯一例外：`/health`）。
- **CSRF 保护**：Web UI 的所有非 GET 请求均需携带 `X-CSRF-Token` 请求头。
- **SSRF 防护**：新的上游 URL 均经过 `validateProviderUrl()` 校验。
- **配置导出警告**：导出配置时系统会弹窗警告，提示用户妥善保管包含敏感信息的 JSON 文件。
- **用户配置隔离**：所有用户专属配置均存放在 `user/` 文件夹中，该文件夹已加入 `.gitignore`。

---

## 💻 开发

### 环境要求

- Node.js 18+
- macOS / Linux / Windows
- 至少一个上游 API 密钥（DeepSeek、MiMo 或 OpenAI）

### 本地开发

```bash
# 安装依赖（实际上零依赖，此步骤可选）
npm install

# 运行代理（手动模式）
node --env-file=user/.env proxy.mjs

# 运行 Web UI（开发模式）
npm start
# 然后访问 http://127.0.0.1:8788/

# 运行测试
npm test
```

### 代码审查标准

本项目遵循严格的代码审查标准，详见 [CODE_REVIEW.md](./CODE_REVIEW.md)。

**关键规则：**
- `proxy.mjs` 和 `ui-server.mjs` 只能使用 `var`（ES5 语法兼容）
- 所有 API Key 必须通过 `crypto-store.mjs` 加密
- 所有 `try-catch` 的 catch 块不得为空
- 新功能优先放在 `src/` 独立模块中，避免 `proxy.mjs` 进一步膨胀

---

## 📝 更新日志

### v1.1.0（2026-05-29）

- ✨ 新增 Web 可视化管理界面
- ✨ 新增桌面应用版（C# 启动器 + Edge --app 模式）
- ✨ 新增 API Key 加密存储（AES-256-GCM + PBKDF2）
- ✨ 新增配置导入/导出功能
- ✨ 新增自动更新检测
- ✨ 新增浅色/深色主题切换
- 🔧 修复端口占用处理逻辑（优先 4000，智能识别进程归属）
- 🔧 修复代理停止后运行时间继续走的问题
- 🔧 修复手动停止代理显示「代理异常退出」的问题
- 🔧 修复导出配置包含明文 `PROXY_AUTH_KEY` 的安全问题
- 🔧 修复 web_fetch 死循环检测导致任务中断的问题
- 🔧 `MAX_FETCH_LOOPS` 从 5 提升到 8

---

## 📄 许可证

MIT — 详见 [LICENSE](./LICENSE)。

---

## 🙏 致谢

- [Codex CLI](https://github.com/openai/codex) — OpenAI 官方 CLI 工具
- [CC Switch](https://github.com/farion1231/cc-switch) — AI CLI 工具供应商管理桌面应用
- [Jina Reader](https://r.jina.ai) — URL 内容抓取服务

---

<p align="center">
  <i>用 ❤️ 制作 by <a href="https://github.com/wujfeng712-ui">wujfeng712-ui</a></i>
</p>
