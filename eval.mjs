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

const NOISE = /[\s\-_.,;:!?()[\]{}"'`~@#$%^&*+=|\\/<>，。；：！？（）【】「」『』、·…—]/g

function grams(text) {
  const clean = String(text ?? "").toLowerCase().replace(NOISE, " ")
  const out = new Set()
  for (const word of clean.split(/\s+/)) {
    if (!word) continue
    if (/[\u4e00-\u9fff]/.test(word)) {
      const chars = [...word].filter((c) => /[\u4e00-\u9fff]/.test(c))
      for (let i = 0; i < chars.length - 1; i++) out.add(chars[i] + chars[i + 1])
      if (chars.length === 1) out.add(chars[0])
    } else if (word.length >= 2) out.add(word)
  }
  return out
}

function toMs(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string") { const t = Date.parse(v); return Number.isFinite(t) ? t : 0 }
  return 0
}

function overlap(a, b) {
  if (!a.size || !b.size) return 0
  let hit = 0
  for (const g of a) if (b.has(g)) hit++
  return hit / a.size
}

const NEIGHBORS = (() => {
  try {
    return JSON.parse(readFileSync(join(import.meta.dirname, "data", "neighbors.json"), "utf-8")).neighbors ?? null
  } catch {
    return null
  }
})()

/** 两遍：先基础分，再用候选集内邻居补图分（与 index.ts 一致）。 */
function rankOurs(items, qg) {
  const scored = items.map((item) => {
    const content = typeof item.similarity === "number" ? item.similarity : 0
    const tagList = Array.isArray(item.tags) ? item.tags : String(item.tags ?? "").split(",").filter(Boolean)
    const tagGrams = grams(tagList.join(" "))
    const tags = tagGrams.size ? overlap(tagGrams, qg) : 0
    const keyword = overlap(qg, grams(item.content ?? ""))
    const hasTags = tagGrams.size > 0
    const wSum = W_CONTENT + (hasTags ? W_TAGS : 0) + W_KEYWORD
    const base = (W_CONTENT * content + (hasTags ? W_TAGS * tags : 0) + W_KEYWORD * keyword) / wSum
    const days = Math.max(0, (Date.now() - toMs(item.createdAt)) / 86400000)
    const decay = item.isPinned ? 1 : Math.pow(0.5, days / DECAY_HALF_LIFE_DAYS)
    return { i: item, content, tags, keyword, hasTags, score: base * decay }
  })

  if (NEIGHBORS) {
    const byId = new Map(scored.map((s) => [String(s.i.id), s]))
    for (const s of scored) {
      const edges = NEIGHBORS[String(s.i.id)]
      if (!edges?.length) continue
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
      s.score = base * (s.i.isPinned ? 1 : Math.pow(0.5, Math.max(0, (Date.now() - toMs(s.i.createdAt)) / 86400000) / DECAY_HALF_LIFE_DAYS))
    }
  }

  return scored.sort((a, b) => b.score - a.score)
}

function ours(item, qg) {
  const content = typeof item.similarity === "number" ? item.similarity : 0
  const tagList = Array.isArray(item.tags) ? item.tags : String(item.tags ?? "").split(",").filter(Boolean)
  const tagGrams = grams(tagList.join(" "))
  const tags = tagGrams.size ? overlap(tagGrams, qg) : 0
  const keyword = overlap(qg, grams(item.content ?? ""))
  const hasTags = tagGrams.size > 0
  const wSum = W_CONTENT + (hasTags ? W_TAGS : 0) + W_KEYWORD
  const base = (W_CONTENT * content + (hasTags ? W_TAGS * tags : 0) + W_KEYWORD * keyword) / wSum
  const days = Math.max(0, (Date.now() - toMs(item.createdAt)) / 86400000)
  const decay = item.isPinned ? 1 : Math.pow(0.5, days / DECAY_HALF_LIFE_DAYS)
  return base * decay
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
const rows = []

for (const { q, expect } of ALL) {
  const items = await search(q)
  const qg = grams(q)

  // 上游：纯向量相似度（API 返回顺序就是相似度降序）
  const up = items.map((i) => ({ i, s: i.similarity ?? 0 })).sort((a, b) => b.s - a.s)
  // 我们：加权打分（含图分）
  const our = rankOurs(items, qg)

  const findPos = (list) => list.findIndex((x) => String(x.i.content ?? "").includes(expect))
  const pu = findPos(up)
  const po = findPos(our)

  if (pu >= 0 && pu < K) upHit++
  if (po >= 0 && po < K) ourHit++
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
  rankOurs(items, qg)
    .slice(0, 8)
    .forEach((s, n) =>
      console.log(`  #${n + 1} score=${s.score.toFixed(4)} ${String(s.i.content).slice(0, 24)}`),
    )
}
