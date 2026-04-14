/**
 * hello CLI — 自举 demo
 * 用法：tsx examples/hello-world/cli.ts [name]
 */

export function greet(name: string = 'world'): string {
  return `hello, ${name}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const name = process.argv[2];
  console.log(greet(name));
}
