# Hello World — Plan

## 技术方案

- 单文件 TypeScript：`examples/hello-world/cli.ts`
- 接受 `argv[2]` 作为名字，默认 `world`
- 输出格式：`hello, <name>`

## 影响面

- 仅新增 `examples/hello-world/`，不动现有模块
- 用现有 vitest 配置即可
