/**
 * lib/rank.mjs — 图传播（PPR）与词法打分（BM25），纯本地、无第三方依赖。
 *
 * 为什么需要：
 *   1) /api/search 只返回 30 条候选，掉出候选的记忆靠重排永远捞不到；
 *      候选扩展能把它们按 id 补进来，但扩展项拿不到 query 向量（e5 的 query/passage
 *      是两个前缀子空间，用候选向量反推查询向量实测 RMSE 0.11，不可用），
 *      所以内容分改用本地 BM25 补。
 *   2) 固定 k 跳 BFS 在稠密图上等价于噪声扩散（e5 下两两余弦最低 0.84）。
 *      HippoRAG 一类工作用的是 Personalized PageRank：按种子分布传播、
 *      阻尼 0.85，天然抑制远距离扩散。这里实现同一个思路。
 */

/**
 * Personalized PageRank。
 * @param {Record<string, {id: string, w: number}[]>} edges 邻接表
 * @param {Map<string, number>} seeds 种子节点 → 权重（内部会归一化）
 * @param {{damping?: number, iters?: number}} [opts]
 * @returns {Map<string, number>} 节点 → 质量（未归一化）
 */
export function personalizedPageRank(edges, seeds, { damping = 0.85, iters = 20 } = {}) {
  const nodes = new Set(Object.keys(edges ?? {}))
  for (const id of seeds.keys()) nodes.add(id)
  const ids = [...nodes]
  if (ids.length === 0) return new Map()

  const totalSeed = [...seeds.values()].reduce((a, b) => a + Math.max(0, b), 0)
  const seedVec = new Map()
  for (const [id, w] of seeds) seedVec.set(id, totalSeed > 0 ? Math.max(0, w) / totalSeed : 1 / seeds.size)

  // 行归一化：每个节点把自己的质量按边权分给邻居
  const out = new Map()
  for (const id of ids) {
    const list = (edges[id] ?? []).filter((e) => e && e.id)
    const sum = list.reduce((a, e) => a + Math.max(0, Number(e.w) || 0), 0)
    out.set(
      id,
      sum > 0 ? list.map((e) => [e.id, Math.max(0, Number(e.w) || 0) / sum]) : [],
    )
  }

  let p = new Map(ids.map((id) => [id, seedVec.get(id) ?? 0]))
  for (let step = 0; step < iters; step++) {
    const next = new Map(ids.map((id) => [id, 0]))
    for (const id of ids) {
      const mass = p.get(id) ?? 0
      if (mass <= 0) continue
      for (const [to, share] of out.get(id) ?? []) {
        next.set(to, (next.get(to) ?? 0) + mass * share)
      }
    }
    for (const id of ids) {
      next.set(id, (1 - damping) * (seedVec.get(id) ?? 0) + damping * (next.get(id) ?? 0))
    }
    p = next
  }
  return p
}

/**
 * BM25 索引。调用方传入与检索侧一致的 tokenizer（CJK 用 2-gram、拉丁用词）。
 * @param {{id: string, content: string}[]} docs
 * @param {(text: string) => Set<string>} tokenizer
 */
export function buildBm25(docs, tokenizer, { k1 = 1.2, b = 0.75 } = {}) {
  const N = docs.length || 1
  const df = new Map()
  const postings = new Map() // token → Map(docId → tf)
  const lens = new Map()

  for (const doc of docs) {
    const toks = [...tokenizer(doc.content ?? "")]
    lens.set(doc.id, toks.length)
    const tf = new Map()
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1)
    for (const [t, n] of tf) {
      if (!postings.has(t)) postings.set(t, new Map())
      postings.get(t).set(doc.id, n)
      df.set(t, (df.get(t) ?? 0) + 1)
    }
  }

  const avgdl = [...lens.values()].reduce((a, b) => a + b, 0) / N || 1
  const idf = new Map()
  for (const [t, n] of df) idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)))

  return {
    /** @returns Map<string, number> 原始 BM25 分（未归一化） */
    score(text) {
      const out = new Map()
      for (const t of tokenizer(text ?? "")) {
        const plist = postings.get(t)
        if (!plist) continue
        const w = idf.get(t) ?? 0
        for (const [id, tf] of plist) {
          const dl = lens.get(id) ?? avgdl
          const denom = tf + k1 * (1 - b + (b * dl) / avgdl)
          out.set(id, (out.get(id) ?? 0) + (w * tf * (k1 + 1)) / denom)
        }
      }
      return out
    },
    size: docs.length,
  }
}

/** 把原始分缩放到 [0,1]（按本次查询的最大值）。没有候选时返回空表。 */
export function normalizeScores(scores) {
  let max = 0
  for (const v of scores.values()) if (v > max) max = v
  if (max <= 0) return new Map()
  const out = new Map()
  for (const [id, v] of scores) out.set(id, v / max)
  return out
}
