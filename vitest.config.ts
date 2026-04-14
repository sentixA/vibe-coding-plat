/**
 * vitest.config.ts — 根级测试配置
 *
 * 主要作用：配置路径别名，使 @vcp/* 能被 vitest 解析为本地 workspace 包。
 * 与 tsconfig.json 中的 paths 保持一致。
 */

import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      // 对应 tsconfig.json: "@vcp/*": ["packages/*/src"]
      // vitest 别名不支持通配符，需要逐一列出各子包
      '@vcp/memory':  resolve(__dirname, 'packages/memory/src/index.ts'),
      '@vcp/vectors': resolve(__dirname, 'packages/vectors/src/index.ts'),
      '@vcp/wiki':    resolve(__dirname, 'packages/wiki/src/index.ts'),
      '@vcp/chaos':   resolve(__dirname, 'packages/chaos/src/index.ts'),
      '@vcp/sandbox': resolve(__dirname, 'packages/sandbox/src/index.ts'),
      '@vcp/git':     resolve(__dirname, 'packages/git/src/index.ts'),
      '@vcp/context': resolve(__dirname, 'packages/context/src/index.ts'),
      // 对应 tsconfig.json: "#shared/*": ["scripts/_shared/*"]
      '#shared/paths': resolve(__dirname, 'scripts/_shared/paths.ts'),
      '#shared/db':    resolve(__dirname, 'scripts/_shared/db.ts'),
      '#shared/log':   resolve(__dirname, 'scripts/_shared/log.ts'),
    },
  },
  test: {
    environment: 'node',
    // commitlint / git / native addon 冷启动较慢；统一放宽默认超时
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // better-sqlite3 是 native addon，vite/vitest 无法 bundle，必须声明为 external
    // vitest 2.x 用 server.deps.external，vitest 1.x 用 deps.external
    server: {
      deps: {
        external: ['better-sqlite3', /\.node$/],
      },
    },
  },
});
