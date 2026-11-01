#!/usr/bin/env node
/**
 * gate.mjs — 发布前质量闸门。
 *
 * 跑 eval.mjs，检查两个硬指标：
 *   1. 召回@K 不得低于 --min-hit（默认 9）
 *   2. 平均名次不得高于 --max-avg（默认 3.0）
 *
 * 任一项不达标 → 退出码 1，可用于 CI / pre-push。
 *
 * 用法：
 *   node gate.mjs
 *   node gate.mjs --min-hit 10 --max-avg 2.5
 *   node gate.mjs --k 3 --cases data/facts-cases.json
 *
 * 前提：OpenCode 服务在跑（opencode-mem 的 web server 端口 4747 可访问）。
 */
import { execFileSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))

const arg = (name, def) => {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}

const MIN_HIT = Number(arg("--min-hit", "9"))
const MAX_AVG = Number(arg("--max-avg", "3.0"))
const K = arg("--k", "3")
const CASES = arg("--cases", "")
const DIR = arg("--dir", "")

const args = [join(HERE, "eval.mjs"), "--json", "--k", K]
if (CASES) args.push("--cases", CASES)
// 关键：eval 用 cwd 推项目 tag。从插件目录跑 npm 脚本时 cwd 是插件目录，
// 必须显式传 --dir，否则一个候选都检索不到。
if (DIR) args.push("--dir", DIR)

let raw
try {
  raw = execFileSync(process.execPath, args, { encoding: "utf-8" })
} catch (error) {
  console.error("gate: eval 运行失败 —", error.message)
  console.error("提示：先确认 OpenCode 在运行，且 opencode-mem 的 web server（默认 4747）可访问。")
  process.exit(2)
}

let result
try {
  result = JSON.parse(raw.trim().split("\n").pop())
} catch {
  console.error("gate: 无法解析 eval 输出：", raw.slice(0, 200))
  process.exit(2)
}

const { cases, ourHit, ourAvg, upHit, upAvg } = result
const okHit = ourHit >= MIN_HIT
const okAvg = ourAvg <= MAX_AVG
const pass = okHit && okAvg

console.log(`gate: ${cases} 用例，topK=${K}`)
console.log(`  召回：${ourHit} / ${cases}   要求 ≥ ${MIN_HIT}   ${okHit ? "PASS" : "FAIL"}`)
console.log(`  平均名次：${ourAvg}        要求 ≤ ${MAX_AVG}   ${okAvg ? "PASS" : "FAIL"}`)
console.log(`  参照基线（纯向量）：召回 ${upHit}/${cases}，平均名次 ${upAvg}`)
console.log(pass ? "\n=> 通过" : "\n=> 未通过")

process.exit(pass ? 0 : 1)
