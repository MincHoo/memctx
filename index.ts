/**
 * spike-memctx v2 — C+ 路线：稳定块 + 尾部动态小节 + 打分 + 时间衰减
 *
 * 与 v1（纯 top-5 原样注入）的区别：
 *   1. 稳定性：首轮注入的「稳定块」按会话缓存，整场不变 → 前缀缓存不受影响
 *   2. 相关性：每轮在末尾追加一个小「动态小节」，只占几百 token，只为当轮服务
 *   3. 排序：0.5 内容 + 0.2 标签 + 0.15 关键词（图分留空，按 0.85 归一）× 时间衰减
 *   4. 去重：动态小节不会重复稳定块里已有的记忆
 *
 * 数据来源：opencode-mem 的本地 REST（只读），不写它的库。
 */
import { Plugin } from "@opencode/plugin"
import { readFileSync, appendFileSync, statSync, existsSync } from "node:fs"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { spawn } from "node:child_process"
import { homedir } from "node:os"
import { join, normalize, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import {
  appendUsage,
  behavioralEdges,
  loadRecords,
  loadUsage,
  formatLinks,
  hubFactor,
  mergeEdges,
  normalizeLinks,
  upsertRecord,
} from "./lib/store.mjs"

// ---------------------------------------------------------------- 配置

const API_BASE = process.env.MEMCTX_API ?? "http://127.0.0.1:4747"
const TOKEN_FILE = join(homedir(), ".opencode-mem", ".auth-token")
const LOG_FILE = join(homedir(), ".opencode-mem", "spike-memctx.log")

const MARK_STABLE = "[memctx]"
const MARK_DYNAMIC = "[memctx:now]"
const MARK_COMPACT = "[memctx:compaction]"

const CANDIDATES = 30 // 向 API 要多少候选
const STABLE_K = 8 // 稳定块最多几条
const DYNAMIC_K = 3 // 动态小节最多几条
const ITEM_CHARS = 180 // 每条截断
// 动态小节阈值按「相对最高分的比例」取，绝对阈值在不同查询下不可比
const DYNAMIC_REL_FLOOR = 0.75 // 至少达到本轮最高分的 75%
const DYNAMIC_ABS_FLOOR = 0.18 // 且不得低于这个绝对下限

// 锚点漂移：连续多少轮「最相关记忆不在稳定块里」就重锚；每会话最多几次（防抖）
const DRIFT_TURNS = 2
const MAX_REANCHORS = 3

// 打分权重（设计文档 4.2；graph 项尚未实现）
const W_CONTENT = 0.5
const W_TAGS = 0.2
const W_KEYWORD = 0.15
const W_GRAPH = 0.15
// 图分阻尼：邻居互抬会把 hub 顶到目标之上（实测 v2 被自己的邻居挤出前三）。
// 0.5 时召回@3 与 1.0 相同，但对「互相抬轿子」更保守。
const GRAPH_LAMBDA = 0.5
const W_SUM = W_CONTENT + W_TAGS + W_KEYWORD + W_GRAPH

// hub 抑制：对「跟谁都像」的泛化记忆加乘性惩罚。
// 实测（47 条语料，两套用例）：alpha=0.15/0.3/0.5 都让召回或平均名次变差（默认 9→8，盲测 11→11/10/9），
// **负收益，默认关闭**；保留实现与数据，换语料后可用 MEMCTX_HUB_ALPHA 复测。
const HUB_ALPHA = Number(process.env.MEMCTX_HUB_ALPHA ?? "0")
const HUB_TAU = Number(process.env.MEMCTX_HUB_TAU ?? "0.12")

const DECAY_HALF_LIFE_DAYS = 180

// 邻接表（由 graph.mjs 生成，只读）
type NeighborEdge = { id: string; w: number }
type NeighborMap = Record<string, NeighborEdge[]>

const NEIGHBOR_FILE = process.env.MEMCTX_NEIGHBORS ?? fileURLToPath(new URL("./data/neighbors.json", import.meta.url))

/**
 * 合并结构边（neighbors.json）与行为边（coactivation 日志），结果缓存 60 秒。
 * 行为边由每轮注入时记录的 usage 现算，权重 = Jaccard × 90 天半衰。
 */
let mergedEdges: NeighborMap | null = null
let mergedAtIndex = 0

function loadEdges(): NeighborMap | null {
  const now = Date.now()
  if (now - mergedAtIndex < 60_000) return mergedEdges
  mergedAtIndex = now

  const structural = loadNeighbors()
  let behavioral: Map<string, NeighborEdge[]> | null = null
  try {
    behavioral = behavioralEdges(loadUsage(), { halfLifeDays: 90, minWeight: 0.2, topK: 5 })
  } catch {
    behavioral = null
  }

  const merged = mergeEdges(structural, behavioral)
  if (!merged) {
    mergedEdges = null
    return null
  }
  const out: NeighborMap = {}
  for (const [id, list] of merged) out[id] = list
  mergedEdges = out
  return out
}

/**
 * 邻接表按 mtime 懒加载：graph.mjs 重新生成后最多 60 秒生效，不必重载插件。
 * 重载会清空会话缓存，代价是一轮全量重算，所以这里刻意不让文件触发重载。
 */
let cachedNeighbors: NeighborMap | null = null
let cachedHub: Record<string, number> | null = null
let cachedTotal = 0
let cachedMtime = 0
let checkedAt = 0

function loadNeighbors(): NeighborMap | null {
  const now = Date.now()
  if (now - checkedAt < 60_000) return cachedNeighbors
  checkedAt = now
  try {
    const st = statSync(NEIGHBOR_FILE)
    if (st.mtimeMs === cachedMtime) return cachedNeighbors
    const parsed = JSON.parse(readFileSync(NEIGHBOR_FILE, "utf-8"))
    const map = parsed?.neighbors
    cachedNeighbors = map && typeof map === "object" ? (map as NeighborMap) : null
    cachedHub = parsed?.hub && typeof parsed.hub === "object" ? (parsed.hub as Record<string, number>) : null
    cachedTotal = Number(parsed?.total ?? parsed?.nodes ?? 0) || 0
    cachedMtime = st.mtimeMs
  } catch {
    cachedNeighbors = null
    cachedHub = null
    cachedTotal = 0
    cachedMtime = 0
  }
  return cachedNeighbors
}

/** 当前记忆的 hub 密度惩罚系（1 = 不罚）。 */
function hubOf(id: string): number {
  if (!cachedHub || !cachedTotal) return 1
  return hubFactor(cachedHub[id] ?? 0, cachedTotal, { alpha: HUB_ALPHA, tau: HUB_TAU })
}

// ---------------------------------------------------------------- 基础设施

type AnyRecord = Record<string, any>

function log(line: string): void {
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* 日志失败不影响对话 */
  }
}

function readToken(): string {
  try {
    return readFileSync(TOKEN_FILE, "utf-8").trim()
  } catch {
    return ""
  }
}

/**
 * 上游是否还开着自动注入。开着就会和本插件各注入一份记忆，
 * 属于「装了没反应 / 内容重复」最常见的原因，所以启动时明确写进日志。
 */
function upstreamInjection(): "off" | "on" | "unknown" {
  try {
    const raw = readFileSync(join(homedir(), ".config", "opencode", "opencode-mem.jsonc"), "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
    const cfg = JSON.parse(raw.replace(/,(\s*[}\]])/g, "$1"))
    const value = cfg?.chatMessage?.enabled
    return value === false ? "off" : value === true ? "on" : "unknown"
  } catch {
    return "unknown"
  }
}

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12)
}

// ---------------------------------------------------------------- 文本工具

const NOISE = /[\s\-_.,;:!?()[\]{}"'`~@#$%^&*+=|\\/<>，。；：！？（）【】「」『』、·…—]/g

/** 中文友好：去掉标点空白后按 2-gram 切；同时保留较长的英文/数字词。 */
function grams(text: string): Set<string> {
  const clean = String(text ?? "")
    .toLowerCase()
    .replace(NOISE, " ")
  const out = new Set<string>()

  for (const word of clean.split(/\s+/)) {
    if (!word) continue
    if (/[\u4e00-\u9fff]/.test(word)) {
      const chars = [...word].filter((c) => /[\u4e00-\u9fff]/.test(c))
      for (let i = 0; i < chars.length - 1; i++) out.add(chars[i] + chars[i + 1])
      if (chars.length === 1) out.add(chars[0])
    } else if (word.length >= 2) {
      out.add(word)
    }
  }
  return out
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let hit = 0
  for (const g of a) if (b.has(g)) hit++
  return hit / a.size
}

// ---------------------------------------------------------------- 打分

type Scored = {
  item: AnyRecord
  content: number
  tags: number
  keyword: number
  graph: number
  hasTags: boolean
  hasGraph: boolean
  decay: number
  score: number
}

/**
 * 时间戳归一化。注意：API 返回的 createdAt 是 ISO 字符串，不是毫秒数。
 * 直接 Number() 会得到 NaN，`|| 0` 再把它变成 0，于是衰减恒为 1——静默失效。
 */
function toMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const t = Date.parse(value)
    return Number.isFinite(t) ? t : 0
  }
  return 0
}

function daysSince(value: unknown): number {
  const ms = toMs(value)
  if (!ms) return 0
  return Math.max(0, (Date.now() - ms) / 86_400_000)
}

function scoreItem(item: AnyRecord, queryGrams: Set<string>): Scored {
  const content = typeof item?.similarity === "number" ? item.similarity : 0

  const tagList: string[] = Array.isArray(item?.tags)
    ? item.tags
    : typeof item?.tags === "string" && item.tags
      ? item.tags.split(",")
      : []
  const tagGrams = grams(tagList.join(" "))
  // 标签相似度：查询覆盖了多少标签 2-gram
  const tags = tagGrams.size > 0 ? overlap(tagGrams, queryGrams) : 0

  const keyword = overlap(queryGrams, grams(item?.content ?? ""))

  const pinned = item?.isPinned === true || item?.isPinned === 1
  const decay = pinned ? 1 : Math.pow(0.5, daysSince(item?.createdAt) / DECAY_HALF_LIFE_DAYS)

  // 先只算「非图」部分，图分在 rank() 里用候选集内的邻居分补上
  const hasTags = tagGrams.size > 0
  const wSum = W_CONTENT + (hasTags ? W_TAGS : 0) + W_KEYWORD
  const base = (W_CONTENT * content + (hasTags ? W_TAGS * tags : 0) + W_KEYWORD * keyword) / wSum

  return { item, content, tags, keyword, graph: 0, hasTags, hasGraph: false, decay, score: base * decay * hubOf(String(item?.id ?? "")) }
}

/** 两遍：第一遍算基础分，第二遍用候选集内的邻居分补 graph_score。 */
function rank(items: AnyRecord[], query: string, neighbors: NeighborMap | null): Scored[] {
  const qg = grams(query)
  const scored = items.map((it) => scoreItem(it, qg))
  if (!neighbors) return scored.sort((a, b) => b.score - a.score)

  const byId = new Map(scored.map((s) => [String(s.item?.id ?? ""), s]))
  for (const s of scored) {
    const edges = neighbors[String(s.item?.id ?? "")]
    if (!edges || edges.length === 0) continue
    let g = 0
    for (const e of edges) {
      const other = byId.get(e.id)
      if (other) g = Math.max(g, e.w * other.score)
    }
    g *= GRAPH_LAMBDA
    if (g <= 0) continue

    const wSum = W_CONTENT + (s.hasTags ? W_TAGS : 0) + W_KEYWORD + W_GRAPH
    const base =
      (W_CONTENT * s.content + (s.hasTags ? W_TAGS * s.tags : 0) + W_KEYWORD * s.keyword + W_GRAPH * g) / wSum
    s.graph = g
    s.hasGraph = true
    s.score = base * s.decay * hubOf(String(s.item?.id ?? ""))
  }
  return scored.sort((a, b) => b.score - a.score)
}

// ---------------------------------------------------------------- 检索

/**
 * 当前项目的 containerTag。
 *
 * 不起眼但很关键：/api/search 不带 tag 时会遍历**所有分片的所有项目**，
 * 别的项目（或测试分片）的记忆会混进召回。上游自己用 recallScope=project 规避了这点。
 *
 * 上游的 tag 规则：`{prefix}_project_{sha256(identity).slice(0,16)}`，
 * identity 对非 git 目录是 `path:<normalized dir>`。算出来的分片不存在时返回 null，
 * 交给调用方退回全局检索 + 客户端过滤。
 */
function projectTag(directory: string): string | null {
  try {
    const identity = `path:${normalize(directory)}`
    const hash = createHash("sha256").update(identity).digest("hex").slice(0, 16)
    const shard = join(homedir(), ".opencode-mem", "data", "projects", `project_${hash}_shard_0.db`)
    return existsSync(shard) ? `opencode_project_${hash}` : null
  } catch {
    return null
  }
}

async function search(query: string, pageSize = CANDIDATES, tag?: string | null): Promise<AnyRecord[]> {
  const scope = tag ? `&tag=${encodeURIComponent(tag)}` : ""
  const url = `${API_BASE}/api/search?q=${encodeURIComponent(query)}&pageSize=${pageSize}${scope}`
  const res = await fetch(url, {
    headers: { "x-opencode-mem-token": readToken() },
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`search HTTP ${res.status}`)
  const body: AnyRecord = await res.json()
  const items = body?.data?.items ?? body?.items ?? []
  if (!Array.isArray(items)) return []
  // 上游会把 capture 的原始提问（type=prompt）混进结果，那是噪声。
  // 用「排除法」而不是白名单：记忆类型会随版本增加（note/decision/capture…），白名单会悄悄漏数据。
  const NOISE_TYPES = new Set(["prompt", "skill", "message", "tool"])
  const records = loadStructured()
  return items
    .filter((i: AnyRecord) => !NOISE_TYPES.has(String(i?.type ?? "memory")))
    // 被取代（有 validUntil）的记忆默认不再注入，但仍在库里可查
    .filter((i: AnyRecord) => !records[String(i?.id ?? "")]?.validUntil)
}

// ---------------------------------------------------------------- 消息解析

function textOf(m: AnyRecord): string {
  const parts = Array.isArray(m?.content) ? m.content : Array.isArray(m?.parts) ? m.parts : null
  if (parts) {
    return parts
      .filter((p: AnyRecord) => typeof p?.text === "string" && p?.synthetic !== true)
      .map((p: AnyRecord) => p.text)
      .join("\n")
      .trim()
  }
  return typeof m?.content === "string" ? m.content.trim() : ""
}

/** 去掉我们上一轮追加到用户消息里的动态小节，避免它变成下一轮的检索词。 */
function stripInjected(text: string): string {
  const i = text.indexOf(MARK_DYNAMIC)
  return (i >= 0 ? text.slice(0, i) : text).trim()
}

function userTexts(messages: AnyRecord[]): string[] {
  const out: string[] = []
  for (const m of messages) {
    if ((m?.role ?? m?.info?.role) !== "user") continue
    const t = textOf(m)
    if (t) out.push(t)
  }
  return out
}

// ---------------------------------------------------------------- 渲染

function oneLine(s: string): string {
  return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, ITEM_CHARS)
}

/** 结构化字段缓存（60 秒），sidecar 改动后最多一分钟生效。 */
let structCache: AnyRecord | null = null
let structAt = 0

function loadStructured(): AnyRecord {
  const now = Date.now()
  if (now - structAt < 60_000) return structCache ?? {}
  structAt = now
  try {
    structCache = loadRecords()
  } catch {
    structCache = {}
  }
  return structCache ?? {}
}

function render(marker: string, scored: Scored[], title: string): string {
  const records = loadStructured()
  const lines = [`${marker} ${title}`]
  scored.forEach((s, i) => {
    const it = s.item
    const id = String(it?.id ?? "")
    const rec = records[id]
    const rel = s.score.toFixed(2)
    const kind = rec?.kind ?? it?.type ?? "memory"
    const pinned = it?.isPinned === true || it?.isPinned === 1 ? " 📌" : ""
    lines.push(`${i + 1}. (${kind}${pinned}, rel ${rel}) ${oneLine(it?.content ?? "")}`)

    // 结构化字段优先；没有就退回标签
    if (rec && (rec.condition || rec.source)) {
      const bits = []
      if (rec.condition && rec.condition !== "universal") bits.push(`条件: ${rec.condition}`)
      if (rec.source) bits.push(`来源: ${rec.source}`)
      if (rec.validUntil) bits.push("已被取代")
      lines.push(`   ↳ ${bits.join("；")}`)
    }
    const tags = Array.isArray(it?.tags) ? it.tags.join(", ") : it?.tags
    if (tags) lines.push(`   ↳ tags: ${tags}`)
    // 结构边：只在 sidecar 里，随条目一起渲染，给模型判断"这条从哪来、被谁改过"
    const linkLine = formatLinks(rec?.links)
    if (linkLine) lines.push(`   ↳ 关联: ${linkLine}`)
  })
  return lines.join("\n")
}

// ---------------------------------------------------------------- 插件

type SessionState = {
  stable: string // 已渲染好的稳定块文本
  stableIds: Set<string>
  stableHash: string
  anchor: string // 当前稳定块所依据的文本
  drift: number // 连续多少轮「最相关的记忆不在稳定块里」
  reanchors: number // 本会话已重锚次数
  lastQuery: string
  lastDynamicIds: string[] // 上一轮动态小节注入的记忆 id（供共现日志使用）
}

export default Plugin.define({
  id: "spike.memctx",
  async setup(ctx) {
    const initialGraph = loadNeighbors()
    const tag = projectTag(String(ctx?.location?.directory ?? process.cwd()))
    const inject = upstreamInjection()
    log(
      `setup v2: api=${API_BASE} token=${readToken() ? "ok" : "missing"} ` +
        `graph=${initialGraph ? `${Object.keys(initialGraph).length} 节点` : "未加载"} ` +
        `scope=${tag ?? "全局（未匹配到项目分片）"} inject=${inject}`,
    )
    if (inject === "on") {
      log("WARN 上游注入仍开着（chatMessage.enabled!=false）—— 上下文里会出现两份记忆")
    }
    if (!tag) {
      log("WARN 没有匹配到项目分片 —— 检索会退回全局，可能混入别的项目；先跑一次写入或确认目录")
    }

    // 邻接表增量刷新：未覆盖的记忆够多（≥10 条或 ≥20%）才重算，否则脚本自己退出。
    // 放后台跑，不阻塞首轮检索；失败只记日志，不影响对话。
    // 注意：桌面版里 process.execPath 是 opencode-cli.exe，不能拿来跑 .mjs，
    // 必须用真实的 node（可用 MEMCTX_NODE 指定绝对路径）。
    if (tag && process.env.MEMCTX_GRAPH_REFRESH !== "0") {
      try {
        const nodeBin = process.env.MEMCTX_NODE ?? "node"
        const child = spawn(
          nodeBin,
          [join(dirname(fileURLToPath(import.meta.url)), "graph.mjs"), "--if-stale", "--tag", tag],
          { detached: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
        )
        let out = ""
        child.stdout?.on("data", (d) => (out += String(d)))
        child.stderr?.on("data", (d) => (out += String(d)))
        child.on("close", (code) => {
          const line = out.trim().split("\n").filter(Boolean).pop() ?? ""
          if (/^stale:|^fresh:/.test(line)) log(`graph refresh: ${line}`)
          else if (code !== 0) log(`graph refresh failed(code=${code}, exe=${process.execPath}): ${out.trim().slice(0, 400)}`)
        })
        child.on("error", (e) => log(`graph refresh spawn error: ${String(e)}`))
        child.unref()
      } catch (error) {
        log(`graph refresh skipped: ${String(error)}`)
      }
    }

    const sessions = new Map<string, SessionState>()
    const loggedTurns = new Set<string>() // 同一轮内多次请求只记一次共现

    const registration = await ctx.session.hook("context", async (event: AnyRecord) => {
      try {
        const sessionID = String(event?.sessionID ?? "?")
        const messages: AnyRecord[] = Array.isArray(event?.messages) ? event.messages : []
        const texts = userTexts(messages)
        if (texts.length === 0) {
          log(`skip session=${sessionID} reason=no-user-text`)
          return
        }

        // ---- 稳定块：整个会话只算一次（按会话缓存，避免每轮重复检索）
        let st = sessions.get(sessionID)
        if (!st) {
          const anchor = stripInjected(texts[0])
          const ranked = rank(await search(anchor, CANDIDATES, tag), anchor, loadEdges())
          const picked = ranked.slice(0, STABLE_K)
          const text = picked.length
            ? render(MARK_STABLE, picked, `${picked.length} 条（会话稳定块）`)
            : `${MARK_STABLE} 无匹配记忆`
          st = {
            stable: text,
            stableIds: new Set(picked.map((p) => String(p.item?.id ?? ""))),
            stableHash: shortHash(text),
            anchor,
            drift: 0,
            reanchors: 0,
            lastQuery: anchor,
            lastDynamicIds: [],
          }
          sessions.set(sessionID, st)
          log(
            `stable session=${sessionID} hash=${st.stableHash} n=${picked.length} ` +
              `bytes=${Buffer.byteLength(text)} ` +
              `ids=${picked.map((p) => String(p.item?.id ?? "").slice(-6)).join(",")} ` +
              `sample="${text.split("\n").slice(0, 4).join(" | ").slice(0, 220)}" ` +
              `anchor="${anchor.slice(0, 30).replace(/\n/g, " ")}"`,
          )
        }
        event.system.push({ type: "text", text: st.stable })

        // ---- 共现日志（2.3 行为边的输入）：每轮记一次「哪些记忆被同时使用」
        const turnKey = shortHash(texts[texts.length - 1] ?? "")
        const usageKey = `${sessionID}|${turnKey}`
        if (!loggedTurns.has(usageKey)) {
          loggedTurns.add(usageKey)
          if (loggedTurns.size > 5000) loggedTurns.clear() // 防内存泄漏
          const used = [...st.stableIds, ...st.lastDynamicIds].filter(Boolean)
          if (used.length > 0) appendUsage(sessionID, turnKey, used)
        }

        // 诊断：system 全量指纹。若两轮不同，说明缓存被打断的原因不在我们（或不止我们）
        const sysText = (event.system as AnyRecord[]).map((p) => String(p?.text ?? "")).join("\u0000")
        log(
          `sys session=${sessionID} hash=${shortHash(sysText)} parts=${event.system.length} ` +
            `bytes=${Buffer.byteLength(sysText)} msgs=${messages.length}`,
        )
      } catch (error) {
        log(`context error: ${String(error)}`)
      }
    })

    // ---- 动态小节：注入到「用户消息尾部」，而不是 system
    //
    // 为什么不在 system：system 在整段上下文的最前面，它尾部一变，
    // 后面的消息历史就不再是缓存前缀 → 每轮全量重算（实测 12 万 token/轮）。
    // 用户消息是前缀的末尾，改它只影响这一条新消息。
    const promptHook = await ctx.session.hook("prompt", async (event: AnyRecord) => {
      try {
        const sessionID = String(event?.sessionID ?? "?")
        const raw = String(event?.prompt?.text ?? "")
        const query = stripInjected(raw)
        if (!query.trim()) return

        const st = sessions.get(sessionID)
        // 首轮还没有稳定块（本轮的上下文 hook 才建），此时只靠稳定块即可
        if (!st) {
          log(`dynamic skip session=${sessionID} reason=no-stable-yet`)
          return
        }

        const ranked = rank(await search(query, CANDIDATES, tag), query, loadEdges())

        // ---- 锚点漂移检测：最相关的记忆连续 N 轮都不在稳定块里 → 按最近话题重锚
        const topId = String(ranked[0]?.item?.id ?? "")
        if (topId && !st.stableIds.has(topId)) st.drift++
        else st.drift = 0

        if (st.drift >= DRIFT_TURNS && st.reanchors < MAX_REANCHORS) {
          const newAnchor = `${st.lastQuery}\n${query}`.slice(-400)
          const rebuilt = rank(await search(newAnchor, CANDIDATES, tag), newAnchor, loadEdges()).slice(0, STABLE_K)
          const text = rebuilt.length
            ? render(MARK_STABLE, rebuilt, `${rebuilt.length} 条（会话稳定块·已重锚）`)
            : `${MARK_STABLE} 无匹配记忆`
          const from = st.stableHash
          st.stable = text
          st.stableIds = new Set(rebuilt.map((p) => String(p.item?.id ?? "")))
          st.stableHash = shortHash(text)
          st.anchor = newAnchor
          st.drift = 0
          st.reanchors++
          log(
            `reanchor session=${sessionID} from=${from} to=${st.stableHash} ` +
              `n=${rebuilt.length} times=${st.reanchors}`,
          )
        }
        st.lastQuery = query

        const best = ranked[0]?.score ?? 0
        const floor = Math.max(DYNAMIC_ABS_FLOOR, best * DYNAMIC_REL_FLOOR)
        const fresh = ranked
          .filter((r) => !st.stableIds.has(String(r.item?.id ?? "")))
          .filter((r) => r.score >= floor)
          .slice(0, DYNAMIC_K)

        st.lastDynamicIds = fresh.map((r) => String(r.item?.id ?? "")).filter(Boolean)

        if (fresh.length === 0) {
          log(
            `dynamic session=${sessionID} empty q="${query.slice(0, 30).replace(/\n/g, " ")}" ` +
              `best=${best.toFixed(2)} floor=${floor.toFixed(2)} drift=${st.drift} top=${topId.slice(-6)}`,
          )
          return
        }

        const text = render(MARK_DYNAMIC, fresh, `${fresh.length} 条（本轮相关）`)
        event.prompt.text = `${query}\n\n${text}`
        log(
          `dynamic session=${sessionID} hash=${shortHash(text)} n=${fresh.length} ` +
            `bytes=${Buffer.byteLength(text)} drift=${st.drift} ` +
            `q="${query.slice(0, 30).replace(/\n/g, " ")}"`,
        )
      } catch (error) {
        log(`prompt error: ${String(error)}`)
      }
    })

    // ---- 压缩兜底：把「重点记忆快照」塞进压缩请求
    //
    // 压缩本身是一次独立的模型调用，缓存敏感度低，可以放心塞。
    // 目的不是让模型看到记忆（下一轮 context 会再注入），而是让**摘要**别把
    // 与记忆相关的结论丢掉——否则压缩后这些结论只存在于记忆里，而当前话题已经丢了。
    const compactionHook = await ctx.session.hook("compaction", async (event: AnyRecord) => {
      try {
        const sessionID = String(event?.sessionID ?? "?")
        const texts = userTexts(Array.isArray(event?.messages) ? event.messages : [])
        const anchor = texts.length > 0 ? stripInjected(texts[texts.length - 1]) : ""
        if (!anchor.trim()) {
          log(`compaction skip session=${sessionID} reason=no-text`)
          return
        }

        const picked = rank(await search(anchor, CANDIDATES, tag), anchor, loadEdges()).slice(0, 5)
        if (picked.length === 0) {
          log(`compaction session=${sessionID} empty`)
          return
        }

        const text = render(MARK_COMPACT, picked, `${picked.length} 条（压缩前快照，勿丢结论）`)
        event.system.push({ type: "text", text })
        log(
          `compaction session=${sessionID} hash=${shortHash(text)} n=${picked.length} ` +
            `bytes=${Buffer.byteLength(text)}`,
        )
      } catch (error) {
        log(`compaction error: ${String(error)}`)
      }
    })

    // ---- 结构化写入工具：替代裸 memory.add，让 kind/condition/source 有地方落
    let toolReg: { dispose: () => Promise<void> | void } | null = null
    if (tag) {
      try {
        toolReg = await ctx.tool.transform((editor: AnyRecord) => {
          editor.add({
            name: "memctx_add",
            description:
              "写入一条记忆并附带结构化字段（kind/condition/source）。比普通记忆写入多出「何时成立」「出处」，因此召回时能给模型判断依据。写入前会强制校验（正文 20–300 字、条件与来源必填、标签 2–5 个）并做去重（≥0.75 相似会拒绝，需用 supersedes 明确取代）。",
            input: {
              type: "object",
              properties: {
                content: { type: "string", description: "记忆正文，20–300 字，写结论不写过程" },
                kind: {
                  type: "string",
                  enum: ["decision", "pitfall", "env", "preference", "technical", "capture"],
                  description: "记忆类型",
                },
                condition: { type: "string", description: "这条在什么条件下成立；无条件写 universal" },
                source: { type: "string", description: "来源：文件路径、会话 id 或实测" },
                tags: { type: "array", items: { type: "string" }, description: "2-5 个小写标签" },
                links: {
                  type: "array",
                  description:
                    "结构边（可选，最多 5 条）：显式声明与其它记忆的关系。只会存进 sidecar，不写上游库。",
                  items: {
                    type: "object",
                    properties: {
                      to: { type: "string", description: "目标记忆 id（mem_ 开头）" },
                      rel: {
                        type: "string",
                        enum: ["supersedes", "depends", "related"],
                        description: "supersedes=取代；depends=依赖其结论；related=同主题",
                      },
                      label: { type: "string", description: "可选，目标记忆的短标题（≤24 字）" },
                    },
                    required: ["to", "rel"],
                  },
                },
                supersedes: { type: "string", description: "被本条取代的旧记忆 id（可选）" },
              },
              required: ["content", "kind", "condition", "source"],
              additionalProperties: false,
            },
            execute: async (input: AnyRecord) => {
              // 校验放在工具里，而不是靠提示词提醒——违规直接拒写，不靠自觉
              const content = String(input.content ?? "").trim()
              const condition = String(input.condition ?? "").trim()
              const source = String(input.source ?? "").trim()
              const tags = [
                ...new Set(
                  (Array.isArray(input.tags) ? input.tags : [])
                    .map((t: unknown) => String(t).trim().toLowerCase())
                    .filter(Boolean),
                ),
              ]

              const problems: string[] = []
              if (content.length < 20) problems.push("content 太短（<20 字），像过程记录而不是结论")
              if (content.length > 300) problems.push("content 太长（>300 字），请拆成多条")
              if (/^(用户|user)\s*(询问|要求|asked|requested)/i.test(content)) {
                problems.push("content 不能以「用户询问/要求」开头——那是过程记录")
              }
              if (!condition) problems.push("condition 必填；写不出适用条件说明这条不该存在")
              if (condition.length > 60) problems.push("condition 太长（>60 字）")
              if (!source) problems.push("source 必填（文件路径 / 会话 id / 实测）")
              if (tags.length < 2 || tags.length > 5) problems.push(`tags 需要 2–5 个（当前 ${tags.length}）`)
              // 结构边：只进 sidecar，不写上游库；非法项直接拒写而不是静默丢弃
              const rawLinks = Array.isArray(input.links) ? input.links : []
              const links = normalizeLinks(rawLinks)
              if (rawLinks.length > 0 && !links) {
                problems.push(
                  "links 格式不合法：每项需要 to（mem_ 开头）与 rel（supersedes/depends/related），最多 5 条",
                )
              }
              if (problems.length > 0) {
                return { content: `拒绝写入：\n- ${problems.join("\n- ")}` }
              }

              // 去重：写前先检索，≥0.75 视为重复，要求用 supersedes 明确取代
              try {
                // 用全文而不是前缀：实测前缀会把重复度从 0.79 压到 0.72，阈值失效
                const probe = content.slice(0, 300)
                const hits = await search(probe, 10, tag)
                const top = hits[0]
                const sim = Number((top as AnyRecord)?.similarity ?? 0)
                const topId = String((top as AnyRecord)?.id ?? "")
                log(`dedupe probe: hits=${hits.length} top=${topId.slice(-6)} sim=${sim.toFixed(3)}`)
                if (top && sim >= 0.75 && topId !== String(input.supersedes ?? "")) {
                  return {
                    content:
                      `拒绝写入：已有高度相似的记忆（sim=${sim.toFixed(2)}）${topId}\n` +
                      `「${String((top as AnyRecord).content ?? "").slice(0, 40)}」\n` +
                      `如确需更新，请带上 supersedes=${topId} 重试。`,
                  }
                }
              } catch {
                /* 检索失败不阻止写入 */
              }

              try {
                const res = await fetch(`${API_BASE}/api/memories`, {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    "x-opencode-mem-token": readToken(),
                  },
                  body: JSON.stringify({
                    content: String(input.content ?? ""),
                    containerTag: tag,
                    tags: Array.isArray(input.tags) ? input.tags : [],
                    type: "memory",
                  }),
                  signal: AbortSignal.timeout(20_000),
                })
                const body: AnyRecord = await res.json().catch(() => ({}))
                const id = String(body?.data?.id ?? "")
                if (!id) return { content: `写入失败：HTTP ${res.status}` }

                upsertRecord(id, {
                  kind: input.kind,
                  condition: input.condition,
                  source: input.source,
                  supersedes: input.supersedes,
                  links: links ?? undefined,
                })
                structAt = 0 // 让下一次渲染立刻看到新字段
                return {
                  content:
                    `已写入 ${id}（kind=${input.kind}` +
                    `${links ? `，关联 ${links.length} 条` : ""}` +
                    `${input.supersedes ? `，取代 ${input.supersedes}` : ""}）`,
                }
              } catch (error) {
                return { content: `写入异常：${String(error)}` }
              }
            },
          })
        })
        log("tool registered: memctx_add")
      } catch (error) {
        log(`tool error: ${String(error)}`)
      }
    }

    return async () => {
      log("cleanup v2")
      sessions.clear()
      if (toolReg) await toolReg.dispose()
      await compactionHook.dispose()
      await promptHook.dispose()
      await registration.dispose()
    }
  },
})
