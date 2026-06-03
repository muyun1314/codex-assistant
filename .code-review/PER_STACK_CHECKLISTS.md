# 技术栈专项审查清单

> 在通用清单基础上，每个技术栈需额外关注以下专项检查项。
> 审查时选择对应的技术栈清单，与 `CODE_REVIEW_STANDARDS.md` §3 通用清单叠加使用。

---

## Rust 专项清单

### 内存安全
- [ ] `unsafe` 块是否有充分的安全论证注释？能否用安全抽象替代？
- [ ] 裸指针操作是否有边界检查？
- [ ] `RefCell`/`Mutex`/`RwLock` 是否存在潜在的 panic（borrow 冲突）？
- [ ] 是否存在循环引用导致的内存泄漏（`Rc` + `RefCell` 组合）？

### 并发
- [ ] `Send`/`Sync` 约束是否正确推导？
- [ ] `Arc<Mutex<T>>` 的锁粒度是否合理（避免长持锁）？
- [ ] `channel` 使用是否符合生产者-消费者语义，发送端是否正确 drop？
- [ ] `tokio::spawn` 的 Future 是否为 `'static`？
- [ ] `select!` 分支是否有饥饿风险？

### 加密（如项目涉及）
- [ ] Nonce/IV 是否来自密码学安全的随机源（`rand::rngs::OsRng`）？
- [ ] Nonce 复用是否被绝对避免？
- [ ] 密钥材料使用后是否清零（`zeroize` / `secrecy` crate）？
- [ ] AEAD 模式是否正确使用（加密后验证，先验证再解密）？

### 网络
- [ ] UDP 包大小是否在 MTU 限制内（标准MTU 1500，减去协议头后约1400字节）？
- [ ] TCP 读写是否正确处理部分读/写（`read_exact` / `write_all`）？
- [ ] 连接超时和重试策略是否合理？

### 错误处理
- [ ] 是否滥用 `.unwrap()` / `.expect()`？关键路径应使用 `?` 或 `match`
- [ ] 错误类型是否提供了足够的上下文（`anyhow::Context` / `thiserror`）？
- [ ] `panic!` 是否仅用于不可恢复的场景？

### 依赖管理
- [ ] `Cargo.toml` 中是否有未使用的依赖（`cargo udeps`）？
- [ ] 依赖版本是否过时或有已知漏洞（`cargo audit`）？
- [ ] 特性标记（features）是否最小化开启？

### 性能
- [ ] 是否有不必要的 `.clone()` 调用？
- [ ] 大对象传递是否使用引用而非所有权转移？
- [ ] `Vec` 预分配是否合理（`Vec::with_capacity`）？
- [ ] 异步IO是否有不必要的阻塞（在async上下文中使用 `std::thread::sleep` 等）？

---

## Flutter / Dart 专项清单

### UI 架构
- [ ] Widget 树层级是否合理，有无过度嵌套？
- [ ] `setState` 调用范围是否最小化（局部刷新优于全页刷新）？
- [ ] `ListView.builder` / `GridView.builder` 是否正确使用（懒加载）？
- [ ] `const` 构造函数是否尽可能使用（减少重建）？

### 状态管理
- [ ] 状态管理方案是否统一（Provider / Riverpod / Bloc 选一，不混用）？
- [ ] 跨页面状态是否正确共享和同步？
- [ ] `dispose` 是否正确释放资源（Controller、Listener、Stream）？

### 性能
- [ ] `build()` 方法是否轻量（无不必要的计算或对象创建）？
- [ ] 列表项是否有稳定的 `Key`（避免重建）？
- [ ] 图片是否有合理的缓存策略（`cached_network_image`）？
- [ ] 是否有不必要的 `Opacity` / `Clip` 等昂贵操作？

### 平台兼容
- [ ] Android/iOS 差异化功能是否有平台判断？
- [ ] 权限请求是否正确（`permission_handler`）？
- [ ] 不同屏幕尺寸的适配是否合理？

### 包管理
- [ ] `pubspec.yaml` 依赖版本是否固定（避免 `^` 导致意外升级）？
- [ ] `analysis_options.yaml` 是否启用了足够的 lint 规则？
- [ ] 是否有未使用的依赖（`dart pub outdated`）？

### 安全
- [ ] 敏感数据是否使用 `flutter_secure_storage` 而非 `SharedPreferences`？
- [ ] 本地数据库是否有加密？
- [ ] 网络请求是否强制 HTTPS？

---

## Python 专项清单

### 类型安全
- [ ] 函数签名是否有类型注解（参数和返回值）？
- [ ] 复杂类型是否使用 `TypedDict` / `dataclass` / `NamedTuple` 描述？
- [ ] 可选值是否使用 `Optional[T]` 而非返回 `None` 不标注？

### 错误处理
- [ ] 是否使用了裸 `except:`（应指定具体异常类型）？
- [ ] 异常信息是否包含足够的上下文？
- [ ] 资源管理是否使用 `with` 语句（文件、连接）？
- [ ] 关键路径是否有适当的重试和超时？

### Flask 相关（如适用）
- [ ] 路由是否有输入校验（request.args / request.json）？
- [ ] SQL 查询是否使用参数化（防注入）？
- [ ] CORS 配置是否合理（不应用 `*` 通配符）？
- [ ] 敏感接口是否有认证/鉴权检查？
- [ ] 错误响应是否不泄露内部信息（stack trace）？

### 性能
- [ ] 循环中是否有可提取的不变计算？
- [ ] 大文件处理是否使用流式而非一次性加载？
- [ ] 字典/列表推导是否合理使用（不滥用多层嵌套）？

### 依赖管理
- [ ] `requirements.txt` 是否固定了版本（`package==1.2.3`）？
- [ ] 虚拟环境是否隔离（不污染系统 Python）？
- [ ] 是否有不必要的重量级依赖？

### 安全
- [ ] 密码/密钥是否从环境变量读取而非硬编码？
- [ ] `subprocess` 调用是否使用列表参数（防止 shell 注入）？
- [ ] `pickle` 是否避免用于不可信数据？
- [ ] `eval()` / `exec()` 是否完全避免？

---

## Node.js / TypeScript 专项清单

### 类型安全
- [ ] 是否避免使用 `any`（除非有充分理由并加注释说明）？
- [ ] 是否存在类型断言过度使用（`as` / `!`）绕过类型检查？
- [ ] API 边界是否有明确的类型定义和校验（运行时 + 编译时）？

### 异步
- [ ] Promise 是否正确处理 rejection（无 unhandled rejection）？
- [ ] 是否有混用 `async/await` 和 `.then()` 的风格不一致？
- [ ] 循环中的异步操作是否使用 `Promise.all` 并行化？
- [ ] `setTimeout` / `setInterval` 是否在组件销毁时清理？

### 安全
- [ ] 用户输入是否经过校验（不要只依赖前端校验）？
- [ ] 文件路径操作是否防止路径穿越（path traversal）？
- [ ] JWT / Token 是否有过期时间和刷新机制？
- [ ] 敏感信息是否从日志中过滤？

### 资源管理
- [ ] 文件句柄、数据库连接、网络连接是否正确关闭？
- [ ] 事件监听器是否在不再需要时 `removeListener`？
- [ ] 内存泄漏风险（闭包持有大对象引用、定时器未清理）？

### Chrome 扩展 MV3（如适用）
- [ ] 是否最小化权限声明（permissions 列表）？
- [ ] Content Script 和 Background Service Worker 通信是否安全？
- [ ] `eval()` 和远程脚本是否被 CSP 阻止？
- [ ] 跨域请求是否有合理的来源验证？

---

## React / TypeScript 专项清单

### 组件设计
- [ ] 组件职责是否单一，UI渲染与业务逻辑是否分离？
- [ ] Props 类型是否有完整的 TypeScript 定义？
- [ ] 是否有过于庞大的组件（>200行）需要拆分？
- [ ] 条件渲染是否覆盖所有状态（loading、empty、error、edge cases）？

### Hooks
- [ ] `useEffect` 依赖数组是否正确（无遗漏，无多余）？
- [ ] `useCallback` / `useMemo` 是否合理使用（不过度优化，不遗漏关键缓存）？
- [ ] 自定义 Hook 是否正确处理 cleanup？
- [ ] `useRef` 的使用是否正确（不变值 vs DOM引用）？

### 性能
- [ ] 列表项是否有稳定的 `key` 属性？
- [ ] 高频事件（scroll/resize/input）是否节流/防抖？
- [ ] 大组件是否使用 `React.memo` 或 `lazy` 懒加载？
- [ ] 是否存在不必要的重渲染（props 引用不稳定）？

### Tailwind CSS（如适用）
- [ ] 是否有过长的 class 字符串需要提取为组件？
- [ ] 响应式断点是否覆盖移动端 → 桌面端？
- [ ] 自定义主题值是否在 `tailwind.config` 中统一管理？

### 状态管理
- [ ] 全局状态和局部状态的边界是否清晰？
- [ ] API 请求状态（loading/error/data）是否完整覆盖？
- [ ] 是否避免了 props drilling（适度使用 Context 或状态库）？

---

*使用方式：审查时复制对应清单到PR评论中，勾选检查项，标注未通过的条目。*
