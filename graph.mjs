#!/usr/bin/env node
/**
 * graph.mjs — 从 opencode-mem 的分片库生成「邻接表 + P1 邻居报告」。
 *
 * 只读：不写 opencode-mem 的任何文件；输出写到自己目录下的 data/。
 *
 * 用法：
 *   node graph.mjs                        # 自动选记忆最多的分片
 *   node graph.mjs --db <path>            # 指定分片
 *   node graph.mjs --tag opencode_project_xxx   # 按项目 tag 选分片（多项目时务必用这个）
 *   node graph.mjs --if-stale             # 只在「未覆盖的记忆 ≥10 条或 ≥20%」时才重算
 *   node graph.mjs --min 0.55 --top 5     # 边权阈值与邻居数
 *   node graph.mjs --report-only          # 不写 neighbors.json，只出报告
 *
 * 产物：
 *   data/neighbors.json     { generatedAt, db, minWeight, neighbors: { id: [{id,w}] } }
 *   data/Review_<date>.md   P1 验收用的人工抽查报告
 */
import { DatabaseSync } from "node:sqlite"
import { readdirSync, writeFileSync, mkdirSync, statSync, readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(HERE, "data")
const SHARD_DIR = join(homedir(), ".opencode-mem", "data", "projects")

// ---------------------------------------------------------------- 参数

const argv = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const flag = (name) => argv.includes(`--${name}`)

const MIN_WEIGHT = Number(opt("min", 0.5))
const TOP_K = Number(opt("top", 5))
const REPORT_ONLY = flag("report-only")
const DB_ARG = opt("db", "")
// 输出前缀：跑测试库时务必指定，否则会覆盖插件正在用的 neighbors.json
const OUT_PREFIX = opt("out", "")
// 项目 tag：opencode_project_<16 hex> → 精确锁定分片，避免多项目时选错库
const TAG_ARG = opt("tag", "")
const IF_STALE = flag("if-stale")
// hub 判定阈值：与 ≥HUB_T 的其它记忆数量，用来识别「对什么都沾边」的泛化记忆
const HUB_T = Number(opt("hub-t", 0.75))
const STALE_MIN = 10
const STALE_RATIO = 0.2

// ---------------------------------------------------------------- 选库

function pickShard() {
  if (DB_ARG) return DB_ARG
  if (TAG_ARG) {
    const hash = TAG_ARG.replace(/^opencode_project_/, "")
    const file = join(SHARD_DIR, `project_${hash}_shard_0.db`)
    return file
  }
  const files = readdirSync(SHARD_DIR)
    .filter((f) => f.endsWith("_shard_0.db"))
    .map((f) => join(SHARD_DIR, f))

  let best = null
  for (const file of files) {
    try {
      const db = new DatabaseSync(file, { readOnly: true })
      const row = db.prepare("select count(*) c from memories where deleted_at is null").get()
      db.close()
      if (!best || row.c > best.count) best = { file, count: row.c }
    } catch {
      /* 打不开的分片跳过 */
    }
  }
  if (!best) throw new Error(`没有可用分片：${SHARD_DIR}`)
  return best.file
}

// ---------------------------------------------------------------- 读数据

function loadMemories(file) {
  const db = new DatabaseSync(file, { readOnly: true })
  const rows = db
    .prepare(
      `select id, content, tags, type, created_at, is_pinned, vector
         from memories
        where deleted_at is null
        order by created_at asc`,
    )
    .all()
  db.close()

  return rows.map((r) => ({
    id: r.id,
    content: String(r.content ?? ""),
    tags: r.tags ? String(r.tags).split(",").filter(Boolean) : [],
    type: r.type ?? "memory",
    createdAt: Number(r.created_at ?? 0),
    pinned: r.is_pinned === 1,
    vec: toFloats(r.vector),
  }))
}

/** F32_BLOB(1024) → Float32Array（小端）。 */
function toFloats(buf) {
  if (!buf || buf.length < 4) return null
  const copy = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  const arr = new Float32Array(copy)
  return arr.length ? arr : null
}

// ---------------------------------------------------------------- 相似度

function norm(v) {
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i] * v[i]
  return Math.sqrt(s) || 1
}

function cosine(a, b, na, nb) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s / (na * nb)
}

// ---------------------------------------------------------------- 主流程

const file = pickShard()
const memories = loadMemories(file)
if (memories.length === 0) {
  console.error("分片里没有有效记忆")
  process.exit(1)
}

const withVec = memories.filter((m) => m.vec)
for (const m of withVec) m.norm = norm(m.vec)

// --if-stale：只判「有多少条记忆还没被算过」，不够多就直接退出
const NEIGHBOR_PATH = join(DATA_DIR, `${OUT_PREFIX}neighbors.json`)
function loadExisting(path) {
  try {
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, "utf-8"))
  } catch {
    return null
  }
}
if (IF_STALE && !REPORT_ONLY) {
  const existing = loadExisting(NEIGHBOR_PATH)
  if (existing) {
    const known = new Set(Object.keys(existing.neighbors ?? {}))
    const missing = withVec.filter((m) => !known.has(m.id)).length
    const ratio = withVec.length ? missing / withVec.length : 0
    if (missing < STALE_MIN && ratio < STALE_RATIO) {
      console.log(
        `fresh: 未覆盖 ${missing}/${withVec.length}（阈值 ${STALE_MIN} 条或 ${Math.round(STALE_RATIO * 100)}%），跳过重算`,
      )
      process.exit(0)
    }
    console.log(`stale: 未覆盖 ${missing}/${withVec.length}，重算邻接表`)
  }
}

const pairs = []
for (let i = 0; i < withVec.length; i++) {
  for (let j = i + 1; j < withVec.length; j++) {
    pairs.push({ i, j, w: cosine(withVec[i].vec, withVec[j].vec, withVec[i].norm, withVec[j].norm) })
  }
}
pairs.sort((a, b) => b.w - a.w)

// pairs 是按权重降序排的，分位数要从低到高取
const q = (p) => {
  if (pairs.length === 0) return 0
  const idx = Math.min(pairs.length - 1, Math.floor(pairs.length * (1 - p)))
  return pairs[idx].w
}

const histogram = () => {
  const buckets = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8]
  return buckets.map((b) => `${b}:${pairs.filter((p) => p.w >= b).length}`).join("  ")
}

const neighbors = {}
for (const m of withVec) neighbors[m.id] = []
for (const p of pairs) {
  if (p.w < MIN_WEIGHT) break
  const a = withVec[p.i]
  const b = withVec[p.j]
  if (neighbors[a.id].length < TOP_K) neighbors[a.id].push({ id: b.id, w: round(p.w) })
  if (neighbors[b.id].length < TOP_K) neighbors[b.id].push({ id: a.id, w: round(p.w) })
}

function round(n) {
  return Math.round(n * 1000) / 1000
}

const edgeCount = Object.values(neighbors).reduce((s, l) => s + l.length, 0)
const isolated = Object.entries(neighbors).filter(([, l]) => l.length === 0).length

// hubness：与多少条其它记忆的相似度 ≥ HUB_T——「对什么都沾边」的泛化记忆会很高。
// 只用于压制，不参与排序公式本身（排序里作为乘性惩罚，见 index.ts / eval.mjs）。
const hub = {}
for (const m of withVec) hub[m.id] = 0
for (const p of pairs) {
  if (p.w < HUB_T) break
  hub[withVec[p.i].id]++
  hub[withVec[p.j].id]++
}
const hubVals = Object.values(hub).filter((n) => n > 0).sort((a, b) => b - a)
const hubTop = hubVals.slice(0, Math.max(1, Math.round(hubVals.length * 0.1)))

// ---------------------------------------------------------------- 输出

mkdirSync(DATA_DIR, { recursive: true })
const today = new Date().toISOString().slice(0, 10)

if (!REPORT_ONLY) {
  writeFileSync(
    join(DATA_DIR, `${OUT_PREFIX}neighbors.json`),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        db: file,
        minWeight: MIN_WEIGHT,
        topK: TOP_K,
        nodes: withVec.length,
        total: withVec.length,
        hubT: HUB_T,
        hub,
        neighbors,
      },
      null,
      2,
    ),
    "utf-8",
  )
}

const byId = new Map(memories.map((m) => [m.id, m]))
const clip = (s, n = 70) => String(s).replace(/\s+/g, " ").slice(0, n)

const lines = [
  `# 邻居报告 ${today}`,
  "",
  `- 分片：\`${file}\``,
  `- 记忆：${memories.length} 条（有向量 ${withVec.length} 条）`,
  `- 边权阈值：${MIN_WEIGHT}，每节点最多 ${TOP_K} 邻居`,
  `- 边数：${edgeCount}，孤立节点：${isolated}`,
  `- 相似度分布：p50=${q(0.5).toFixed(3)} p90=${q(0.9).toFixed(3)} p99=${q(0.99).toFixed(3)}`,
  "",
  "> 抽查方法：随便挑 10 行「A ↔ B」，看这两条是否真的相关；≥7 条合理才算通过。",
  "",
]

for (const m of withVec) {
  const list = neighbors[m.id]
  lines.push(`## ${m.id}（${m.type}${m.pinned ? " 📌" : ""}）`)
  lines.push(`> ${clip(m.content)}`)
  if (list.length === 0) {
    lines.push("", "_无邻居（阈值以上没有相似记忆）_", "")
    continue
  }
  lines.push("")
  for (const e of list) {
    const other = byId.get(e.id)
    lines.push(`- ↔ **${e.w.toFixed(3)}** ${e.id} — ${clip(other?.content ?? "", 60)}`)
  }
  lines.push("")
}

const reportPath = join(DATA_DIR, `${OUT_PREFIX}Review_${today}.md`)
writeFileSync(reportPath, lines.join("\n"), "utf-8")

console.log(`shard:    ${file}`)
console.log(`memories: ${memories.length} (with vector ${withVec.length})`)
console.log(`edges:    ${edgeCount}  isolated: ${isolated}`)
console.log(`weights:  p50=${q(0.5).toFixed(3)} p90=${q(0.9).toFixed(3)} p99=${q(0.99).toFixed(3)} max=${(pairs[0]?.w ?? 0).toFixed(3)}`)
console.log(`pairs>=:  ${histogram()}`)
console.log(
  `hub>=${HUB_T}: 节点 ${hubVals.length} 个有邻居，前 10% 均值 ${hubTop.length ? (hubTop.reduce((a, b) => a + b, 0) / hubTop.length).toFixed(1) : 0}，最高 ${hubVals[0] ?? 0}`,
)
console.log(`report:   ${reportPath}`)
if (!REPORT_ONLY) console.log(`graph:    ${join(DATA_DIR, `${OUT_PREFIX}neighbors.json`)}`)
