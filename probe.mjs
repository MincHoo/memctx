#!/usr/bin/env node
/**
 * probe.mjs — 不启动 OpenCode，直接验证 opencode-mem 的本地检索 API。
 *
 * 用法：
 *   node probe.mjs                 # 默认查询
 *   node probe.mjs "查询内容"
 *   node probe.mjs --json "查询"    # 打印原始 JSON（排查字段用）
 *
 * 依赖：opencode-mem 的 web server 在跑（默认 http://127.0.0.1:4747）
 */
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const args = process.argv.slice(2)
const asJson = args.includes("--json")
const query = args.filter((a) => a !== "--json").join(" ") || "记忆架构"

const API_BASE = process.env.MEMCTX_API ?? "http://127.0.0.1:4747"
const TOKEN_FILE = process.env.MEMCTX_TOKEN_FILE ?? join(homedir(), ".opencode-mem", ".auth-token")

function token() {
  try {
    return readFileSync(TOKEN_FILE, "utf-8").trim()
  } catch {
    return ""
  }
}

const url = `${API_BASE}/api/search?q=${encodeURIComponent(query)}&pageSize=20`
const res = await fetch(url, {
  headers: { "x-opencode-mem-token": token() },
  signal: AbortSignal.timeout(15000),
})

if (!res.ok) {
  console.error(`HTTP ${res.status} ${res.statusText} — 检查 webServerEnabled / webServerPort / token`)
  process.exit(1)
}

const body = await res.json()
const items = body?.data?.items ?? body?.items ?? []

if (asJson) {
  console.log(JSON.stringify(items, null, 2))
} else {
  console.log(`query: ${query}`)
  console.log(`hits:  ${items.length}`)
  console.log(`keys:  ${items[0] ? Object.keys(items[0]).join(", ") : "-"}`)
  items.slice(0, 10).forEach((it, i) => {
    const sim = it?.similarity ?? it?.score
    const rel = typeof sim === "number" ? sim.toFixed(3) : "-"
    const text = String(it?.content ?? "").replace(/\s+/g, " ").slice(0, 80)
    console.log(`${String(i + 1).padStart(2)}. rel=${rel} ${it?.type ?? "?"}  ${text}`)
  })
}
