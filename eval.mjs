#!/usr/bin/env node
/**
 * eval.mjs — 排序质量对比：上游（纯向量相似度）vs 我们的打分。
 *
 * 做法：同一批候选（/api/search 返回的 30 条），两种排序各取前 N 名，
 * 看「应该被召回的那条」是否在里头。这**只对比排序**，不含上游的标签/关键词项，
 * 所以是保守估计（上游真实分数会略高于纯相似度）。
 *
 * 用法：node eval.mjs [--k 3]
 */
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join, normalize } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { hubFactor } from "./lib/store.mjs"
import { buildBm25, normalizeScores } from "./lib/rank.mjs"
import { grams, overlap, rankItems } from "./lib/score.mjs"

const API_BASE = "http://127.0.0.1:4747"
const TOKEN = readFileSync(join(homedir(), ".opencode-mem", ".auth-token"), "utf-8").trim()
const K = Number(process.argv[process.argv.indexOf("--k") + 1]) || 3

// 与 index.ts 保持一致的默认参数；命令行可覆盖以做敏感性分析
const argNum = (name, def) => {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def
}
const W_CONTENT = argNum("--wc", 0.5)
const W_TAGS = argNum("--wt", 0.2)
const W_KEYWORD = argNum("--wk", 0.15)
const W_GRAPH = argNum("--wg", 0.15)
// 与 index.ts 对齐：线上 GRAPH_LAMBDA = 1（2026-11-01 复测：0.5 盲测 7/15，1.0 为 9/15）
const GRAPH_LAMBDA = argNum("--gl", 1)
const DECAY_HALF_LIFE_DAYS = 180

if (process.argv.includes("--debug")) {
  console.log(`weights: content=${W_CONTENT} tags=${W_TAGS} keyword=${W_KEYWORD} graph=${W_GRAPH}`)
}

function projectTag(dir) {
  const identity = `path:${normalize(dir)}`
  const hash = createHash("sha256").update(identity).digest("hex").slice(0, 16)
  return `opencode_project_${hash}`
}
const DIR_ARG = (() => {
  const i = process.argv.indexOf("--dir")
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : process.cwd()
})()
const TAG = (() => {
  const i = process.argv.indexOf("--tag")
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : projectTag(DIR_ARG)
})()

const NEIGHBORS = (() => {
  try {
    return JSON.parse(readFileSync(join(import.meta.dirname, "data", "neighbors.json"), "utf-8")).neighbors ?? null
  } catch {
    return null
  }
})()

// ---------------------------------------------------------------- 候选扩展（A/B 用）
// 与 index.ts 的 retrieve() 同一套逻辑：从 API top-N 出发按邻接表扩 1–2 跳，
// 把候选外的记忆按 id 从分片库只读补进来（它们没有 similarity，只算标签/关键词/图分）。
// 与 index.ts 对齐：线上默认开启 2 跳扩展（MEMCTX_EXPAND=2）
const EXPAND_DEPTH = argNum("--expand", 2)
const EXPAND_SEEDS = argNum("--eseeds", 5)
const EXPAND_MAX = argNum("--emax", 20)
const GRAPH_MODE = (() => {
  const i = process.argv.indexOf("--gmode")
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : "max"
})()
const PPR_DAMPING = argNum("--pd", 0.85)
const PPR_SEEDS = argNum("--ps", 5)
const DEDUP_LAMBDA = argNum("--dedup", 1)

let BM25 = null
function corpusBm25() {
  if (BM25) return BM25
  try {
    const hash = TAG.replace(/^opencode_project_/, "")
    const file = join(homedir(), ".opencode-mem", "data", "projects", `project_${hash}_shard_0.db`)
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      const docs = db
        .prepare("SELECT id, content FROM memories WHERE deleted_at IS NULL")
        .all()
        .map((r) => ({ id: String(r.id), content: String(r.content ?? "") }))
      BM25 = buildBm25(docs, grams)
    } finally {
      db.close()
    }
  } catch (e) {
    console.log(`bm25 db error: ${String(e).slice(0, 80)}`)
    BM25 = { score: () => new Map() }
  }
  return BM25
}

function shardItems(ids) {
  if (ids.length === 0) return []
  try {
    const hash = TAG.replace(/^opencode_project_/, "")
    const file = join(homedir(), ".opencode-mem", "data", "projects", `project_${hash}_shard_0.db`)
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      const ph = ids.map(() => "?").join(",")
      return db
        .prepare(
          `SELECT id, content, tags, type, created_at, is_pinned FROM memories ` +
            `WHERE deleted_at IS NULL AND id IN (${ph})`,
        )
        .all(...ids)
        .map((r) => ({
          id: String(r.id),
          content: String(r.content ?? ""),
          tags: r.tags ? String(r.tags) : undefined,
          type: r.type ? String(r.type) : undefined,
          createdAt: Number(r.created_at ?? 0),
          isPinned: Number(r.is_pinned ?? 0) === 1,
        }))
    } finally {
      db.close()
    }
  } catch (e) {
    console.log(`expand db error: ${String(e).slice(0, 80)}`)
    return []
  }
}

function expand(items, query) {
  if (EXPAND_DEPTH <= 0 || !NEIGHBORS || items.length === 0) return items
  const seen = new Set(items.map((i) => String(i.id)))
  const add = []
  let frontier = items.slice(0, EXPAND_SEEDS).map((i) => String(i.id))
  for (let d = 0; d < EXPAND_DEPTH && add.length < EXPAND_MAX; d++) {
    const next = []
    for (const id of frontier) {
      for (const e of NEIGHBORS[id] ?? []) {
        if (seen.has(e.id)) continue
        seen.add(e.id)
        add.push(e.id)
        next.push(e.id)
        if (add.length >= EXPAND_MAX) break
      }
      if (add.length >= EXPAND_MAX) break
    }
    frontier = next
  }
  if (add.length === 0) return items
  const extra = shardItems(add).filter((i) => i.type !== "prompt")
  // 补内容分：扩展项没有 similarity，用本地 BM25（与 index.ts 同一套）
  const scores = normalizeScores(corpusBm25().score(query))
  for (const it of extra) {
    const v = scores.get(String(it.id))
    if (typeof v === "number") it.similarity = v
  }
  return items.concat(extra)
}

// hub 抑制（与 index.ts 同一套系数，保证 eval 与线上行为一致）
const GRAPH_HUB = (() => {
  try {
    const j = JSON.parse(readFileSync(join(import.meta.dirname, "data", "neighbors.json"), "utf-8"))
    return { hub: j.hub ?? {}, total: Number(j.total ?? j.nodes ?? 0) || 0 }
  } catch {
    return { hub: {}, total: 0 }
  }
})()
const HUB_ALPHA = Number(process.env.MEMCTX_HUB_ALPHA ?? "0")
const HUB_TAU = Number(process.env.MEMCTX_HUB_TAU ?? "0.12")
const hubOf = (id) => hubFactor(GRAPH_HUB.hub[String(id)] ?? 0, GRAPH_HUB.total, { alpha: HUB_ALPHA, tau: HUB_TAU })

/** 与 index.ts 共用 lib/score.mjs 的排序实现；这里只做参数与字段名适配。 */
function rankOurs(items, query) {
  const scored = rankItems(items, query, NEIGHBORS, {
    wContent: W_CONTENT,
    wTags: W_TAGS,
    wKeyword: W_KEYWORD,
    wGraph: W_GRAPH,
    graphLambda: GRAPH_LAMBDA,
    decayHalfLifeDays: DECAY_HALF_LIFE_DAYS,
    graphMode: GRAPH_MODE,
    pprDamping: PPR_DAMPING,
    pprSeeds: PPR_SEEDS,
    diversifyLambda: DEDUP_LAMBDA,
    hubFn: hubOf,
  })
  return scored.map((s) => ({ ...s, i: s.item }))
}
// ---------------------------------------------------------------- 用例

const EXTRA_CASES = (() => {
  const i = process.argv.indexOf("--cases")
  if (i < 0 || !process.argv[i + 1]) return []
  try {
    return JSON.parse(readFileSync(process.argv[i + 1], "utf-8"))
  } catch (e) {
    console.log(`cases file error: ${e.message}`)
    return []
  }
})()

const CASES = [
  { q: "记忆注入会不会破坏缓存", expect: "v2 上线" },
  { q: "为什么动态内容不能放在 system 里", expect: "v2 上线" },
  { q: "邻接表存在哪里、怎么加载", expect: "接入图分" },
  { q: "压缩前要不要注入记忆快照", expect: "压缩兜底" },
  { q: "长会话换了话题，稳定块怎么办", expect: "锚点漂移" },
  { q: "GitHub 发布走哪条路线", expect: "项目目标升级" },
  { q: "上游仓库地址和许可证", expect: "项目目标升级" },
  { q: "数据库分片文件在哪", expect: "可行性验证" },
  { q: "检索结果里混进了原始提问", expect: "接入图分" },
  { q: "记忆写入的触发条件和去重", expect: "记忆写入机制" },
  { q: "中文搜索返回 0 是什么原因", expect: "请求：重启后验证" },
  { q: "本地用的什么嵌入模型", expect: "验证记录" },
  { q: "为什么会话缓存命中能到 99%", expect: "v2 上线" },
  { q: "钉住 pin 的记忆还衰减吗", expect: "接入图分" },
]

const ALL = [...(process.argv.includes("--no-default") ? [] : CASES), ...EXTRA_CASES]

async function search(q) {
  const url = `${API_BASE}/api/search?q=${encodeURIComponent(q)}&pageSize=30&tag=${encodeURIComponent(TAG)}`
  const r = await fetch(url, { headers: { "x-opencode-mem-token": TOKEN } })
  const j = await r.json()
  return (j.data?.items ?? []).filter((i) => i.type !== "prompt")
}

// ---------------------------------------------------------------- 跑

let upHit = 0
let ourHit = 0
let upPos = 0
let ourPos = 0
const ourHits = []
const upHits = []
const rows = []

for (const { q, expect } of ALL) {
  const base = await search(q)
  const items = expand(base, q)
  const qg = grams(q)

  // 上游：纯向量相似度（API 返回顺序就是相似度降序），只含原始候选
  const up = base.map((i) => ({ i, s: i.similarity ?? 0 })).sort((a, b) => b.s - a.s)
  // 我们：加权打分（含图分），候选可能已被扩展
  const our = rankOurs(items, q)

  const findPos = (list) => list.findIndex((x) => String(x.i.content ?? "").includes(expect))
  const pu = findPos(up)
  const po = findPos(our)

  if (pu >= 0 && pu < K) upHit++
  if (po >= 0 && po < K) ourHit++
  upHits.push(pu >= 0 && pu < K)
  ourHits.push(po >= 0 && po < K)
  if (pu < 0) upPos += 99
  else upPos += pu + 1
  if (po < 0) ourPos += 99
  else ourPos += po + 1

  rows.push({
    q,
    up: pu < 0 ? "—" : `#${pu + 1}`,
    our: po < 0 ? "—" : `#${po + 1}`,
    move: pu >= 0 && po >= 0 ? pu - po : 0,
  })
}

const n = ALL.length

// 全部用例都零候选，多半是 --dir 指错了项目（算出的 container tag 没有对应分片）
if (upPos === 99 * n && ourPos === 99 * n) {
  console.error(
    `没有检索到任何候选。当前目录：${DIR_ARG}\n` +
      `算出的 tag：${TAG}\n` +
      `提示：用 --dir <项目目录> 指定记忆所属的项目；gate.mjs 同样支持 --dir。`,
  )
  process.exit(2)
}

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify({
      cases: n,
      topK: K,
      upHit,
      ourHit,
      upAvg: Number((upPos / n).toFixed(2)),
      ourAvg: Number((ourPos / n).toFixed(2)),
      ourHits,
      upHits,
    }),
  )
  process.exit(0)
}

console.log(`cases=${n}  topK=${K}`)
console.log(`上游 召回@${K}: ${upHit}/${n}   平均名次: ${(upPos / n).toFixed(1)}`)
console.log(`我们 召回@${K}: ${ourHit}/${n}   平均名次: ${(ourPos / n).toFixed(1)}`)
console.log("")
for (const r of rows) {
  const mark = r.move > 0 ? `↑${r.move}` : r.move < 0 ? `↓${-r.move}` : ""
  console.log(`  ${r.up.padEnd(3)} -> ${r.our.padEnd(3)} ${mark.padEnd(4)} ${r.q}`)
}

if (process.argv.includes("--dump")) {
  const probe = process.argv[process.argv.indexOf("--dump") + 1] || CASES[0].q
  const items = await search(probe)
  const qg = grams(probe)
  console.log(`\n[dump] ${probe}  queryGrams=${qg.size}`)
  items.slice(0, 8).forEach((i) => {
    const tagGrams = grams((i.tags ?? []).join(" "))
    console.log(
      `  sim=${(i.similarity ?? 0).toFixed(3)} kw=${overlap(qg, grams(i.content)).toFixed(3)} ` +
        `tags=${tagGrams.size ? overlap(tagGrams, qg).toFixed(3) : "-"} ${String(i.content).slice(0, 22)}`,
    )
  })
  console.log("  --- 我们的排序 ---")
  rankOurs(items, q)
    .slice(0, 8)
    .forEach((s, n) =>
      console.log(`  #${n + 1} score=${s.score.toFixed(4)} ${String(s.i.content).slice(0, 24)}`),
    )
}
