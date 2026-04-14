# Topic: hello-world

<!-- 由 wiki:compile 自动生成，可人工补充 -->

## History

## [2026-04-14] hello-world (hash: ff7e2a20)

### Spec

---
slug: hello-world
created: 2026-04-14
---

# Hello World — Spec

## What

提供一个 `hello` CLI，打印问候语并退出 0。

## Why

作为 vibe-coding-plat 的自举 demo，验证 spec-kit + wiki + 向量索引 + 测试闸门链路打通。

## Acceptance

- `pnpm exec tsx examples/hello-world/cli.ts world` 输出 `hello, world` 并退出 0
- 单元测试覆盖默认问候和自定义问候两条路径

### Plan

# Hello World — Plan

## 技术方案

- 单文件 TypeScript：`examples/hello-world/cli.ts`
- 接受 `argv[2]` 作为名字，默认 `world`
- 输出格式：`hello, <name>`

## 影响面

- 仅新增 `examples/hello-world/`，不动现有模块
- 用现有 vitest 配置即可

### Tasks

# Hello World — Tasks

- [x] 写 `examples/hello-world/cli.ts`
- [x] 写 `examples/hello-world/cli.test.ts`（vitest）
- [x] 跑 `pnpm run wiki:compile hello-world` 入 wiki
- [x] 跑 `pnpm run index` + `pnpm run search "hello"` 验证向量检索命中
