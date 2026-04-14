/**
 * 工具函数模块（测试 fixture）
 * 提供字符串处理、数组操作等基础工具。
 */

/** 将字符串首字母大写 */
export function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** 安全地将任意值转为字符串 */
export function toString(val: unknown): string {
  if (val === null || val === undefined) return '';
  return String(val);
}

/** 对数组去重 */
export function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

/** 将数组分块，每块 size 个元素 */
export function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

/** 计算两个字符串的 Levenshtein 编辑距离 */
export function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}
