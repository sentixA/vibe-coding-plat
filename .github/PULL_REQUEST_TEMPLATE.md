## 概述

<!-- 简要描述本 PR 的目的和改动内容（1-3 句话） -->

## 关联 spec

<!-- 关联的 spec slug 或 issue 编号，例：.specify/features/<slug>/ -->

- spec: <!-- .specify/features/<slug>/spec.md -->
- plan: <!-- .specify/features/<slug>/plan.md -->

## 测试结果

<!-- 粘贴 pnpm run verify 输出（单元测试 / chaos / mutation 分数） -->

```
pnpm run verify 输出：
```

## Breaking changes

<!-- 有则描述，无则填"无" -->

- [ ] 无 breaking change
- [ ] 有（见下方详细说明）

<!-- 如有 breaking change，在此说明受影响的接口及迁移方式 -->

## Checklist

- [ ] `pnpm run verify` 全绿（unit + chaos smoke 通过，mutation 分数 ≥ 阈值）
- [ ] conventional commit 格式（commitlint 通过）
- [ ] 只改了本模块独占目录，未跨模块修改源文件
- [ ] 新增逻辑有对应单元测试（`tests/unit/<module>.test.ts`）
- [ ] 涉及 IO / 外部进程的逻辑有对应混沌用例（`tests/chaos/`）
- [ ] 无硬编码路径（路径常量从 `scripts/_shared/paths.ts` 导入）
- [ ] 中文注释，中文提交消息
