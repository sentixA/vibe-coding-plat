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
