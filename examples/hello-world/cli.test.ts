import { describe, it, expect } from 'vitest';
import { greet } from './cli.js';

describe('hello-world greet', () => {
  it('默认问候', () => {
    expect(greet()).toBe('hello, world');
  });

  it('自定义名字', () => {
    expect(greet('vcp')).toBe('hello, vcp');
  });
});
