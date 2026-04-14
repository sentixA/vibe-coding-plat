/**
 * 示例 chaos scenario：
 * 模拟一个「会被 latency 注入弄崩」的函数，并断言故障被检测到。
 *
 * 使用 fetchWithTimeout 模拟一个有超时限制的网络请求；
 * 注入 latency 500ms 但超时仅 200ms → 必然失败。
 */

import { runChaosScenario, fetchWithTimeout, type Fault } from '@vcp/chaos';

export const name = 'latency-kills-tight-timeout';

export async function run(): Promise<void> {
  // 场景：注入 500ms 延迟，但调用方只允许 200ms 超时
  const faults: Fault[] = [{ kind: 'latency', ms: 500 }];

  const result = await runChaosScenario(
    name,
    async (ctx) => {
      const delayMs = ctx.latencyMs ?? 0;
      // fetchWithTimeout(url, timeoutMs, delayMs)
      // 这里 delayMs=500 > timeoutMs=200 → 必然超时抛出
      await fetchWithTimeout('http://mock-api/data', 200, delayMs);
    },
    faults
  );

  // 断言：注入延迟后函数应当失败
  if (!result.failed) {
    throw new Error(
      `[scenario: ${name}] 期望 latency 注入导致失败，但函数成功了（可能 latency 未生效）`
    );
  }

  if (!result.error?.includes('超时')) {
    throw new Error(
      `[scenario: ${name}] 期望超时错误，实际错误：${result.error}`
    );
  }

  // scenario 通过：故障被正确检测
  console.log(
    `[scenario: ${name}] ✓ latency 注入成功导致超时，durationMs=${result.durationMs}`
  );
}
