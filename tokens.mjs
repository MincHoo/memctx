#!/usr/bin/env node
/**
 * tokens.mjs — 逐条列出某个会话里每次模型请求的 token 与缓存命中，用来验证「注入是否破坏前缀缓存」。
 *
 * 用法：node tokens.mjs <sessionID>
 * 只读打开 ~/.local/share/opencode/opencode.db，不修改任何数据。
 */
import { DatabaseSync } from "node:sqlite"
import { homedir } from "node:os"
import { join } from "node:path"

const id = process.argv[2]
if (!id) {
  console.error("usage: node tokens.mjs <sessionID>")
  process.exit(1)
}

const db = new DatabaseSync(join(homedir(), ".local", "share", "opencode", "opencode.db"), { readOnly: true })
const rows = db
  .prepare("select seq, data from session_message where session_id = ? and type = 'assistant' order by seq asc")
  .all(id)

console.log("seq    input   cacheR   cacheW   output   hit%")
for (const r of rows) {
  let d
  try {
    d = JSON.parse(r.data)
  } catch {
    continue
  }
  const t = d.tokens
  if (!t) continue
  const input = t.input ?? 0
  const cacheR = t.cache?.read ?? 0
  const cacheW = t.cache?.write ?? 0
  const out = t.output ?? 0
  const total = input + cacheR
  const hit = total > 0 ? ((cacheR / total) * 100).toFixed(1) : "-"
  console.log(
    `${String(r.seq).padEnd(6)} ${String(input).padStart(7)} ${String(cacheR).padStart(8)} ${String(cacheW).padStart(8)} ${String(out).padStart(8)} ${String(hit).padStart(6)}`,
  )
}
