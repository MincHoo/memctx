#!/usr/bin/env node
/**
 * test.mjs — 一条命令跑完整回归（不需要真实记忆库）。
 *
 *   node test.mjs            # 全流程
 *   node test.mjs --keep     # 保留 fixture 数据便于排查
 *
 * 流程：
 *   1. 存储单元测试（records / supersedes / 行为边数学）
 *   2. 往隔离分片灌 fixtures/corpus.json（28 条，带 kind/condition/source）
 *   3. 对该分片生成邻接表（--out test-）
 *   4. 用 fixtures/cases.json 跑排序评估，断言召回率
 *   5. 清理
 *
 * 前提：OpenCode 在跑（opencode-mem 的 web server 可访问）。
 */
import { execFileSync } from "node:child_process"
import { readFileSync, rmSync, existsSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"

const HERE = dirname(fileURLToPath(import.meta.url))
const KEEP = process.argv.includes("--keep")
const FIXTURE_TAG = "opencode_project_00000000000000fe"
const FIXTURE_HASH = "00000000000000fe"
const STORE_DIR = join(tmpdir(), "memctx-test-store")
const SHARD = join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".opencode-mem", "data", "projects", `project_${FIXTURE_HASH}_shard_0.db`)

process.env.MEMCTX_DATA = STORE_DIR

const run = (args, opts = {}) => execFileSync(process.execPath, args, { encoding: "utf-8", ...opts })

let failed = 0
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`)
  if (!ok) failed++
}

// ---------------------------------------------------------------- 1. 存储单元测试

console.log("\n[1] sidecar 存储")
rmSync(STORE_DIR, { recursive: true, force: true })
mkdirSync(STORE_DIR, { recursive: true })

const store = await import("./lib/store.mjs")

store.upsertRecord("mem_a", { kind: "decision", condition: "条件A", source: "a.ts" })
store.upsertRecord("mem_b", { kind: "pitfall", condition: "条件B", source: "b.ts", supersedes: "mem_a" })
const recs = store.loadRecords()
check("写入两条记录", Object.keys(recs).length === 2, `count=${Object.keys(recs).length}`)
check("supersedes 让旧记录带上 validUntil", Boolean(recs.mem_a?.validUntil))
check("字段保留", recs.mem_b.kind === "pitfall" && recs.mem_b.source === "b.ts")

// 行为边：i、j 同轮出现 2 次，各自还在别的轮出现 → Jaccard = 2/(3+2-2)
store.appendUsage("s1", "t1", ["x", "y"])
store.appendUsage("s1", "t2", ["x", "y"])
store.appendUsage("s1", "t3", ["x"])
store.appendUsage("s1", "t4", ["y"])
const usage = store.loadUsage()
check("usage 行数", usage.length === 4, `rows=${usage.length}`)

const edges = store.behavioralEdges(usage, { minWeight: 0, topK: 5 })
const xy = edges.get("x")?.find((e) => e.id === "y")
// c_xy=2, c_x=3, c_y=3 → Jaccard = 2/4 = 0.5，刚写入衰减≈1
check("Jaccard 计算正确", xy && Math.abs(xy.w - 0.5) < 0.02, `w=${xy?.w?.toFixed(3)}`)
check("边对称", Boolean(edges.get("y")?.find((e) => e.id === "x")))

const decayed = store.behavioralEdges(
  [{ at: Date.now() - 90 * 86400000, session: "s", turn: "t", ids: ["p", "q"] }],
  { minWeight: 0 },
)
const pq = decayed.get("p")?.find((e) => e.id === "q")
check("90 天后权重减半", pq && pq.w > 0.45 && pq.w < 0.55, `w=${pq?.w?.toFixed(3)}`)

const merged = store.mergeEdges(
  { a: [{ id: "b", w: 0.3 }] },
  new Map([["a", [{ id: "b", w: 0.7 }]]]),
)
check("合并取较大权重", merged.get("a")[0].w === 0.7, `w=${merged.get("a")[0].w}`)

store.forgetRecord("mem_a")
check("forgetRecord 生效", !store.loadRecords().mem_a)

// ---------------------------------------------------------------- 2. 灌 fixture

console.log("\n[2] 灌入 fixture 语料")
store.saveRecords({}) // 清掉第 1 步的单元测试残留
const corpus = JSON.parse(readFileSync(join(HERE, "fixtures", "corpus.json"), "utf-8"))
const token = readFileSync(join(process.env.USERPROFILE ?? process.env.HOME, ".opencode-mem", ".auth-token"), "utf-8").trim()

let seeded = 0
const ids = []
for (const item of corpus) {
  const res = await fetch("http://127.0.0.1:4747/api/memories", {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-mem-token": token },
    body: JSON.stringify({ content: item.content, containerTag: FIXTURE_TAG, tags: item.tags ?? [], type: "memory" }),
  })
  const body = await res.json().catch(() => ({}))
  if (body?.data?.id) {
    ids.push(body.data.id)
    store.upsertRecord(body.data.id, {
      kind: item.kind,
      condition: item.condition,
      source: item.source,
    })
    seeded++
  }
}
check("语料写入成功", seeded === corpus.length, `${seeded}/${corpus.length}`)
check("sidecar 记录数与语料一致", Object.keys(store.loadRecords()).length === corpus.length)

if (seeded === 0) {
  console.error("\n没有任何记忆写入成功，检查 OpenCode 是否在运行。")
  process.exit(2)
}

// ---------------------------------------------------------------- 3. 邻接表

console.log("\n[3] 生成邻接表")
const graphOut = run([join(HERE, "graph.mjs"), "--db", SHARD, "--min", "0.62", "--out", "test-"])
const edgeCount = Number(/edges:\s+(\d+)/.exec(graphOut)?.[1] ?? 0)
const isolated = Number(/isolated:\s*(\d+)/.exec(graphOut)?.[1] ?? 0)
check("生成边", edgeCount > 0, `edges=${edgeCount} isolated=${isolated}`)

// ---------------------------------------------------------------- 4. 排序评估

console.log("\n[4] 排序评估")
const evalOut = run([
  join(HERE, "eval.mjs"),
  "--tag",
  FIXTURE_TAG,
  "--cases",
  join(HERE, "fixtures", "cases.json"),
  "--json",
  "--no-default",
])
const result = JSON.parse(evalOut.trim().split("\n").pop())
const hitRate = result.ourHit / result.cases
check("召回率 ≥ 80%", hitRate >= 0.8, `${result.ourHit}/${result.cases} avg=${result.ourAvg}`)
check("优于纯向量基线", result.ourHit >= result.upHit, `ours=${result.ourHit} base=${result.upHit}`)

// ---------------------------------------------------------------- 5. 清理

console.log("\n[5] 清理")
if (KEEP) {
  console.log(`  保留 fixture（--keep）：${STORE_DIR} / ${SHARD}`)
} else {
  let deleted = 0
  for (const id of ids) {
    const res = await fetch(`http://127.0.0.1:4747/api/memories/${id}`, {
      method: "DELETE",
      headers: { "x-opencode-mem-token": token },
    })
    if (res.ok) deleted++
  }
  check("fixture 记忆已软删", deleted === ids.length, `${deleted}/${ids.length}`)
  for (const f of ["test-neighbors.json", "test-Review_2026-11-01.md"]) {
    const p = join(HERE, "data", f)
    if (existsSync(p)) rmSync(p, { force: true })
  }
  rmSync(STORE_DIR, { recursive: true, force: true })
}

console.log(failed === 0 ? "\n=> 全部通过" : `\n=> ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
