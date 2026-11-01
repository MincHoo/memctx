#!/usr/bin/env node
/**
 * heldout-check.mjs — 独立评估集的机械校验 + 合并。
 *
 *   node heldout-check.mjs fixtures/heldout-part-glm.json [...]
 *   node heldout-check.mjs --merge fixtures/heldout-2026-11.json fixtures/part-*.json
 *   node heldout-check.mjs --dir "C:\path\to\proj" <files...>
 *
 * 检查项：
 *   1) expect 在活跃记忆里恰好命中 1 条（0 条=失效，≥2 条=不唯一）
 *   2) 目标记忆未软删、未被 validUntil 取代
 *   3) 同一文件内 targetId / q / expect 不重复
 *   4) 层配比统计
 *
 * 退出码：0 全部通过；1 有错误。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join, normalize, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const arg = (name, def) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}
const DIR = arg("--dir", process.cwd())
const FILES = argv.filter((a, i) => !a.startsWith("--") && !String(argv[i - 1] ?? "").startsWith("--"))

const hash = createHash("sha256").update(`path:${normalize(DIR)}`).digest("hex").slice(0, 16)
const TAG = arg("--tag", `opencode_project_${hash}`)
const DB = join(homedir(), ".opencode-mem", "data", "projects", `project_${TAG.replace(/^opencode_project_/, "")}_shard_0.db`)
if (!existsSync(DB)) {
  console.error(`找不到分片：${DB}\n用 --dir 指定记忆所属项目。`)
  process.exit(1)
}

const db = new DatabaseSync(DB, { readOnly: true })
const memories = db
  .prepare("SELECT id, content, type, tags FROM memories WHERE deleted_at IS NULL")
  .all()
  .map((r) => ({ id: String(r.id), content: String(r.content ?? "") }))
db.close()

const records = (() => {
  try {
    return JSON.parse(readFileSync(join(HERE, "data", "records.json"), "utf-8"))
  } catch {
    return {}
  }
})()

const errors = []
const warnings = []
const merged = []
const seenTarget = new Map()
const REPEAT_MAX = Number(arg("--repeat", "1"))
const seenQ = new Set()
const layerCount = {}
const perFile = []

for (const file of FILES) {
  let cases
  try {
    cases = JSON.parse(readFileSync(file, "utf-8"))
  } catch (e) {
    errors.push(`${file}: JSON 解析失败 ${e.message}`)
    continue
  }
  if (!Array.isArray(cases)) {
    errors.push(`${file}: 顶层必须是数组`)
    continue
  }
  const stat = { file, n: cases.length, ok: 0 }
  for (const [idx, c] of cases.entries()) {
    const where = `${file}#${idx + 1}`
    const q = String(c?.q ?? "").trim()
    const expect = String(c?.expect ?? "").trim()
    if (!q || !expect) {
      errors.push(`${where}: q / expect 不能为空`)
      continue
    }
    if (expect.length < 6) warnings.push(`${where}: expect 只有 ${expect.length} 字，容易撞车`)
    const hits = memories.filter((m) => m.content.includes(expect))
    if (hits.length === 0) {
      errors.push(`${where}: expect 在活跃记忆里找不到 → 「${expect}」`)
      continue
    }
    if (hits.length > 1) {
      errors.push(`${where}: expect 命中 ${hits.length} 条（不唯一）→ 「${expect}」`)
      continue
    }
    const target = hits[0]
    if (c.targetId && String(c.targetId) !== target.id) {
      errors.push(`${where}: targetId 不符（给的 ${c.targetId}，实际 ${target.id}）`)
      continue
    }
    if (records[target.id]?.validUntil) {
      errors.push(`${where}: 目标记忆已被取代（validUntil）→ ${target.id}`)
      continue
    }
    const used = seenTarget.get(target.id) ?? 0
    if (used >= REPEAT_MAX) {
      errors.push(`${where}: targetId 重复超过 ${REPEAT_MAX} 次 → ${target.id}`)
      continue
    }
    if (seenQ.has(q)) {
      errors.push(`${where}: 问题重复 → 「${q}」`)
      continue
    }
    seenTarget.set(target.id, used + 1)
    seenQ.add(q)
    stat.ok++
    const layer = String(c.layer ?? "unknown")
    layerCount[layer] = (layerCount[layer] ?? 0) + 1
    merged.push({ q, expect, layer, note: String(c.note ?? ""), targetId: target.id })
  }
  perFile.push(stat)
}

console.log("\n独立评估集校验")
console.log(`  项目: ${DIR}\n  tag:  ${TAG}\n  活跃记忆: ${memories.length}\n`)
for (const s of perFile) {
  const flag = s.ok === s.n ? "ok" : "有错误"
  console.log(`  ${s.file}: ${s.ok}/${s.n} 通过（${flag}）`)
}
console.log(`  覆盖目标: ${seenTarget.size} 条不同记忆；允许每目标最多 ${REPEAT_MAX} 题`)
console.log("\n  层配比:", Object.entries(layerCount).map(([k, v]) => `${k}=${v}`).join("  ") || "（无）")
if (warnings.length) {
  console.log("\n  警告:")
  for (const w of warnings) console.log("   -", w)
}
if (errors.length) {
  console.log("\n  错误:")
  for (const e of errors) console.log("   -", e)
}

const out = arg("--merge", "")
if (out) {
  const sha = createHash("sha256").update(JSON.stringify(merged)).digest("hex").slice(0, 16)
  writeFileSync(out, JSON.stringify(merged, null, 2), "utf-8")
  console.log(`\n  合并写入: ${out}`)
  console.log(`  条数: ${merged.length}  sha256(内容): ${sha}`)
}

console.log(errors.length ? "\n=> 未通过，按上面错误修正后重跑" : "\n=> 通过")
process.exit(errors.length ? 1 : 0)
