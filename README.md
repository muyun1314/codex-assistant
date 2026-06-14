<h1 align="center">Codex Assistant</h1>

<p align="center">
  <strong>让 Codex 通过单一 base_url 访问 DeepSeek、小米 MiMo 等任意模型的本地代理 + 桌面管理工具</strong>
</p>

<p align="center">
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-20%2B-339933?logo=node.js&logoColor=white" alt="Node.js 20+"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="Zero Dependencies">
  <img src="https://img.shields.io/badge/platform-Windows%2010%2B-blue?logo=windows" alt="Windows 10+">
</p>

<p align="center">
  <strong>简体中文</strong>
</p>

---

## 是什么

Codex 使用 OpenAI Responses API，而 DeepSeek、MiMo 等模型使用 Chat Completions API。
Codex Assistant 是一个**零依赖本地代理**，在两者之间双向转换（流式 SSE、工具调用、思考模式），让 Codex 能使用任意模型。

同时提供基于 **Tauri + WebView2** 的桌面管理工具，可视化管理提供商、环境配置、日志导出，无需手动编辑配置文件。

---

## 快速开始

### 方式一：便携版（推荐）

1. 从 [Releases](https://github.com/muyun1314/codex-assistant/releases) 下载 `Codex-Assistant-vX.X.X-portable.zip`
2. 解压到任意目录
3. 双击 `codex-assistant.exe` 启动

> 首次运行前，建议先运行附带的 `Codex-Assistant-环境检测.bat` 检查运行环境。

### 方式二：安装版

下载 `Codex-Assistant-vX.X.X-setup.exe`，双击安装即可。

### 系统要求

| 组件 | 说明 |
|------|------|
| Windows 10+ | Win11 预装 WebView2，Win10 可能需要手动安装 |
| WebView2 运行时 | 软件界面渲染引擎（缺失时启动会自动提示安装） |
| 至少一个 API Key | DeepSeek / MiMo / OpenAI 等 |

> 软件启动时会自动检测 WebView2，如缺失会弹出引导窗口帮你安装。VC++ 运行库已静态链接进 exe，无需额外安装。

---

## 管理界面功能

### 仪表盘

- 代理一键启停，实时显示状态和运行时间
- Codex 启动/停止控制
- 当前模型显示，快速应用到 Codex
- 浅色/深色/跟随系统 三种主题

### 提供商管理

- 添加 / 编辑 / 删除提供商
- 自动拉取模型列表
- **API Key 用机器码加密存储**（AES-256-GCM），换电脑无法解密，保障安全
- **测试连接** — 验证 Base URL 和 API Key 是否有效
- **导入/导出配置** — 弹窗选择保存位置

### 环境配置

可视化编辑代理环境变量：端口、日志级别、超时、上下文裁剪等。

### 运行日志

- 实时日志查看，按级别筛选
- **导出日志** — 弹窗选择保存位置
- 操作日志记录

---

## 架构

```
┌──────────────┐   Responses API    ┌────────────────────┐
│   Codex CLI  │──────────────────▶│  Codex Assistant   │
│   Codex App  │  local_proxy       │   :4000 (代理)      │
└──────────────┘                    └─────────┬──────────┘
                                             │
                           ┌─────────────────┼─────────────────┐
                           ▼                 ▼                 ▼
                     ┌──────────┐    ┌──────────┐     ┌──────────┐
                     │ DeepSeek │    │   MiMo   │     │  OpenAI  │
                     └──────────┘    └──────────┘     └──────────┘

  Tauri 桌面管理界面 (WebView2)
  ┌─────────────────────────────────────────────┐
  │  仪表盘 │ 提供商管理 │ 环境配置 │ 运行日志  │
  └─────────────────────────────────────────────┘
```

---

## 路由规则

1. **精确匹配** — 在已配置的提供商模型列表中查找
2. **前缀/名称启发** — 模型名包含 `deepseek`、`mimo`、`gpt` → 对应提供商
3. **默认回退** — `DEFAULT_PROVIDER` 或第一个已配置的提供商

---

## 思考强度翻译

| Codex effort | DeepSeek | MiMo | OpenAI |
|-------------|-----------|------|---------|
| `none` | `thinking: {type: "disabled"}` | `thinking: {type: "disabled"}` | 字段移除 |
| `minimal` ~ `high` | 透传 | 透传 | 透传 |
| `xhigh` | 透传 | 限制为 `high` | 限制为 `high` |

---

## 核心特性

### 安全

- **机器码加密**：API Key 用本机 MachineGuid 派生密钥加密，换电脑即失效
- **入站鉴权**：`/v1/*` 端点受 `PROXY_AUTH_KEY` 保护
- **CSRF 防护**：Web UI 写操作需携带 Token
- **SSRF 防护**：上游 URL 校验

### 性能

- **零外部依赖**：纯 Node.js 实现，启动快
- **CRT 静态链接**：exe 自包含 VC++ 运行库，无需额外安装
- **上下文裁剪**：自动裁剪旧的工具调用日志，保留对话上下文（可配置）
- **WebView2 启动检测**：缺失时自动引导安装

### 体验

- **弹窗保存**：日志/配置导出使用 Windows 原生保存对话框
- **三色主题**：浅色、深色、跟随系统
- **高清图标**：7 种尺寸 ICO，任意分辨率都清晰

---

## 项目结构

```
Codex-Assistant/
├── proxy.mjs                 # 代理核心（路由、协议转换、鉴权、流处理）
├── ui-server.mjs            # Web UI 后端 + 进程管理
├── build-release.mjs        # 打包脚本
├── sync-version.mjs         # 版本号同步脚本
├── generate-icons.py        # 图标生成脚本
├── src-tauri/
│   ├── src/main.rs          # Tauri 主程序（Rust）
│   ├── resources/           # 打包资源
│   │   ├── ui-frontend.html  # 管理界面
│   │   ├── ui-frontend.css   # 界面样式
│   │   ├── ui-frontend.js    # 界面逻辑（模块化加载）
│   │   ├── common.js        # 公共模块
│   │   ├── dashboard.js     # 仪表盘模块
│   │   ├── providers.js     # 提供商模块
│   │   ├── env.js           # 环境配置模块
│   │   ├── backup.js        # 备份模块
│   │   ├── settings.js      # 设置模块
│   │   ├── proxy.mjs        # 代理核心
│   │   ├── ui-server.mjs    # UI 后端
│   │   ├── version.json     # 版本信息（唯一源）
│   │   ├── LICENSE          # 许可证
│   │   └── src/             # 代理子模块
│   │       ├── protocol.mjs       # 协议转换
│   │       ├── crypto-store.mjs   # 加密存储
│   │       ├── streaming.mjs      # 流处理
│   │       ├── web-fetch.mjs      # URL 抓取
│   │       └── ...
│   └── icons/               # 应用图标
├── dist/                    # 打包输出
└── user/                    # 用户数据（不提交 Git）
```

---

## API 端点

### 代理端口 (默认 4000)

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/health` | 健康检查 |
| `GET` | `/v1/models` | 模型列表 |
| `POST` | `/v1/responses` | Responses API（Codex 主端点） |
| `POST` | `/v1/chat/completions` | Chat Completions 透传 |

### Web UI 端口 (自动分配)

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` `/POST` | `/api/providers` | 提供商 CRUD |
| `GET` `/POST` | `/api/env` | 环境变量 |
| `POST` | `/api/proxy/start` `/stop` | 代理启停 |
| `GET` | `/api/status` | 运行状态 |
| `POST` | `/api/codex/start-app` `/stop` | Codex 控制 |
| `POST` | `/api/codex-config` | 写入 Codex 配置 |
| `GET` | `/api/logs/export` | 导出日志 |
| `POST` | `/api/save-file-dialog` | 弹窗保存文件 |
| `GET` `/POST` | `/api/trim-config` | 上下文裁剪配置 |

---

## 常见问题

| 问题 | 解决方案 |
|------|----------|
| 双击无反应 | 运行环境检测脚本，安装 WebView2 |
| `401 Unauthorized` | 确认 Codex auth.json 与代理密钥一致 |
| 代理启动失败 | 检查端口占用，查看日志 |
| API Key 无法解密 | 在提供商管理中重新输入（换了电脑需要重新配置） |

---

## 许可证

MIT License — Copyright (c) 2026 muyun1314 (Codex Assistant)

---

<p align="center">
  <i>Built with ❤️ by <a href="https://github.com/muyun1314">muyun1314</a></i>
</p>
