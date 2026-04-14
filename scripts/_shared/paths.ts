import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '..', '..');

export const SPECIFY_DIR  = resolve(REPO_ROOT, '.specify');
export const FEATURES_DIR = resolve(SPECIFY_DIR, 'features');
export const WIKI_DIR     = resolve(REPO_ROOT, '.wiki');
export const WIKI_INDEX   = resolve(WIKI_DIR, 'index.md');
export const WIKI_LOG     = resolve(WIKI_DIR, 'log.md');
export const WIKI_TOPICS  = resolve(WIKI_DIR, 'topics');

export const MEMORY_DIR   = resolve(REPO_ROOT, '.memory');
export const MEMORY_DB    = resolve(MEMORY_DIR, 'memory.db');
export const MEMORY_RAW   = resolve(MEMORY_DIR, 'raw');

export const VECTORS_DIR  = resolve(REPO_ROOT, '.vectors');
export const VECTORS_DB   = resolve(VECTORS_DIR, 'index.sqlite');

export const SANDBOX_DIR  = resolve(REPO_ROOT, '.sandbox');
export const BWRAP_PROFILE = resolve(SANDBOX_DIR, 'bwrap.profile');

export const TESTS_DIR    = resolve(REPO_ROOT, 'tests');

export const CLAUDE_PROJECTS_DIR =
  process.env.CLAUDE_PROJECTS_DIR ||
  resolve(process.env.HOME || '/root', '.claude', 'projects');
