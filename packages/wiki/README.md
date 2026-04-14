# @vcp/wiki

spec-kit 兼容的 wiki 增量编译库。

## 用途

读取 `.specify/features/<slug>/{spec,plan,tasks}.md`，生成或更新 `.wiki/topics/<slug>.md`，
并追加一行到 `.wiki/log.md`。不调用 LLM，纯本地文件操作，支持幂等重跑。

## 外部依赖：spec-kit（Python CLI）

本仓库只产出与 spec-kit 兼容的目录格式，**不内嵌** spec-kit。
安装方式：

```bash
pipx install spec-kit
```

安装后可用 `spec-kit specify`、`spec-kit plan`、`spec-kit tasks` 等命令生成 `.specify/features/<slug>/` 下的文件。

## API

```ts
import { compileFeature } from '@vcp/wiki';

await compileFeature('hello-world', {
  repoRoot: '/path/to/repo',
  fromGit: false,
});
```

## CLI

```bash
pnpm run wiki:compile hello-world
pnpm run wiki:compile hello-world --from-git
pnpm run wiki:compile --help
```
