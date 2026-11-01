# opencode-memctx

> Better context injection for [opencode-mem](https://github.com/tickernelz/opencode-mem): **fresh memories every turn without breaking the prompt cache.**
>
> 中文说明：[README.zh-CN.md](./README.zh-CN.md) · 开发日志（中文）：[NOTES.md](./NOTES.md)

`opencode-mem` gives you two bad options: inject the newest memories (stable prefix, stale answers) or re-run vector search into the system prompt every turn (fresh, but the prefix changes and the whole transcript is re-billed). This plugin takes a third path:

- **Stable block** — computed once from the session's first message, cached per session, identical on every request → prefix cache stays intact.
- **Per-turn tail** — a small block appended to the *user message* (not the system prompt), so only the new message differs. Freshness without a re-bill.
- **Ranking** — `0.5 content + 0.2 tags + 0.15 keywords + 0.15 graph`, with a 180-day half-life decay (pinned memories exempt).
- **Graph rerank** — a sidecar neighbor table (`neighbors.json`) computed straight from stored embeddings.
- **Re-anchor** — if the top hit leaves the stable block for two consecutive turns, the block is rebuilt for the new topic (max 3 per session).
- **Compaction snapshot** — key memories are injected into the compaction request so the summary keeps the conclusions.

It does **not** fork `opencode-mem`. It reads the plugin's local REST API and writes nothing to its database.

---

## Requirements

| | |
|---|---|
| OpenCode | 2.2.5 or newer (V2 plugin API: `Plugin.define`, `session.hook`) |
| opencode-mem | 2.39.x, web server enabled on loopback (default `127.0.0.1:4747`) |
| Node | ≥ 22.5 (uses the built-in `node:sqlite` for the graph tools) |

## Install

1. Put this directory somewhere stable (it is loaded as a local plugin directory — any path works):

   ```powershell
   git clone <this repo> C:\Users\you\opencode-memctx
   ```

   > Don't drop it into `~/.config/opencode/plugins/` **and** list it in `plugins` — that directory is auto-discovered, and you would load it twice.

2. Add it to `~/.config/opencode/opencode.json` (`plugins` array, absolute path):

   ```jsonc
   {
     "plugins": [
       "opencode-mem@latest",
       "/absolute/path/to/opencode-memctx"
     ]
   }
   ```

3. Disable the upstream injection, otherwise you get two sets of memories in context:

   ```jsonc
   // ~/.config/opencode/opencode-mem.jsonc
   "chatMessage": { "enabled": false }
   ```

4. Restart OpenCode **fully** (quit the desktop app and reopen). Config changes are not picked up otherwise.

### Verify

```powershell
Get-Content "$env:USERPROFILE\.opencode-mem\spike-memctx.log" -Tail 5
```

Expected lines:

```
setup v2: api=http://127.0.0.1:4747 token=ok graph=… scope=opencode_project_…
stable session=… hash=… n=8 ids=… anchor="…"
sys session=… hash=… parts=5 bytes=…
```

If there is no new line after a turn, the plugin did not load — check the OpenCode server log for `loading plugin`.

### Nothing happens? Run the doctor

```powershell
node doctor.mjs --dir C:\path\to\your\project
```

It checks node version, plugin config, whether upstream injection is still on, the token, the resolved project tag and shard, the search endpoint, the neighbor table and the sidecar stores — and prints a one-line verdict:

```
  [ok]    web server         http://127.0.0.1:4747 status=ok
  [ok]    检索冒烟               返回 3 条
  [warn]  邻接表缺失           图分不会生效；跑 node graph.mjs 生成
=> 可用，1 项警告
```

### Rollback

Set `chatMessage.enabled` back to `true`, remove the path from `plugins`, restart. The plugin writes nothing except its own log file.

---

## Tools

All scripts are standalone (no build step):

| Command | What it does |
|---|---|
| `node probe.mjs "query"` | Hit the upstream search API directly, print hits and similarity |
| `node graph.mjs` | Rebuild the neighbor table (`data/neighbors.json`) + P1 review report |
| `node check.mjs data/neighbors.json` | Neighbor quality: top edges, cross-cluster edges, isolated nodes |
| `node eval.mjs` | Ranking A/B against raw vector similarity |
| `node gate.mjs --dir <project>` | Release gate: fails when recall / average rank regress |
| `node test.mjs` | Full self-test on a fixture store (no real memories needed) |
| `node doctor.mjs --dir <project>` | Diagnose "installed but nothing happens" |
| `node tokens.mjs <sessionID>` | Per-request input/cacheRead/hit-rate for one session |
| `node seed.mjs` / `--clean` | Synthetic memories in an **isolated** shard, for scale tests |
| `node tag.mjs [dir]` | Print the container tag / shard path for a project directory |

## Structured memories and behavioral edges

Two sidecar stores keep the upstream database read-only:

| File | Contents |
|---|---|
| `data/records.json` | `kind / condition / source / validUntil / supersedes` keyed by memory id |
| `data/coactivation.jsonl` | one line per turn: which memory ids were injected together |

The plugin registers a tool called **`memctx_add`** so writes carry those fields:

```
memctx_add(content, kind, condition, source, tags?, supersedes?)
```

Injection renders them (`(decision, rel 0.39)` … `↳ 条件: …；来源: …`), and records with `validUntil` (superseded) are filtered out of recall but stay queryable.

`memctx_add` validates before writing instead of trusting the caller: content 20–300 characters, `condition` and `source` required, 2–5 lowercase tags, and a duplicate check that refuses anything scoring ≥ 0.75 against an existing memory. Pass `supersedes=<id>` to replace one deliberately.

```
拒绝写入：已有高度相似的记忆（sim=0.79）mem_1793493816581_fr3908jlt
「结构化记忆写入改用 memctx_add 工具…」
如确需更新，请带上 supersedes=mem_1793493816581_fr3908jlt 重试。
```

Behavioral edges are computed on read:

```
w(i,j) = Jaccard(i,j) × 0.5^(Δt / 90 days)
```

and merged with the structural neighbor table by taking the larger weight.

> Note: `records.json` only covers memories written through `memctx_add`. Memories written with the plain `memory` tool still work, they just render without condition/source.

## Self-test without real data

```powershell
npm test
```

Seeds 28 fixture memories into an isolated container tag, builds the graph, runs 22 cases, asserts recall and cleanup — then deletes everything. No real memories are touched, so this works on a fresh machine (it does need a running OpenCode + opencode-mem).

## Evaluation

14 real questions against a real memory store, comparing raw vector order (upstream's dominant term) with this plugin's ranking. Numbers move with corpus size, so both runs are listed:

```
15 memories  raw vector order   recall@3: 10/14   avg rank 3.8
             this plugin        recall@3: 12/14   avg rank 2.1

27 memories  raw vector order   recall@3:  9/14   avg rank 6.1
             this plugin        recall@3: 10/14   avg rank 2.4
```

The gap narrows as the store grows (more candidates, more competition), but the plugin stays ahead on both counts.

`gate.mjs` turns that into a pass/fail check. It judges **relative to raw vector order** (absolute rank inevitably drifts as the store grows) and prints a paired significance check:

```
gate: 14 用例，topK=3
  相对判定（主判据，对比上游纯向量）
    召回：11 vs 6   PASS
    平均名次：2.93 vs 18.93   PASS
  绝对兜底（只保留召回地板，防两边一起烂）
    召回：11 / 14   要求 ≥ 7   PASS
  统计（配对差异是否可信）
    召回 95% CI：52.4%–92.4%（11/14）
    McNemar：仅我们命中 5，仅上游命中 0，p=0.06（差异不显著）

=> 通过
```

Run it before publishing a change:

```powershell
node gate.mjs --dir C:\path\to\the\project\whose\memories\you\evaluate
```

`--dir` matters: the script derives the project's container tag from a directory path, and the default (`cwd`) is wrong when you run it from the plugin folder. It needs a live OpenCode + opencode-mem instance, so it is a local pre-release check rather than a CI job.

### Held-out evaluation

The 14 + 15 cases above are a **development set** — they have been used to choose weights, so they can no longer give an unbiased estimate. `fixtures/heldout-2026-11.json` holds 33 cases written by three independent subagents from a memory dump, never used during tuning.

```powershell
npm run heldout:check -- --dir <project> fixtures/heldout-2026-11.json   # integrity
node gate.mjs --no-default --cases fixtures/heldout-2026-11.json --dir <project>  # once, before release
```

Rules: validate before use, run **once per release**, never tune on it, and record the result plus the file SHA-256. See `NOTES.md` §12.6.

Two findings worth knowing before you tune anything:

- **Generic "common knowledge" memories hurt.** Injecting 20 sensible engineering facts dropped recall@3 `11 → 10` and average rank `2.2 → 9.7`. They look relevant to every query, so they crowd out real answers.
- **Graph scores need damping.** `max(edge × neighbor score)` lets neighbors promote each other; λ = 0.5 keeps the benefit without pushing the actual target down.

## Configuration

Constants live at the top of `index.ts`; ranking weights live in `lib/score.mjs`. Env overrides:

| Env | Default | Meaning |
|---|---|---|
| `MEMCTX_API` | `http://127.0.0.1:4747` | opencode-mem web server |
| `MEMCTX_NEIGHBORS` | `./data/neighbors.json` | neighbor table path |
| `MEMCTX_EXPAND` | `2` | graph candidate expansion depth (`0` disables, `1`/`2` hops) |
| `MEMCTX_EXPAND_SEEDS` | `5` | how many API top hits seed the expansion |
| `MEMCTX_EXPAND_MAX` | `20` | cap on memories pulled in from the shard |
| `MEMCTX_GRAPHMODE` | `max` | `max` (neighbor max score) or `ppr` (Personalized PageRank) |
| `MEMCTX_PPR_DAMPING` | `0.85` | PPR damping (only with `GRAPHMODE=ppr`) |
| `MEMCTX_PPR_SEEDS` | `5` | PPR seed count |
| `MEMCTX_DEDUP` | `1` | MMR diversification strength; `1` = off, lower = more diverse |
| `MEMCTX_HUB_ALPHA` | `0` | hub suppression strength (`0` = off; measured negative) |

Tuning knobs inside the code: `STABLE_K` (8), `DYNAMIC_K` (3), `W_CONTENT/W_TAGS/W_KEYWORD/W_GRAPH`, `GRAPH_LAMBDA` (1), `DECAY_HALF_LIFE_DAYS` (180), `DRIFT_TURNS` (2), `MAX_REANCHORS` (3).

## Limitations

- The stable block is anchored to the session's **first** message; re-anchoring is heuristic and costs one full recompute.
- `/api/search` is a private contract. Pin the upstream version; a route change breaks recall silently.
- The per-turn tail is written into the user message, so it is persisted in the transcript (≈100–200 tokens per turn).
- Expanded candidates have no query-vector score; BM25 is a lexical proxy and can miss pure paraphrase.
- PPR and MMR are implemented but measured **negative** on a ~50-memory store; both default off.
- `neighbors.json` is built by hand (`node graph.mjs`), not continuously.
- Windows: shard files are locked while OpenCode runs — stop it before deleting anything.

## License

MIT. `opencode-mem` itself is MIT by tickernelz; this is an independent companion, not a fork.
