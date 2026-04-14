const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;

const wrap = (code: number, s: string) => useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
const dim   = (s: string) => wrap(2, s);
const red   = (s: string) => wrap(31, s);
const green = (s: string) => wrap(32, s);
const yellow= (s: string) => wrap(33, s);
const cyan  = (s: string) => wrap(36, s);

function ts() {
  return new Date().toISOString().slice(11, 19);
}

export const log = {
  info:  (msg: string) => console.error(`${dim(ts())} ${cyan('info')}  ${msg}`),
  warn:  (msg: string) => console.error(`${dim(ts())} ${yellow('warn')}  ${msg}`),
  error: (msg: string) => console.error(`${dim(ts())} ${red('error')} ${msg}`),
  ok:    (msg: string) => console.error(`${dim(ts())} ${green('ok')}    ${msg}`),
  todo:  (mod: string) => console.log(`[TODO] ${mod} not yet implemented`),
};

export function jsonOut(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
