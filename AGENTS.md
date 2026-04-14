# AGENTS.md — vibe-coding-plat 项目特化约定

本文继承 `~/.claude/CLAUDE.md` 的全局规则，仅记录本仓库特有约定。冲突时以本文为准。

## 1. 仓库定位

本仓库是 **Claude Code 的 vibe coding 工作流脚手架**，不是产品。所有改动应遵循"工具链最小可用"的尺度，避免引入大型框架或运行时基础设施。

## 2. 目录边界（模块独占）

每个模块只允许写自己独占的目录，禁止跨模块改动源文件。跨模块协作走 `scripts/_shared/*` 共享层 + workspace package import。

| 模块 | 独占目录 |
|---|---|
| 共享 | `scripts/_shared/`, 根 manifest（仅 M1 初始化时） |
| 记忆 | `scripts/memory*.ts`, `packages/memory/`, `tests/unit/memory.test.ts` |
| 向量 | `scripts/index.ts`, `scripts/search.ts`, `packages/vectors/`, `tests/unit/vectors.test.ts` |
| Spec+Wiki | `scripts/wiki-compile.ts`, `packages/wiki/`, `.specify/`, `.wiki/` |
| 测试闸门 | `scripts/verify.ts`, `tests/chaos/`, `tests/mutation/`, `packages/chaos/`, `commitlint.config.cjs` |
| 沙箱+审批 | `scripts/sandbox-run.ts`, `scripts/approve.ts`, `.sandbox/`, `packages/sandbox/` |
| Git | `.githooks/`, `.github/PULL_REQUEST_TEMPLATE.md`, `packages/git/` |
| 上下文 | `scripts/context.ts`, `packages/context/`, `tests/unit/context.test.ts` |

## 3. 共享约束

- 共享路径常量统一从 `#shared/paths` 导入，禁止硬编码路径。
- SQLite 句柄统一从 `#shared/db` 取，禁止各模块自己 `new Database()`。
- 所有 CLI 用 `cac`，`--json` 输出 JSON，缺省输出彩色文本。
- 根 `package.json` 的 `scripts` 字段在 M1 一次性占位写满；后续模块只能修改自己那一行的实现，不动其它行。
- 跨模块依赖通过 workspace 包 `@vcp/<module>` 引入。

## 4. 测试纪律

- 任何模块新增逻辑必须有单元测试，置于 `tests/unit/<module>.test.ts`。
- 涉及 IO / 外部进程的逻辑必须有混沌用例（`tests/chaos/`）。
- 修复 bug 必须先有失败用例。

## 5. 提交纪律

- 全程 conventional commits（由 `commitlint` + git hook 强制）。
- 每个模块独立分支独立 PR；不跨模块捆绑。
- 提交前必须 `pnpm run verify` 全绿。
