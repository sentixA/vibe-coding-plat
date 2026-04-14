/**
 * commitlint 配置 — conventional commits 标准规则
 *
 * 注意（M7 交接）：
 *   本文件仅定义规则，不强制安装依赖。
 *   M7 安装 commit-msg hook 时，请同步在根 package.json 的 devDependencies 里加：
 *     "@commitlint/cli": "^19.x"
 *     "@commitlint/config-conventional": "^19.x"
 *   并在 package.json scripts 里加：
 *     "commitlint": "commitlint --edit"
 */

module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // type 枚举：标准 feat/fix/docs/style/refactor/perf/test/build/ci/chore/revert
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'docs',
        'style',
        'refactor',
        'perf',
        'test',
        'build',
        'ci',
        'chore',
        'revert',
      ],
    ],
    // subject 最长 100 字符
    'subject-max-length': [2, 'always', 100],
    // subject 不强制小写（中文 commit 兼容）
    'subject-case': [0],
    // header 最长 120 字符
    'header-max-length': [2, 'always', 120],
  },
};
