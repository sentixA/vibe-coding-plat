# vibe-coding-plat

给 [Claude Code](https://claude.com/claude-code) 用的 vibe coding 工作流脚手架。把 SDD 文档管理、混沌测试、代码向量检索、会话历史归档、沙箱执行、人机审批 checkpoint 拼成一个最小可用的脚手架，让 agent 能稳定按节奏产代码。

不是产品，是脚手架 + 工作流约定。

## 能力一览

| 模块 | 用途 | 入口 |
|---|---|---|
| spec-kit + wiki | SDD 文档自动管理 + 跨 feature 知识层（karpathy llm-wiki 风格增量编译） | `pnpm run wiki:compile <slug>` |
| 测试闸门 | vitest 单元 + 自研 latency-proxy 混沌 + 5 类 mutation 算子 | `pnpm run verify [--quick]` |
| 代码向量检索 | `@xenova/transformers` 本地 embedding + 内存余弦 + FTS5 关键词 + 混合排序 | `pnpm run index` / `pnpm run search "<q>"` |
| 会话历史归档 | 把 `~/.claude/projects/*.jsonl` 落到 SQLite，FTS5 / 向量跨 session 检索 | `pnpm run memory <list\|show\|search\|replay>` |
| 沙箱执行 | bubblewrap → Docker → dry-run 三档自动降级 | `pnpm run sandbox -- <cmd>` |
| 审批 checkpoint | 彩色 diff + stdin y/n + rollback | `pnpm run approve <plan\|diff\|commit>` |
| Git 集成 | `core.hooksPath` + commitlint 强制 conventional commits + PR 模板 | hook 自动触发 |
| 上下文注入 | DB schema / env / API / 最近 sessions 直出 markdown | `pnpm run context <subcommand>` |

## 技术栈

- Node.js ≥ 20、pnpm workspaces、TypeScript via tsx
- SQLite（`better-sqlite3`）+ FTS5；向量层用 `sqlite-vss`，未装则降级为内存余弦
- vitest（单元 + workspace 包测试）
- 自研 latency TCP proxy（无外部 toxiproxy daemon 依赖）
- 自研 mutation runner（5 类算子，无 Stryker 依赖）
- bubblewrap（Linux 沙箱）/ Docker fallback / dry-run

## 快速开始

```bash
git clone https://github.com/sentixA/vibe-coding-plat
cd vibe-coding-plat
pnpm install                # 装依赖 + 自动注册 git hooks (prepare)
pnpm run bootstrap          # 建 .memory/.vectors SQLite + 写 wiki/specify 骨架
pnpm run verify --quick     # 78 单测 + 1 chaos scenario，全绿即环境就绪
```

可选：`pipx install spec-kit` 装上游 spec-kit CLI，享 `/speckit.specify` 等 slash 命令；不装也能手写 `.specify/features/<slug>/{spec,plan,tasks}.md` 走通流程。

## 一个 feature 的完整链路

```bash
# 1. 立 spec（手写或 /speckit.specify）
mkdir -p .specify/features/foo
$EDITOR .specify/features/foo/{spec,plan,tasks}.md

# 2. 第一个审批 checkpoint
pnpm run approve plan foo

# 3. 实施（agent 在沙箱里写代码）
pnpm run sandbox -- pnpm exec tsx scripts/your-impl.ts

# 4. Post-implement 收尾
pnpm run index --incremental    # 增量更新代码向量
pnpm run wiki:compile foo       # spec/plan + diff 增量入 .wiki/
pnpm run memory:ingest          # 收割 jsonl 入会话库
pnpm run verify --quick         # 单元 + chaos 闸门

# 5. 第二个审批 checkpoint + 提交
pnpm run approve commit         # 看 diff + 输入 commit msg + y/n
# commit-msg hook 强制 conventional commits
```

## 日常查询（agent 高频用）

```bash
pnpm run search "<keyword>" --mode hybrid    # 代码向量 + FTS5 混合排序
pnpm run memory search "<keyword>"           # 跨 session 全文检索
pnpm run memory show <session-id>            # 还原某次完整对话
pnpm run context db-schema                   # SQLite schema → markdown
pnpm run context recent-logs --n 10          # 最近 10 个 session 摘要
pnpm run context env --vars MY_VAR           # 白名单 env，敏感字段自动脱敏
```

所有 CLI 都支持 `--json`，方便脚本组合。

## 仓库结构

```
.specify/                   spec-kit 产物（constitution + features/<slug>/{spec,plan,tasks}.md）
.wiki/                      llm-wiki：index.md / log.md / topics/<slug>.md
.memory/memory.db           sessions / messages / tool_calls + FTS5
.vectors/index.sqlite       chunks_dense + chunk_meta（vss 装上则切到虚表）
.sandbox/                   bwrap.profile + Dockerfile.dev
.githooks/                  commit-msg + pre-commit
scripts/                    所有 CLI 入口（tsx 直跑）
scripts/_shared/            paths / db / log 共享层（禁止各模块自建 DB 句柄）
packages/                   workspace 子包：@vcp/{memory,vectors,wiki,chaos,sandbox,git,context}
tests/{unit,chaos,mutation} 测试三层
examples/hello-world/       自举 demo（spec/plan/tasks + cli + test）
```

## 模块独占边界

每个模块只允许写自己独占的目录，跨模块协作只走 `scripts/_shared/*` 或 `@vcp/<x>` workspace 包。详见 [`AGENTS.md`](./AGENTS.md)。

## 代理工作流细节

详见 [`CLAUDE.md`](./CLAUDE.md)：slash 命令清单、`.claude/settings.json` hook、剧本顺序。

## 已知降级 / 二期

- `sqlite-vss` 在 Docker / 受限环境下编译困难，向量层自动降级为内存余弦（功能完整，规模 < 10w 块即可）。
- bubblewrap 仅 Linux；其他系统走 Docker 或 dry-run。
- M6 沙箱 / 审批模块缺单元测试（落盘代码 + dry-run smoke 已通过，二期补）。
- spec-kit 是外部 Python CLI，本仓库只兼容它的目录格式，不内置安装。
- 二期计划：成本 / token 观测、多模型路由、MCP registry、prompt injection 防护、subagent 编排、行为 trace。

## 设计参考

- [github/spec-kit](https://github.com/github/spec-kit)
- [karpathy/llm-wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
- [Anthropic — Claude Code sandboxing](https://www.anthropic.com/engineering/claude-code-sandboxing)

## License

MIT
