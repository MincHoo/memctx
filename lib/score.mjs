/**
 * lib/score.mjs — 唯一的打分实现。
 *
 * 以前 index.ts 和 eval.mjs 各写一份，结果闸门和线上参数悄悄分叉
 * （eval 默认 λ=1、线上 λ=0.5，白测了一轮）。现在两边都调这里，
 * 任何权重/衰减/图分改动只改一处。
 */
import { personalizedPageRank } from "./rank.mjs"

const NOISE = /[\s\-_.,;:!?()[\]{}"'`~@#$%^&*+=|\\/<>，。；：！？（）【】「」『』、·…—]/g

export const SCORE_DEFAULTS = {
  wContent: 0.5,
  wTags: 0.2,
  wKeyword: 0.15,
  wGraph: 0.15,
  graphLambda: 1,
  decayHalfLifeDays: 180,
  graphMode: "max", // max | ppr
  pprDamping: 0.85,
  pprSeeds: 5,
  /** 内容去重的 MMR 强度：1=关闭；(0,1) 之间越小越强调多样性 */
  diversifyLambda: 1,
  hubFn: () => 1,
}

/** CJK 取 2-gram，拉丁取词。eval 与插件必须用同一套，否则关键词分不可比。 */
export function grams(text) {
  const clean = String(text ?? "")
    .toLowerCase()
    .replace(NOISE, " ")
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

export function overlap(a, b) {
  if (!a.size || !b.size) return 0
  let hit = 0
  for (const g of a) if (b.has(g)) hit++
  return hit / a.size
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const g of a) if (b.has(g)) inter++
  return inter / (a.size + b.size - inter)
}

/** API 的 createdAt 是 ISO 字符串；Number() 会得 NaN，静默废掉时间衰减。 */
export function toMs(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string") {
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : 0
  }
  return 0
}

export function daysSince(v, now = Date.now()) {
  const ms = toMs(v)
  if (!ms) return 0
  return Math.max(0, (now - ms) / 86_400_000)
}

function itemTags(item) {
  return Array.isArray(item?.tags)
    ? item.tags
    : typeof item?.tags === "string" && item.tags
      ? item.tags.split(",")
      : []
}

function scoreItem(item, queryGrams, opts) {
  const content = typeof item?.similarity === "number" ? item.similarity : 0
  const tagGrams = grams(itemTags(item).join(" "))
  const tags = tagGrams.size > 0 ? overlap(tagGrams, queryGrams) : 0
  const keyword = overlap(queryGrams, grams(item?.content ?? ""))
  const hasTags = tagGrams.size > 0
  const pinned = item?.isPinned === true || item?.isPinned === 1
  const decay = pinned ? 1 : Math.pow(0.5, daysSince(item?.createdAt) / opts.decayHalfLifeDays)
  const wSum = opts.wContent + (hasTags ? opts.wTags : 0) + opts.wKeyword
  const base = (opts.wContent * content + (hasTags ? opts.wTags * tags : 0) + opts.wKeyword * keyword) / wSum
  return {
    item,
    content,
    tags,
    keyword,
    hasTags,
    graph: 0,
    hasGraph: false,
    decay,
    score: base * decay * opts.hubFn(String(item?.id ?? "")),
  }
}

/**
 * 两遍排序：先基础分，再图分（max 或 PPR），最后可选的 MMR 多样性重排。
 * @returns {{item:any, content:number, tags:number, keyword:number, graph:number, hasTags:boolean, hasGraph:boolean, decay:number, score:number}[]}
 */
export function rankItems(items, query, neighbors, options = {}) {
  const opts = { ...SCORE_DEFAULTS, ...options }
  const qg = grams(query)
  const scored = items.map((it) => scoreItem(it, qg, opts))
  if (!neighbors) return scored.sort((a, b) => b.score - a.score)

  const baseSorted = scored.slice().sort((a, b) => b.score - a.score)
  let pprMass = null
  let pprScale = 1
  if (opts.graphMode === "ppr") {
    const seeds = new Map()
    for (const s of baseSorted.slice(0, opts.pprSeeds)) seeds.set(String(s.item?.id ?? ""), s.score)
    pprMass = personalizedPageRank(neighbors, seeds, { damping: opts.pprDamping })
    let maxMass = 0
    for (const v of pprMass.values()) if (v > maxMass) maxMass = v
    pprScale = maxMass > 0 ? (baseSorted[0]?.score ?? 0) / maxMass : 0
  }

  const byId = new Map(scored.map((s) => [String(s.item?.id ?? ""), s]))
  for (const s of scored) {
    const id = String(s.item?.id ?? "")
    let g = 0
    if (pprMass) {
      g = (pprMass.get(id) ?? 0) * pprScale
    } else {
      const edges = neighbors[id]
      if (!edges || edges.length === 0) continue
      for (const e of edges) {
        const other = byId.get(e.id)
        if (other) g = Math.max(g, e.w * other.score)
      }
    }
    g *= opts.graphLambda
    if (g <= 0) continue

    const wSum = opts.wContent + (s.hasTags ? opts.wTags : 0) + opts.wKeyword + opts.wGraph
    const base =
      (opts.wContent * s.content + (s.hasTags ? opts.wTags * s.tags : 0) + opts.wKeyword * s.keyword + opts.wGraph * g) /
      wSum
    s.graph = g
    s.hasGraph = true
    s.score = base * s.decay * opts.hubFn(id)
  }

  const sorted = scored.sort((a, b) => b.score - a.score)
  return opts.diversifyLambda >= 1 ? sorted : diversify(sorted, opts.diversifyLambda)
}

/**
 * MMR 多样性重排：每轮在「相关度」和「与已选条目的最大相似度」之间折中。
 * 相似度用内容 2-gram 的 Jaccard（纯本地，不需要向量）。
 * lambda=1 时退化为原始顺序；越小越强调多样性。
 */
export function diversify(sorted, lambda = 0.7) {
  if (sorted.length <= 1) return sorted
  const gramsList = sorted.map((s) => grams(s.item?.content ?? ""))
  const picked = []
  const used = new Set()
  const maxScore = sorted[0]?.score || 1
  while (picked.length < sorted.length) {
    let best = -1
    let bestVal = -Infinity
    for (let i = 0; i < sorted.length; i++) {
      if (used.has(i)) continue
      let maxSim = 0
      for (const j of picked) {
        const sim = jaccard(gramsList[i], gramsList[j])
        if (sim > maxSim) maxSim = sim
      }
      const rel = (sorted[i].score || 0) / maxScore
      const val = lambda * rel - (1 - lambda) * maxSim
      if (val > bestVal) {
        bestVal = val
        best = i
      }
    }
    used.add(best)
    picked.push(best)
  }
  return picked.map((i) => sorted[i])
}
