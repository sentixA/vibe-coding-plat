# CLAUDE.md — Claude Code 接入指引

本文是给 Claude Code 看的工作流剧本。先读 `AGENTS.md`，再按本文操作。

## 1. 工作流总览

每个 feature 走完整 SDD 链路：

1. `/speckit.specify "<需求>"` → 产出 `.specify/features/<slug>/spec.md`
2. `/speckit.plan` → 产出 `plan.md`
3. `/speckit.tasks` → 产出 `tasks.md`
4. `pnpm run approve plan <slug>` ← 人工 checkpoint，回车 y/n
5. `/speckit.implement` → 在沙箱内写代码
6. 自动 post hook 触发：
   - `pnpm run index --incremental` 增量更新代码向量
   - `pnpm run wiki:compile <slug>` 增量更新 wiki
   - `pnpm run memory:ingest` 收 session jsonl
   - `pnpm run verify` 跑 unit + chaos + mutation
7. `pnpm run approve commit` ← 第二个 checkpoint，通过后 conventional commit

## 2. 常用脚本

| 命令 | 用途 |
|---|---|
| `pnpm run bootstrap` | 全新 clone 后一键初始化（建目录、初始化 SQLite） |
| `pnpm run memory <sub>` | 查询会话历史（list / show / search / replay） |
| `pnpm run search "<keyword>"` | 代码向量 / 关键词检索 |
| `pnpm run context <subcommand>` | 注入运行时上下文（db-schema / env / api / recent-logs） |
| `pnpm run sandbox -- <cmd>` | 在 bubblewrap 沙箱里跑命令 |
| `pnpm run approve <plan\|diff\|commit>` | 人机审批 checkpoint |
| `pnpm run verify` | 一键 unit + chaos + mutation 闸门 |

## 3. Hook 配置

`.claude/settings.json` 配置了：

- **PreToolUse(Bash)**：除白名单外的命令自动跳沙箱。
- **PostToolUse(Edit|Write)**：标记当前 feature 待 wiki 编译。
- **Stop**：session 结束时 `pnpm run memory:ingest` 收割 jsonl。

## 4. 数据落盘位置

| 数据 | 路径 |
|---|---|
| Spec/Plan/Tasks | `.specify/features/<slug>/` |
| Wiki | `.wiki/index.md`, `.wiki/log.md`, `.wiki/topics/*.md` |
| 会话历史 | `.memory/memory.db`（SQLite） |
| 代码向量 | `.vectors/index.sqlite`（sqlite-vss） |
| 沙箱 profile | `.sandbox/bwrap.profile`, `.sandbox/Dockerfile.dev` |

## 5. 重要约束

- 全程使用中文回复，结尾"喵"。
- 修改前先读懂调用链；动手前先列五件事（数据结构、特殊分支、复杂度、破坏面、收益）。
- 任何写盘操作通过 `pnpm run sandbox`；危险命令必走 `approve`。
