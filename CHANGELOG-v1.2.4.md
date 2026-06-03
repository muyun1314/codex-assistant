# Codex Assistant v1.2.4 更新日志

> 发布日期：2026-06-03

## 新增功能

### 关闭行为"每次询问"模式
- 点击窗口关闭按钮时弹出确认对话框
- 支持三种选择：最小化到托盘、直接退出程序、取消
- 与 Tauri v2 权限系统正确集成

### 主题外观设置
- 新增"跟随系统"主题选项（默认）
- 支持日间模式、夜间模式切换
- 设置页面与左下角按钮联动

### 配置文件注释保留机制
- 修改 Codex 配置时不再删除原内容
- 原内容以 `# 替换去掉注释，即可恢复初始配置` 前缀注释保留
- 用户可通过文本编辑器批量替换恢复原配置
- Codex Assistant 配置追加在分割线后面

### 版本号集中管理
- 新增 `sync-version.mjs` 脚本
- `version.json` 作为唯一版本号源头
- 构建时自动同步版本号到所有配置文件

### 首次运行自动备份优化
- 备份文件命名为"原始配置自动备份-YYYY-MM-DD-HH-MM-SS"
- 默认锁定状态，不可删除
- 用户可手动解锁后删除

## Bug 修复

### 严重 Bug 修复
- **消除 proxy.mjs 重复实现**：统一从 src/ 模块导入函数
- **统一限流器实现**：删除 proxy.mjs 中的本地限流器，使用 src/rate-limit.mjs
- **parseToml 风险提示**：记录不支持的 TOML 格式

### 中等 Bug 修复
- **日志流关闭**：添加 process.on('exit') 关闭日志流
- **PowerShell 命令加固**：使用 execFileSync 替代模板字符串拼接
- **Node.js 进程清理**：关闭程序时正确清理 node.exe 进程
- **Tauri 权限配置**：修复事件监听和自定义命令权限问题

### UI 修复
- 左上角 Logo 替换为软件图标
- 移除左下角颜色模式按钮（改为设置界面配置）
- 关闭行为和主题外观选项改为横向排列
- MIT 开源许可证添加作者名字

## 改进

### 配置文件管理
- 配置同步时只修改分割线后面的内容
- 项目信任配置追加到分割线后面
- 日志文件命名使用本地时间（24小时制）

### 辅助模型映射
- 修复辅助模型别名映射逻辑
- 优先使用 auxProvider，回退到 mainProvider

## 技术改进

### 代码质量
- 消除约 200 行重复代码
- 统一函数导入路径
- 添加 MAX_ENTRY_SIZE 检查到 src/store.mjs

### 权限系统
- 配置 Tauri v2 远程 URL 权限
- 创建自定义命令权限定义文件
- 支持 127.0.0.1 本地 URL 访问

## 文件变更

### 新增文件
- `sync-version.mjs` - 版本同步脚本
- `src-tauri/permissions/` - Tauri 权限定义目录

### 修改文件
- `proxy.mjs` - 消除重复实现，统一导入
- `ui-server.mjs` - 配置管理优化，备份逻辑改进
- `ui-frontend.js` - 主题设置，关闭确认对话框
- `ui-frontend.html` - UI 布局优化
- `ui-frontend.css` - 新增 radio card 样式
- `src/store.mjs` - 添加 MAX_ENTRY_SIZE 检查
- `src-tauri/src/main.rs` - 关闭行为，进程清理
- `src-tauri/capabilities/default.json` - 权限配置
- `LICENSE` - 添加作者名字

---

## 升级说明

1. 下载新版本安装包
2. 安装覆盖旧版本
3. 首次运行会自动备份原配置（如果未被修改过）

## 已知问题

- parseToml 不支持嵌套表、数组等复杂格式（后续版本改进）
- responsesRequestToChatCompletions 保留本地实现（差异太大）

---

*感谢使用 Codex Assistant！*
