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
import { readFileSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, normalize, dirname } from "node:path"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"

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

/**
 * 统计每个分片的「活跃 / 软删」条数。
 * 背景：opencode-mem 2.39.0 的 re-embed 迁移在 SELECT 时漏掉 deleted_at，
 * 重建后所有软删记忆会复活（实测 3 个分片 613 条）。迁移前后必须比对。
 */
function shardCounts(shards) {
  const out = []
  for (const shard of shards ?? []) {
    try {
      const db = new DatabaseSync(shard.dbPath, { readOnly: true })
      try {
        const active = db.prepare("SELECT COUNT(*) c FROM memories WHERE deleted_at IS NULL").get().c
        const deleted = db.prepare("SELECT COUNT(*) c FROM memories WHERE deleted_at IS NOT NULL").get().c
        out.push({ shardId: shard.shardId, dbPath: shard.dbPath, active: Number(active), deleted: Number(deleted) })
      } finally {
        db.close()
      }
    } catch (e) {
      out.push({ shardId: shard.shardId, dbPath: shard.dbPath, error: String(e).slice(0, 120) })
    }
  }
  return out
}

/** 迁移自动留下的迁移前快照：project_xxx_shard_0.db.pre-reembed-<pid>-<ts>.bak */
function findPreReembedBackup(dbPath) {
  try {
    const dir = dirname(dbPath)
    const base = dbPath.split(/[\\/]/).pop()
    const candidates = readdirSync(dir)
      .filter((f) => f.startsWith(base + ".pre-reembed-") && f.endsWith(".bak"))
      .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    return candidates.length ? join(dir, candidates[0].f) : null
  } catch {
    return null
  }
}

function deletedIdsFromBackup(dbPath) {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      return db
        .prepare("SELECT id FROM memories WHERE deleted_at IS NOT NULL")
        .all()
        .map((r) => String(r.id))
    } finally {
      db.close()
    }
  } catch {
    return []
  }
}


console.log("\n[1] 检测维度是否与当前配置一致")
const det = await call("/api/migration/detect")
const d = det.body?.data ?? det.body
console.log(JSON.stringify(d, null, 2))

if (argv.includes("--verify-only")) {
  // 与迁移检测无关：直接扫全部分片，看活跃/软删是否与预期一致
  const dir = join(homedir(), ".opencode-mem", "data", "projects")
  const shards = readdirSync(dir)
    .filter((f) => /^project_.*_shard_0\.db$/.test(f))
    .map((f) => {
      const m = f.match(/^project_(.+)_shard_0\.db$/)
      return { shardId: m?.[1] ?? f, dbPath: join(dir, f) }
    })
  console.log("\n--verify-only：各分片活跃/软删")
  for (const s of shardCounts(shards)) {
    console.log(`  ${String(s.shardId).padEnd(20)} active=${s.active} deleted=${s.deleted}${s.error ? " error=" + s.error : ""}`)
  }
  process.exit(0)
}

if (!d?.needsMigration) {
  console.log("=> 已经一致，无需迁移（若刚改过配置，确认重启过 OpenCode）")
  process.exit(0)
}
if (DRY) {
  console.log("\n--dry-run：到此为止，未执行迁移")
  process.exit(0)
}

console.log(`\n[2] 执行迁移 strategy=${STRATEGY}（可能耗时几十秒）`)
const before = shardCounts(d?.shardMismatches)
console.log("  迁移前活跃/软删：" + before.map((s) => `${s.shardId}:${s.active ?? "?"}/${s.deleted ?? "?"}`).join("  "))
const run = await call("/api/migration/run", { method: "POST", body: JSON.stringify({ strategy: STRATEGY }) })
const r = run.body?.data ?? run.body
console.log(JSON.stringify(r, null, 2))
if (!r?.success) {
  console.error("迁移失败，先别继续。分片备份在 ~/.opencode-mem/backup-*/")
  process.exit(1)
}

// ---- 迁移后校验：上游 re-embed 会丢掉 deleted_at，软删记忆会全部复活
const after = shardCounts(d?.shardMismatches)
const lost = before
  .filter((b) => typeof b.deleted === "number")
  .map((b) => {
    const a = after.find((x) => x.shardId === b.shardId)
    return { ...b, afterDeleted: a?.deleted ?? 0, afterActive: a?.active ?? 0 }
  })
  .filter((x) => x.afterDeleted < x.deleted)

if (lost.length > 0) {
  const totalLost = lost.reduce((s, x) => s + (x.deleted - x.afterDeleted), 0)
  console.error("\n⚠️  迁移把软删记忆复活了（上游 opencode-mem 2.39.0 的已知缺陷：re-embed 的 SELECT 漏 deleted_at）")
  for (const x of lost) console.error(`  shard ${x.shardId}: 软删 ${x.deleted} → ${x.afterDeleted}（活跃 ${x.active} → ${x.afterActive}）`)
  console.error(`  合计复活 ${totalLost} 条。`)

  if (argv.includes("--restore-deleted")) {
    console.log("\n[2b] --restore-deleted：按 *.pre-reembed-*.bak 里的 deleted_at 精确软删还原")
    let restored = 0
    for (const x of lost) {
      const bak = findPreReembedBackup(x.dbPath)
      if (!bak) {
        console.error(`  shard ${x.shardId}: 找不到 pre-reembed 备份，跳过`)
        continue
      }
      const ids = deletedIdsFromBackup(bak)
      for (let i = 0; i < ids.length; i += 40) {
        const res = await call("/api/memories/bulk-delete", {
          method: "POST",
          body: JSON.stringify({ ids: ids.slice(i, i + 40), cascade: false }),
        })
        restored += Number(res.body?.data?.deleted ?? 0)
      }
      console.log(`  shard ${x.shardId}: 备份 ${bak.split(/[\\/]/).pop()} → 软删 ${ids.length} 条`)
    }
    const check = shardCounts(d?.shardMismatches)
    console.log("  还原后活跃/软删：" + check.map((s) => `${s.shardId}:${s.active}/${s.deleted}`).join("  "))
    console.log(`  本次共软删 ${restored} 条；如与预期不符，先别继续，查 ~/.opencode-mem/data/projects/*.pre-reembed-*.bak`)
  } else {
    console.error("  已中止后续步骤。两种处理方式：")
    console.error("    1) 自动还原：重跑并加 --restore-deleted")
    console.error("    2) 手工还原：用 *.pre-reembed-*.bak 里 deleted_at 非空的 id，POST /api/memories/bulk-delete")
    process.exit(2)
  }
} else {
  console.log("\n  迁移后校验：软删数量一致，未发现复活 ✅")
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
