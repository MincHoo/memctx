# v0.1.0 — fresh memories without breaking the prompt cache

**opencode-memctx** is a companion plugin for [`opencode-mem`](https://github.com/tickernelz/opencode-mem). It takes over context injection so that every turn gets relevant memories **and** the system prefix stays byte-identical.

## Why

`opencode-mem` forces a choice: inject the newest memories (stable prefix, stale answers) or re-run vector search into the system prompt every turn (fresh, but the prefix changes and the entire transcript is re-billed).

This plugin splits it:

- **Stable block** — built once from the session's first message, cached per session, never changes → prefix cache intact.
- **Per-turn tail** — a small block appended to the *user message*, so only the new message differs.
- **Ranking** — content / tags / keywords / graph, with decay and a damped graph term.
- **Re-anchor, compaction snapshot, project-scoped recall** — the small things that decide whether it is usable day to day.

## What you get

```
plugins: ["opencode-mem@latest", "/path/to/opencode-memctx"]
```

plus `chatMessage.enabled: false` upstream. Nothing is written to the upstream database.

## Verify before trusting

```bash
npm test                                    # fixture corpus, no real data needed
node doctor.mjs --dir /path/to/your/project  # why is nothing happening?
node gate.mjs --dir /path/to/your/project    # recall / rank regression gate
```

Measured on a real store (14 questions): recall@3 **10/14 → 12/14**, average rank **3.8 → 2.1** against raw vector ordering. Cache hit stays at 95–99% in normal turns.

## Caveats

- `/api/search` is a private upstream contract — pin the `opencode-mem` version.
- Graph rerank is 1-hop; the neighbor table is built manually with `node graph.mjs`.
- Lifecycle is partial: decay and pin work, expiry and pruning do not.
- Requires OpenCode ≥ 2.2.5, `opencode-mem` 2.39.x, Node ≥ 22.5.

## Thanks

Built on top of `opencode-mem` by [tickernelz](https://github.com/tickernelz) (MIT). This is an independent companion, not a fork.
