# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

---

## [0.2.0] — 2026-11-01

Embedding switch, graph candidate expansion, and an independent held-out set.
This release also fixes a parameter drift between the gate and the live plugin.

### Added

- **Candidate expansion** (`MEMCTX_EXPAND`, default `2`): after `/api/search` returns 30 candidates, the plugin walks the neighbor table 1–2 hops from the top-5 and pulls the missing memories from the local shard (read-only). They are scored with **local BM25**, because query vectors cannot be reconstructed from stored passage vectors.
- **Relative edge pruning** in `graph.mjs`: `--ratio` (default `0.99`) keeps only neighbors close to each node's strongest edge. e5 cosine is compressed (min 0.84 on a 50-memory store), so absolute thresholds alone no longer discriminate.
- **PPR graph mode** (`MEMCTX_GRAPHMODE=ppr`, default `max`): Personalized PageRank with damping 0.85, kept for re-testing on sparser graphs. Measured **negative** on the current near-complete graph (blind recall 9 → 1), so it ships off.
- **MMR diversification** (`MEMCTX_DEDUP`, default `1` = off): content 2-gram Jaccard MMR. Measured negative on both dev sets, kept behind a flag.
- **`heldout-check.mjs`** (`npm run heldout:check`): validates an evaluation set — exact-once substring match against active memories, no soft-deleted / superseded targets, no duplicate targets or questions, layer histogram — and can merge parts with auto-filled `targetId`.
- **`fixtures/heldout-2026-11.json`**: 33-case held-out set (fact / why / supersede / paraphrase / multi-hop / english), authored by three independent subagents from a memory dump. Single-use, reserved for release; SHA-256 recorded in `NOTES.md` §12.6.
- **Migration guard** in `switch-embedding.mjs`: counts active/soft-deleted rows per shard before and after `/api/migration/run`, aborts with exit code 2 when soft-deleted rows come back, and `--restore-deleted` restores them from the `*.pre-reembed-*.bak` snapshot. `--verify-only` prints shard counts.

### Changed

- **Ranking is now one implementation** (`lib/score.mjs`), shared by `index.ts` and `eval.mjs`. Previously each had its own copy; the gate quietly measured λ = 1 while the plugin ran λ = 0.5.
- **`GRAPH_LAMBDA` default raised 0.5 → 1.0.** Re-measured at 51 memories: λ = 0.5 scored 7/15 on the blind set (below the floor), 0.75 and 1.0 scored 9/15; 1.0 also had the best average rank.
- **`graph.mjs` defaults** now `--min 0.90 --hub-t 0.92 --ratio 0.99`, calibrated to the e5 similarity distribution.
- Graph scoring moved out of `index.ts` `rank()` into `lib/score.mjs`; `retrieve()` is now the single search entry point for stable block, tail, re-anchor and compaction.
- `package.json` `files` now ships `lib/` and `heldout-check.mjs`.

### Fixed

- **Upstream `deleted_at` loss during re-embed**: opencode-mem 2.39.0 rebuilds shards without selecting `deleted_at`, silently resurrecting every soft-deleted memory (613 rows across 3 shards in our run). The plugin can't prevent it, but the migration helper now detects, reports and can restore it.
- **Gate/plugin parameter drift**: gate numbers were measured with eval's own defaults; they now come from the same defaults as the live plugin.
- `gate.mjs` now also prints **recall@8** (the stable block uses 8 slots) and **per-layer recall** when the case file carries a `layer` field.

### Measured (51–52 memories, multilingual-e5-small)

| Config | Dev 14 | Blind 15 |
|---|---|---|
| no expansion | 9; 11.64 | 9; 10.33 |
| 1-hop + BM25 | 10; 9.71 | 8; 10.93 |
| **2-hop + BM25 (default)** | **11; 2.93** | **9; 4.53** |

- PPR and MMR remain off; see `NOTES.md` §12 for the full A/B tables.
- Held-out evaluation (executed 2026-11-01): **46/60 vs 32/60** on a second, independent 60-case set (coverage 50 memories), recall@3 **76.7% vs 53.3%**, average rank **10.67 vs 21.32**, McNemar **p ≈ 0.0013**. The first 33-case set scored 17/33 vs 12/33 (p = 0.18). Both sets are now burned; the next release needs a new one.

### Known limitations

- Expansion adds memories that have no query-vector score; BM25 is a lexical proxy and can be weak on pure paraphrase.
- The graph is near-complete on a ~50-memory e5 store; multi-hop gains are bounded until the store grows and edges become discriminative.
- `switch-embedding.mjs` restores soft-deleted rows through the API, not by rewriting the shard.

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

[0.1.0]: https://github.com/MincHoo/memctx/releases/tag/v0.1.0
