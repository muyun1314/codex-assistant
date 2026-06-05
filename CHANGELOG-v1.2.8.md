# CHANGELOG v1.2.7 → v1.2.8

## 🐛 Bug 修复

### 密钥不一致导致无法通讯
- 便携版启动时多次随机生成访问密钥，导致代理进程使用的密钥与 `auth.json` 不一致
- **修复**：`auth.json` 为唯一权威源，启动直接读取，不再自动生成；仅"随机刷新"按钮可手动生成
- 涉及：`initProxyAuthKey()`、`GET /api/env`、`loadEnv()` 三处移除自动生成

### Codex++ 自动检测找不到安装路径
- 安装 Codex++ 后点击"自动检测"无效，缓存 null 值永不刷新
- **修复**：`getCodexPlusPlusPath()` 和 `getCodexPlusPlusManagerPath()` 的 null 缓存允许重新扫描

---

## 📦 打包优化

### 便携版完整自包含
- 便携版 ZIP 补回 `resources/node/node.exe`（之前被错误排除）
- 用户解压即用，不再依赖系统安装 Node.js
- ZIP 体积：2.2 MB → 28.3 MB

### 移除 MSI 格式
- 发行版仅保留 NSIS `.exe` 安装版 + 便携版 `.zip`，不再生成 `.msi`

### 隐私保护
- `user/` 目录不再打包进便携版（含密钥的 `.env` 不应泄漏）
- 发行版中已清理个人配置文件和运行时数据

---

## 🔧 其他
- `.gitignore` 增加备份文件、个人笔记等过滤规则
- 版本号升级至 1.2.8
- 代码推送到 GitHub: https://github.com/muyun1314/codex-assistant
