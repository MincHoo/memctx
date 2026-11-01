#!/usr/bin/env node
/**
 * switch-embedding.mjs — 换嵌入模型后的迁移助手。
 *
 * 用途：改完 opencode-mem.jsonc 的 embeddingModel/Dimensions/Pooling/Prefix 并**重启 OpenCode**之后，
 * 用它把已有记忆按新模型重新嵌入、重建邻接表，并给出验收命令。
 *
 * 为什么必须重启：嵌入服务在插件加载时读取配置，改文件不会热生效。
 *
 * 用法：
 *   node switch-embedding.mjs --dir "C:\Users\Cros\Documents\默认项目" [--strategy re-embed]
 *   node switch-embedding.mjs --dry-run        # 只看检测结果，不动数据
 *
 * strategy：
 *   re-embed     逐条用新模型重新计算向量（默认，保留记忆）
 *   fresh-start  归档旧分片、从空库开始（会丢全部记忆，慎用）
 */
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, normalize, dirname } from "node:path"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const API = process.env.MEMCTX_API ?? "http://127.0.0.1:4747"
const TOKEN = (() => {
  try {
    return readFileSync(join(homedir(), ".opencode-mem", ".auth-token"), "utf-8").trim()
  } catch {
    return ""
  }
})()

const argv = process.argv.slice(2)
const arg = (name, def) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}
const DIR = arg("--dir", process.cwd())
const STRATEGY = arg("--strategy", "re-embed")
const DRY = argv.includes("--dry-run")

const projectTag = (dir) => {
  // 必须与 index.ts 完全一致：normalize() 后的原样路径（Windows 上是反斜杠、保留大小写）
  const hash = createHash("sha256").update(`path:${normalize(dir)}`).digest("hex").slice(0, 16)
  return { tag: `opencode_project_${hash}`, hash }
}

const call = async (path, init = {}) => {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-opencode-mem-token": TOKEN, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(600_000),
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

const { tag, hash } = projectTag(DIR)
console.log(`项目: ${DIR}\ntag:  ${tag}`)

console.log("\n[1] 检测维度是否与当前配置一致")
const det = await call("/api/migration/detect")
const d = det.body?.data ?? det.body
console.log(JSON.stringify(d, null, 2))
if (!d?.needsMigration) {
  console.log("=> 已经一致，无需迁移（若刚改过配置，确认重启过 OpenCode）")
  process.exit(0)
}
if (DRY) {
  console.log("\n--dry-run：到此为止，未执行迁移")
  process.exit(0)
}

console.log(`\n[2] 执行迁移 strategy=${STRATEGY}（可能耗时几十秒）`)
const run = await call("/api/migration/run", { method: "POST", body: JSON.stringify({ strategy: STRATEGY }) })
const r = run.body?.data ?? run.body
console.log(JSON.stringify(r, null, 2))
if (!r?.success) {
  console.error("迁移失败，先别继续。分片备份在 ~/.opencode-mem/backup-*/")
  process.exit(1)
}

console.log("\n[3] 重建邻接表（新模型的相似度分布不同，阈值可能要重调）")
try {
  const out = execFileSync(process.execPath, [join(HERE, "graph.mjs"), "--tag", tag], { encoding: "utf-8" })
  console.log(out.split("\n").filter(Boolean).slice(-6).join("\n"))
} catch (e) {
  console.error("graph.mjs 失败：", String(e).slice(0, 200))
}

console.log("\n[4] 下一步（手动跑，看数字再决定去留）")
console.log(`  node doctor.mjs --dir "${DIR}"`)
console.log(`  node gate.mjs --dir "${DIR}"`)
console.log(`  node gate.mjs --no-default --cases fixtures/cases-blind.json --dir "${DIR}"`)
console.log("\n回滚：改回 bge-m3 + 删掉 dimensions/pooling/prefix 覆盖，重启，再从分片备份恢复：")
console.log("  ~/.opencode-mem/backup-*/project_*_shard_0.db")
