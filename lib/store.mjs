/**
 * store.mjs — sidecar 存储（不写 opencode-mem 的库）。
 *
 * 两个文件，纯 node:fs，bun 运行时安全：
 *   data/records.json      { [memoryId]: { kind, condition, source, validFrom, validUntil,
 *                                          supersedes, confidence, links: [{ to, rel, label }] } }
 *   data/coactivation.jsonl 每行 { at, session, turn, ids: [...] }
 *
 * links 是「结构边」：显式记录 A 取代/依赖/补充 B，只在 sidecar 里，不写上游 metadata。
 * 渲染时随条目一起输出，供模型判断"这条从哪来、被谁改过"。
 *
 * 设计要点：
 *   - records 很小（几百条），整文件读写即可
 *   - coactivation 是追加日志，只在读取时聚合；超过 MAX_LINES 时压缩重写
 *   - 所有函数对损坏数据都返回空，不抛异常（插件里不能因此崩）
 */
import { readFileSync, appendFileSync, writeFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
export const DATA_DIR = process.env.MEMCTX_DATA ?? join(HERE, "..", "data")
export const RECORDS_FILE = join(DATA_DIR, "records.json")
export const USAGE_FILE = join(DATA_DIR, "coactivation.jsonl")

const MAX_LINES = 20_000

function ensureDir() {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- records

export function loadRecords() {
  try {
    const parsed = JSON.parse(readFileSync(RECORDS_FILE, "utf-8"))
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

export function saveRecords(records) {
  ensureDir()
  const tmp = `${RECORDS_FILE}.tmp`
  writeFileSync(tmp, JSON.stringify(records, null, 2), "utf-8")
  renameSync(tmp, RECORDS_FILE)
}

/** 结构边的关系类型（写入时校验）。 */
export const LINK_RELS = ["supersedes", "depends", "related"]

/** 规整 links：只留合法项，按 to+rel 去重，最多 5 条。 */
export function normalizeLinks(links) {
  if (!Array.isArray(links)) return null
  const out = []
  const seen = new Set()
  for (const raw of links) {
    if (!raw || typeof raw !== "object") continue
    const to = String(raw.to ?? "").trim()
    const rel = String(raw.rel ?? "").trim().toLowerCase()
    if (!to || !LINK_RELS.includes(rel)) continue
    const key = `${to}|${rel}`
    if (seen.has(key)) continue
    seen.add(key)
    const label = String(raw.label ?? "").trim().slice(0, 24)
    out.push(label ? { to, rel, label } : { to, rel })
    if (out.length >= 5) break
  }
  return out.length ? out : null
}

/**
 * hub 抑制系数：一条记忆与越多其它记忆「谁都像」（相似度 ≥ hubT），它就越可能在
 * 任何查询里挤进前排——这正是「通用常识」实验里平均名次从 2.2 崩到 9.7 的原因。
 * 这里按「hub 密度」给一个乘性惩罚：密度 ≤ tau 不罚，越高罚越狠，最多罚到 (1-alpha)。
 *
 * @param hubCount 该记忆与多少条其它记忆的相似度 ≥ hubT
 * @param total 当前语料总数（用来把绝对条数换成密度）
 */
export function hubFactor(hubCount, total, { alpha = 0.3, tau = 0.12 } = {}) {
  if (!total || !hubCount || alpha <= 0) return 1
  const density = hubCount / total
  if (density <= tau) return 1
  const x = Math.min(1, (density - tau) / (1 - tau))
  return 1 - alpha * x
}

/** 把结构边渲染成一行文本（供注入块使用）；无可用边时返回 null。 */export function formatLinks(links) {
  const list = normalizeLinks(links)
  if (!list) return null
  const relZh = { supersedes: "取代", depends: "依赖", related: "相关" }
  const parts = list.slice(0, 3).map((l) => `${l.label || String(l.to).slice(-6)}（${relZh[l.rel] ?? l.rel}）`)
  return parts.join("；")
}

/** 写入一条结构化记录；supersedes 会让旧记录带上 validUntil。 */
export function upsertRecord(id, fields) {
  const records = loadRecords()
  const now = new Date().toISOString()

  if (fields.supersedes && records[fields.supersedes] && !records[fields.supersedes].validUntil) {
    records[fields.supersedes].validUntil = now
  }

  // 结构边：本次给了就合并（去重），没给就保留旧的
  const incoming = normalizeLinks(fields.links)
  const existing = Array.isArray(records[id]?.links) ? records[id].links : []
  const merged = incoming
    ? normalizeLinks([...existing, ...incoming])
    : existing.length
      ? existing
      : undefined

  records[id] = {
    ...(records[id] ?? {}),
    kind: fields.kind ?? records[id]?.kind ?? "memory",
    condition: fields.condition ?? records[id]?.condition,
    source: fields.source ?? records[id]?.source,
    confidence: fields.confidence ?? records[id]?.confidence,
    validFrom: fields.validFrom ?? records[id]?.validFrom ?? now,
    validUntil: records[id]?.validUntil,
    supersedes: fields.supersedes ?? records[id]?.supersedes,
    ...(merged ? { links: merged } : {}),
    updatedAt: now,
  }
  saveRecords(records)
  return records[id]
}

export function forgetRecord(id) {
  const records = loadRecords()
  if (!records[id]) return false
  delete records[id]
  saveRecords(records)
  return true
}

// ---------------------------------------------------------------- usage

export function appendUsage(session, turn, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return false
  try {
    ensureDir()
    const line = JSON.stringify({ at: Date.now(), session, turn, ids })
    appendFileSync(USAGE_FILE, `${line}\n`, "utf-8")
    return true
  } catch {
    return false
  }
}

export function loadUsage() {
  try {
    const raw = readFileSync(USAGE_FILE, "utf-8")
    const out = []
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line)
        if (Array.isArray(row.ids) && row.ids.length > 0) out.push(row)
      } catch {
        /* 跳过坏行 */
      }
    }
    return out
  } catch {
    return []
  }
}

/** 行数过多时按「同 session+turn」合并重写，避免无限增长。 */
export function compactUsage() {
  try {
    if (!existsSync(USAGE_FILE)) return 0
    const lines = readFileSync(USAGE_FILE, "utf-8").split("\n").filter(Boolean)
    if (lines.length < MAX_LINES) return lines.length

    const merged = new Map()
    for (const line of lines) {
      try {
        const row = JSON.parse(line)
        const key = `${row.session}|${row.turn}`
        const prev = merged.get(key)
        if (!prev) merged.set(key, { ...row, ids: [...new Set(row.ids)] })
        else prev.ids = [...new Set([...prev.ids, ...row.ids])]
      } catch {
        /* skip */
      }
    }
    const out = [...merged.values()].map((r) => JSON.stringify(r)).join("\n")
    writeFileSync(USAGE_FILE, out + (out ? "\n" : ""), "utf-8")
    return merged.size
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------- edges

/**
 * 行为边：w(i,j) = Jaccard(i,j) × 0.5^(Δt/90天)
 * c_ij = 同一轮里 i、j 同时被使用的次数（设计文档 2.3）
 */
export function behavioralEdges(usage, { halfLifeDays = 90, minWeight = 0.2, topK = 5 } = {}) {
  const pair = new Map() // "a|b" -> { c, last }
  const count = new Map() // id -> 出现轮次

  for (const row of usage) {
    const ids = [...new Set(row.ids)].sort()
    for (const id of ids) count.set(id, (count.get(id) ?? 0) + 1)
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key = `${ids[i]}|${ids[j]}`
        const prev = pair.get(key)
        if (prev) {
          prev.c++
          prev.last = Math.max(prev.last, row.at ?? 0)
        } else {
          pair.set(key, { c: 1, last: row.at ?? 0 })
        }
      }
    }
  }

  const now = Date.now()
  const edges = new Map()
  for (const [key, { c, last }] of pair) {
    const [a, b] = key.split("|")
    const ca = count.get(a) ?? 0
    const cb = count.get(b) ?? 0
    if (ca + cb - c <= 0) continue
    const jaccard = c / (ca + cb - c)
    const days = Math.max(0, (now - last) / 86_400_000)
    const w = jaccard * Math.pow(0.5, days / halfLifeDays)
    if (w < minWeight) continue

    for (const [from, to] of [
      [a, b],
      [b, a],
    ]) {
      const list = edges.get(from) ?? []
      list.push({ id: to, w })
      edges.set(from, list)
    }
  }

  for (const [id, list] of edges) {
    list.sort((x, y) => y.w - x.w)
    edges.set(id, list.slice(0, topK))
  }
  return edges
}

/** 合并结构边（neighbors.json）与行为边，取较大权重。 */
export function mergeEdges(structural, behavioral) {
  if (!structural && !behavioral) return null
  const out = new Map()
  for (const source of [structural, behavioral]) {
    if (!source) continue
    const entries = source instanceof Map ? [...source.entries()] : Object.entries(source)
    for (const [id, list] of entries) {
      const cur = out.get(id) ?? new Map()
      for (const e of list) {
        const prev = cur.get(e.id)
        if (!prev || e.w > prev) cur.set(e.id, e.w)
      }
      out.set(id, cur)
    }
  }
  const result = new Map()
  for (const [id, m] of out) {
    result.set(
      id,
      [...m.entries()].map(([to, w]) => ({ id: to, w })).sort((x, y) => y.w - x.w).slice(0, 5),
    )
  }
  return result
}

export function storeStats() {
  const records = loadRecords()
  const usage = loadUsage()
  let ageMs = null
  try {
    ageMs = Date.now() - statSync(USAGE_FILE).mtimeMs
  } catch {
    /* no file */
  }
  return {
    records: Object.keys(records).length,
    usageRows: usage.length,
    usageAgeSeconds: ageMs === null ? null : Math.round(ageMs / 1000),
  }
}
