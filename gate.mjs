#!/usr/bin/env node
/**
 * gate.mjs — 发布前质量闸门。
 *
 * 跑 eval.mjs，按两层判定：
 *   1) 相对层（主判据）：召回不低于上游纯向量，且平均名次不差于上游。
 *   2) 绝对兜底：召回 ≥ --min-hit，平均名次 ≤ --max-avg（默认 15 = 30 条候选的前一半，宽松）。
 *
 * 为什么以相对为主：绝对名次随语料膨胀必然变差（42 条时上游自己就掉到 13.4），
 * 用固定阈值会把"语料变多"误判成"排序退化"。绝对层只用来发现两边一起崩的情况。
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

const MIN_HIT_ARG = arg("--min-hit", "")
const MAX_AVG = Number(arg("--max-avg", "15.0"))
const K = arg("--k", "3")
const CASES = arg("--cases", "")
const DIR = arg("--dir", "")

const args = [join(HERE, "eval.mjs"), "--json", "--k", K]
if (CASES) args.push("--cases", CASES)
// 关键：eval 用 cwd 推项目 tag。从插件目录跑 npm 脚本时 cwd 是插件目录，
// 必须显式传 --dir，否则一个候选都检索不到。
if (DIR) args.push("--dir", DIR)
// 只跑指定用例集（不叠加内置 14 例），用于盲测回归
if (process.argv.includes("--no-default")) args.push("--no-default")
// 候选扩展开关透传给 eval（0=关闭；1/2=图扩展跳数）
for (const name of ["--expand", "--eseeds", "--emax", "--gmode", "--pd", "--ps", "--gl", "--dedup"]) {
  const i = process.argv.indexOf(name)
  if (i >= 0 && process.argv[i + 1]) args.push(name, process.argv[i + 1])
}

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

const { cases, ourHit, ourAvg, upHit, upAvg, ourHits = [], upHits = [] } = result

// Wilson 95% 置信区间：33 条用例时一条就是 3 个百分点，必须给区间
function wilson(x, n, z = 1.96) {
  if (!n) return [0, 0]
  const p = x / n
  const denom = 1 + (z * z) / n
  const centre = (p + (z * z) / (2 * n)) / denom
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom
  return [Math.max(0, centre - half), Math.min(1, centre + half)]
}

// McNemar 精确检验（双侧）：只比较两边结论不一致的配对
function binomTwoSided(b, c) {
  const n = b + c
  if (n === 0) return 1
  const choose = (n, k) => {
    let r = 1
    for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i
    return r
  }
  let tail = 0
  for (let k = Math.max(b, c); k <= n; k++) tail += choose(n, k) * Math.pow(0.5, n)
  return Math.min(1, 2 * tail)
}

// 召回地板也随用例数走（默认 50%），因为"召回@3 的绝对值"同样会随语料增长而下降
const MIN_HIT = MIN_HIT_ARG ? Number(MIN_HIT_ARG) : Math.ceil(cases * 0.5)

// 判定分两层：
//  1) 相对层（决定成败）：必须不比上游差——召回不低于上游，平均名次不差于上游。
//     理由：绝对名次会随语料膨胀必然变差（42 条时上游自己就掉到 13.4），
//     而我们要证明的是「比同类系统更准」，不是「名次一定小于某个常数」。
//  2) 绝对层（宽松兜底，防"一起烂"）：召回 ≥ MIN_HIT，平均名次 ≤ MAX_AVG。
//     绝对值只用于发现"两边都崩"的极端情况，不作为主要判据。

const okHit = ourHit >= MIN_HIT
const okAvg = ourAvg <= MAX_AVG
const relHit = ourHit >= upHit
const relAvg = ourAvg <= upAvg
const relBetter = ourHit > upHit || ourAvg < upAvg
// 平均名次只做参考、不参与判定：它不是稳定量（语料每加一条，旧目标的绝对名次就会后移），
// 拿它当绝对阈值会把"记忆变多"误判成"排序退化"。绝对层只保留召回地板。
const pass = relHit && relAvg && okHit
const mark = (b) => (b ? "PASS" : "FAIL")

console.log(`gate: ${cases} 用例，topK=${K}`)
console.log("  相对判定（主判据，对比上游纯向量）")
console.log(`    召回：${ourHit} vs ${upHit}   ${mark(relHit)}${relHit && !relBetter ? "（持平）" : ""}`)
console.log(`    平均名次：${ourAvg} vs ${upAvg}   ${mark(relAvg)}`)
console.log("  绝对兜底（只保留召回地板，防两边一起烂）")
console.log(`    召回：${ourHit} / ${cases}   要求 ≥ ${MIN_HIT}   ${mark(okHit)}`)
console.log(`    平均名次：${ourAvg}  （参考值 ≤ ${MAX_AVG}，不参与判定）   ${okAvg ? "在范围内" : "已超出，仅提示"}`)

if (ourHits.length === cases && upHits.length === cases) {
  const [lo, hi] = wilson(ourHit, cases)
  let onlyOurs = 0
  let onlyUp = 0
  for (let i = 0; i < cases; i++) {
    if (ourHits[i] && !upHits[i]) onlyOurs++
    else if (!ourHits[i] && upHits[i]) onlyUp++
  }
  const p = binomTwoSided(onlyOurs, onlyUp)
  console.log("  统计（配对差异是否可信）")
  console.log(
    `    召回 95% CI：${(lo * 100).toFixed(1)}%–${(hi * 100).toFixed(1)}%（${ourHit}/${cases}）`,
  )
  console.log(
    `    McNemar：仅我们命中 ${onlyOurs}，仅上游命中 ${onlyUp}，p=${p.toFixed(2)}` +
      (p >= 0.05 ? "（差异不显著）" : "（差异显著）"),
  )
}
if (relHit && relAvg && !relBetter && !(okHit && okAvg)) {
  console.log("  提示：相对指标持平，但绝对兜底不达标——检查语料是否过脏或检索是否退化。")
}
console.log(pass ? "\n=> 通过" : "\n=> 未通过")

process.exit(pass ? 0 : 1)
