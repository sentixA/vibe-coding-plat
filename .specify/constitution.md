# 项目宪章 — vibe-coding-plat

> 本文件由 M4 初始化，可由 `/speckit.constitution` 覆盖更新。

## 定位

本仓库是给 **Claude Code** 使用的 vibe coding 工作流脚手架，不是产品。
目标：让 agent 按 SDD 节奏稳定产出可验证、可回滚的代码。

---

## 工程纪律（5-8 条）

### 1. 模块边界硬隔离
每个模块只允许写自己独占的目录/文件。跨模块协作统一走 `scripts/_shared/*` 共享层，
或通过 workspace package（`@vcp/<module>`）导入，禁止直接改对方源文件。

### 2. 共享路径常量集中管理
所有文件路径从 `scripts/_shared/paths.ts` 导入，禁止在任何模块内硬编码路径字符串。

### 3. 最小依赖原则
引入新 npm 包前必须评估：是否有内置替代、包大小影响、维护活跃度。
禁止为简单功能引入大型框架（如 handlebars、ejs、lodash 全量包）。

### 4. 幂等操作优先
任何写盘操作（wiki 更新、内存记录、向量索引）必须支持幂等重跑，不产生重复数据。
用 `slug + content_hash` 判重，相同内容第二次跑必须是空操作（no-op）。

### 5. 测试先行，逐层验证
新功能先写单元测试，单步通过后才接入集成链路。
涉及 IO / 外部进程的逻辑，必须有对应混沌用例（`tests/chaos/`）。
测试使用临时目录隔离，不污染真实工作目录。

### 6. CLI 统一规范
所有 CLI 脚本用 `cac`，支持 `--json` 输出 JSON，缺省输出彩色文本。
子命令签名与 `scripts/` 中的占位存根保持一致，不擅自改根 `package.json`。

### 7. 提交纪律
全程 conventional commits（格式: `type(scope): subject`），由 `commitlint` 强制。
每个模块独立分支独立 PR，不跨模块捆绑提交。

### 8. 外部 CLI 依赖注明安装方式
spec-kit 等外部 Python/二进制工具不内嵌，在相关模块 README 注明
`pipx install spec-kit`（或等效方式），本仓库只产出与其兼容的目录格式。

---

## spec-kit 目录约定

```
.specify/
├── constitution.md           # 本文件
└── features/<slug>/
    ├── spec.md               # 功能规格（What & Why）
    ├── plan.md               # 实施方案（How）
    └── tasks.md              # 可勾选任务列表
```

## wiki 目录约定

```
.wiki/
├── index.md                  # 全局 TOC
├── log.md                    # 编年变更日志
└── topics/<slug>.md          # 按功能 slug 的主题页
```
