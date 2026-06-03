# 快速审查检查单

> 审查时打印或保持此清单在侧，逐项检查后勾选。与 `PER_STACK_CHECKLISTS.md` 配合使用。

---

## 检查单（审查时逐项确认）

### 第一轮：安全扫描（2分钟）

- [ ] 无硬编码密钥/密码/Token
- [ ] 用户输入有校验和净化
- [ ] SQL/命令/路径由参数化或安全API构造
- [ ] 认证/鉴权覆盖所有需要保护的接口
- [ ] 加密操作使用了正确的算法和参数

### 第二轮：正确性（5分钟）

- [ ] 核心逻辑与需求一致
- [ ] 边界条件已处理（空、零、极限、NULL）
- [ ] 错误路径有处理（不是吞异常或panic）
- [ ] 并发无竞态（lock、channel、atomic正确使用）
- [ ] 类型转换安全（溢出、精度丢失检查）

### 第三轮：可维护性（3分钟）

- [ ] 命名清晰表意
- [ ] 函数职责单一
- [ ] 无明显的重复代码
- [ ] 复杂逻辑有注释
- [ ] 魔法数字已替换为命名常量

### 第四轮：性能（2分钟）

- [ ] 无循环内的重复IO或查询
- [ ] 无大对象的无意义拷贝
- [ ] 资源正确释放
- [ ] 无明显的阻塞热点

### 第五轮：测试（2分钟）

- [ ] 关键路径有测试
- [ ] 边界情况有测试
- [ ] 测试可独立运行
- [ ] CI流水线已通过

---

## 常见 Bug 速查表

| Bug类型 | Rust | Flutter | Python | TS/React | 
|---------|------|---------|--------|----------|
| **空指针/null** | `unwrap()` 崩溃 | `!` 强制解包 | 返回None未处理 | 可选链缺失 |
| **资源泄漏** | 未drop | Controller未dispose | 文件未close | 定时器/事件未清理 |
| **并发问题** | Mutex死锁 | setState顺序 | GIL之外无锁 | 状态竞态 |
| **注入** | 命令拼接 | eval使用 | SQL拼接/f-string | innerHTML/DOM |
| **敏感信息** | 日志打印密钥 | SharedPrefs存密码 | hardcode密码 | .env泄露到前端 |
| **边界** | 整数溢出(safe外) | 除零未处理 | 索引越界 | 数组越界 |
| **类型** | transmute滥用 | dynamic滥用 | Any/无注解 | any/类型断言 |

---

## 快速参考：各语言关键检查命令

```bash
# Rust
cargo clippy -- -D warnings
cargo fmt -- --check
cargo test
cargo audit

# Flutter/Dart
dart analyze
dart format --output=none --set-exit-if-changed .
flutter test

# Python
ruff check .
ruff format --check .
mypy src/
python -m pytest

# Node.js/TypeScript
npx eslint src/
npx tsc --noEmit
npx prettier --check src/
npm test

# React 额外
npx tsc --noEmit
npm run build  # 验证生产构建
```
