# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

---

## [0.1.0] — 2026-11-01

First public release. Companion plugin for [`opencode-mem`](https://github.com/tickernelz/opencode-mem):
it takes over context injection so memories stay fresh **without** invalidating the prompt cache.

### Added

**Injection**
- Stable block: computed once from the session's first message, cached per session, byte-identical on every request.
- Per-turn tail: appended to the *user message* instead of the system prompt, so only the newest message differs.
- Compaction snapshot: key memories are injected into the compaction request so the summary keeps conclusions.
- Re-anchor: rebuilds the stable block when the top hit leaves it for two consecutive turns (max 3 per session).
- Filters `type=prompt` capture noise and scopes recall to the current project's container tag.

**Ranking**
- `0.5 content + 0.2 tags + 0.15 keywords + 0.15 graph`, weights renormalized over the signals actually present.
- 180-day half-life decay; pinned memories exempt.
- Graph rerank from an offline neighbor table (cosine over stored 1024-dim embeddings), damped by λ = 0.5.
- Behavioral edges: `Jaccard × 0.5^(Δt/90d)` computed from co-activation logs, merged with structural edges by max weight.

**Structured memories (sidecar)**
- `data/records.json` stores `kind / condition / source / validUntil / supersedes` per memory id.
- `data/coactivation.jsonl` records which memories were injected in the same turn.
- New tool `memctx_add(content, kind, condition, source, tags?, supersedes?)` writes through the upstream API and records the fields locally.
- Injection renders `(kind, rel)` plus `条件 / 来源`; superseded records are excluded from recall but stay queryable.

**Tooling**
- `doctor.mjs` — diagnoses "installed but nothing happens" (config, token, tag, shard, endpoint, graph, sidecar).
- `test.mjs` — self-test on an isolated fixture store (28 seeded memories, 22 cases), no real data required.
- `gate.mjs` — release gate on recall@K and average rank; exits 1 on regression.
- `graph.mjs` — builds the neighbor table and a human-reviewable report; `--db` / `--min` / `--out` supported.
- `eval.mjs` — A/B against raw vector order; `--tag`, `--cases`, `--dir`, `--json`, `--no-default`.
- `check.mjs` — neighbor quality (cross-cluster edges, isolated nodes, top edges).
- `seed.mjs` / `experiment.mjs` — isolated synthetic corpora for scale and noise experiments.
- `tokens.mjs` — per-request input / cacheRead / hit rate for a session.
- `tag.mjs` — prints the container tag and shard path for a directory.

### Measured

| Corpus | Raw vector order | This plugin |
|---|---|---|
| 15 memories | recall@3 10/14, avg rank 3.8 | recall@3 12/14, avg rank 2.1 |
| 27 memories | recall@3 9/14, avg rank 6.1 | recall@3 10/14, avg rank 2.4 |

- Cache hit rate stays at 95–99% in normal turns; a plugin reload costs one full recompute.
- Measured caveat, kept for honesty: with the *dynamic* block placed in the system prompt instead of the user message, cache hit dropped to 0% and each turn re-billed the whole transcript.

### Known limitations

- Stable block is anchored to the session's first message; re-anchoring is heuristic and costs one full recompute.
- `/api/search` is a private upstream contract — pin the version. Route changes degrade recall silently.
- The per-turn tail is persisted in the transcript (~100–200 tokens per turn).
- Graph rerank is 1-hop only, restricted to the current candidate set.
- `neighbors.json` is built manually (`node graph.mjs`), not continuously.
- Lifecycle is partial: decay and pin are implemented; supersession works through `memctx_add(supersedes)`; expiry and pruning are not.
- Writing structured memories requires `memctx_add`; entries written with the plain `memory` tool still work but render without condition/source.

### Notes

- No fork: the upstream database is opened read-only by the offline tools and never written by the plugin.
- Requires OpenCode ≥ 2.2.5 (V2 plugin API), `opencode-mem` 2.39.x with its web server enabled, Node ≥ 22.5.

[0.1.0]: https://github.com/<owner>/opencode-memctx/releases/tag/v0.1.0
