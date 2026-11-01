#!/usr/bin/env node
/**
 * check.mjs — 看邻居质量：最高权重的边、跨簇的边、孤立节点。
 * 用法：node check.mjs [neighbors.json 路径] [--db 分片路径]
 */
import { DatabaseSync } from "node:sqlite"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const argv = process.argv.slice(2)
const file = argv.find((a) => a.endsWith(".json")) ?? join("data", "neighbors.json")
const dbIdx = argv.indexOf("--db")
const dbArg = dbIdx >= 0 ? (argv[dbIdx + 1] ?? "") : ""
const dbPath = dbArg || join(homedir(), ".opencode-mem", "data", "projects", "project_00000000000000aa_shard_0.db")

const graph = JSON.parse(readFileSync(file, "utf-8"))
const db = new DatabaseSync(dbPath, { readOnly: true })
const rows = db.prepare("select id, content, tags from memories where deleted_at is null").all()
const text = new Map(rows.map((r) => [r.id, String(r.content ?? "")]))
const tagsOf = new Map(rows.map((r) => [r.id, String(r.tags ?? "").split(",").filter(Boolean)]))

const LIFE = new Set(["life"])
const isLife = (id) => tagsOf.get(id)?.some((t) => LIFE.has(t)) ?? false
const clip = (s, n = 42) => String(s).replace(/\s+/g, " ").slice(0, n)

// 去重边
const seen = new Set()
const edges = []
for (const [a, list] of Object.entries(graph.neighbors)) {
  for (const e of list) {
    const key = [a, e.id].sort().join("|")
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({ a, b: e.id, w: e.w })
  }
}
edges.sort((x, y) => y.w - x.w)

const deg = Object.entries(graph.neighbors).map(([id, l]) => ({ id, d: l.length }))
const isolated = deg.filter((x) => x.d === 0).length
const avg = (deg.reduce((s, x) => s + x.d, 0) / deg.length).toFixed(1)

console.log(`nodes=${deg.length} edges=${edges.length} isolated=${isolated} avgDegree=${avg}`)

const crossLife = edges.filter((e) => isLife(e.a) !== isLife(e.b))
console.log(`\n跨「生活/技术」边：${crossLife.length} 条${crossLife.length ? "（应为 0，>0 说明阈值过低）" : ""}`)
crossLife.slice(0, 5).forEach((e) => console.log(`  ${e.w.toFixed(3)} ${clip(text.get(e.a))} ↔ ${clip(text.get(e.b))}`))

const sameLife = edges.filter((e) => isLife(e.a) && isLife(e.b)).length
console.log(`生活簇内部边：${sameLife} 条（生活条目彼此无关，理想为 0）`)

console.log("\n最高权重 10 条：")
edges.slice(0, 10).forEach((e) =>
  console.log(`  ${e.w.toFixed(3)}  ${clip(text.get(e.a), 34)}  ↔  ${clip(text.get(e.b), 34)}`),
)

console.log("\n孤立节点：")
deg
  .filter((x) => x.d === 0)
  .forEach((x) => console.log(`  ${clip(text.get(x.id), 46)}`))
