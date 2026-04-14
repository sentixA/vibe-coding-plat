# vibe-coding-plat

A workflow scaffold that lets [Claude Code](https://claude.com/claude-code) work in spec-driven mode with chaos-tested verification, vector search over code, and full session-history memory.

## Stack

- Node.js ≥ 20, pnpm workspaces, TypeScript via tsx
- SQLite (`better-sqlite3`) + `sqlite-vss` for vectors
- vitest (unit) + toxiproxy (chaos) + Stryker (mutation)
- bubblewrap (Linux sandbox) + Docker fallback
- [github/spec-kit](https://github.com/github/spec-kit) for SDD
- llm-wiki incremental knowledge layer

## Quick start

```bash
pnpm install
pnpm run bootstrap     # init dirs + SQLite schema
pnpm run verify        # placeholder gate, should print TODO during M1
```

See [`CLAUDE.md`](./CLAUDE.md) for the full agent workflow and [`AGENTS.md`](./AGENTS.md) for module ownership boundaries.

## Status

In-progress scaffold. Module ownership (M1-M9) is defined in `AGENTS.md`. M1 (this commit) freezes the interface; M2-M8 are filled in via parallel subagents.
