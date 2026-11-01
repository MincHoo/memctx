#!/usr/bin/env node
/**
 * doctor.mjs — 装了没反应时，先跑这个。
 *
 *   node doctor.mjs                       # 检查当前目录对应的项目
 *   node doctor.mjs --dir C:\path\to\proj # 指定项目
 *
 * 退出码：0 全部正常；1 有 fail；2 环境问题（连不上服务器）。
 */
import { readFileSync, existsSync, statSync } from "node:fs"
import { createHash } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { homedir } from "node:os"
import { join, normalize, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const HOME = homedir()
const API = process.env.MEMCTX_API ?? "http://127.0.0.1:4747"
const TOKEN_FILE = join(HOME, ".opencode-mem", ".auth-token")
const NEIGHBORS = process.env.MEMCTX_NEIGHBORS ?? join(HERE, "data", "neighbors.json")
const RECORDS = join(HERE, "data", "records.json")
const USAGE = join(HERE, "data", "coactivation.jsonl")
const OPENCODE_CFG = join(HOME, ".config", "opencode", "opencode.json")
const MEM_CFG = join(HOME, ".config", "opencode", "opencode-mem.jsonc")

const argv = process.argv.slice(2)
const dir = (() => {
  const i = argv.indexOf("--dir")
  return i >= 0 && argv[i + 1] ? argv[i + 1] : process.cwd()
})()

let fails = 0
let warns = 0
const ok = (name, detail = "") => console.log(`  [ok]    ${name.padEnd(18)} ${detail}`)
const warn = (name, detail = "") => {
  warns++
  console.log(`  [warn]  ${name.padEnd(18)} ${detail}`)
}
const bad = (name, detail = "") => {
  fails++
  console.log(`  [fail]  ${name.padEnd(18)} ${detail}`)
}

/** 去掉 JSONC 注释与尾逗号，尽量宽容地解析。 */
function parseJsonc(text) {
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, "")
  const noLine = noBlock.replace(/(^|[^:])\/\/.*$/gm, "$1")
  return JSON.parse(noLine.replace(/,(\s*[}\]])/g, "$1"))
}

function projectTag(d) {
  const hash = createHash("sha256").update(`path:${normalize(d)}`).digest("hex").slice(0, 16)
  return { tag: `opencode_project_${hash}`, hash }
}

console.log(`\nopencode-memctx doctor\n  项目目录: ${dir}\n`)

// 1. Node 版本
const [major, minor] = process.versions.node.split(".").map(Number)
if (major > 22 || (major === 22 && minor >= 5)) ok("node", process.versions.node)
else bad("node", `${process.versions.node}（需要 ≥ 22.5，node:sqlite 依赖）`)

// 2. 插件是否配置
if (!existsSync(OPENCODE_CFG)) {
  warn("opencode.json", "找不到全局配置")
} else {
  try {
    const cfg = parseJsonc(readFileSync(OPENCODE_CFG, "utf-8"))
    const list = Array.isArray(cfg.plugins) ? cfg.plugins : []
    const hit = list.some((p) => String(p).toLowerCase().includes("memctx"))
    hit ? ok("plugin 已配置", "plugins[] 含 memctx") : bad("plugin 未配置", "把本目录绝对路径加进 plugins[]")
    if (list.some((p) => String(p).includes("opencode-mem"))) ok("上游插件", "opencode-mem 已配置")
    else warn("上游插件", "没看到 opencode-mem —— 本插件依赖它的检索接口")
  } catch (e) {
    warn("opencode.json", `解析失败：${e.message}`)
  }
}

// 3. 上游注入是否关闭
if (!existsSync(MEM_CFG)) {
  warn("opencode-mem.jsonc", "找不到配置")
} else {
  try {
    const cfg = parseJsonc(readFileSync(MEM_CFG, "utf-8"))
    const enabled = cfg?.chatMessage?.enabled
    if (enabled === false) ok("上游注入", "已关闭（chatMessage.enabled=false）")
    else bad("上游注入仍开着", "会注入两份记忆；设 chatMessage.enabled=false")
    if (cfg?.webServerEnabled === false) bad("web server", "webServerEnabled=false，检索接口不可用")
    else ok("web server 配置", `port=${cfg?.webServerPort ?? 4747} host=${cfg?.webServerHost ?? "127.0.0.1"}`)
  } catch (e) {
    warn("opencode-mem.jsonc", `解析失败：${e.message}`)
  }
}

// 4. token
let token = ""
if (!existsSync(TOKEN_FILE)) bad("token 文件", "不存在，OpenCode 首次运行后才会生成")
else {
  token = readFileSync(TOKEN_FILE, "utf-8").trim()
  token ? ok("token 文件", `${token.length} 字符`) : bad("token 文件", "内容为空")
}

// 5. 项目 tag 与分片
const { tag, hash } = projectTag(dir)
const shard = join(HOME, ".opencode-mem", "data", "projects", `project_${hash}_shard_0.db`)
console.log(`  [info]  project tag        ${tag}`)
if (existsSync(shard)) {
  const mb = (statSync(shard).size / 1024 / 1024).toFixed(1)
  ok("分片文件", `${mb} MB`)
} else {
  warn("分片不存在", "这个项目还没有记忆；第一次写入后才会有")
}

// 6. 服务连通性 + 检索冒烟
let reachable = false
try {
  const h = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(3000) })
  const body = await h.json()
  reachable = true
  ok("web server", `${API} status=${body?.status ?? "?"}`)
} catch (e) {
  bad("web server 连不上", `${API} — OpenCode / opencode-mem 没在运行？`)
}

if (reachable && token) {
  try {
    const url = `${API}/api/search?q=${encodeURIComponent("test")}&pageSize=3&tag=${encodeURIComponent(tag)}`
    const res = await fetch(url, { headers: { "x-opencode-mem-token": token }, signal: AbortSignal.timeout(10000) })
    if (res.status === 401) bad("检索鉴权", "401 — token 不匹配")
    else if (!res.ok) bad("检索接口", `HTTP ${res.status}`)
    else {
      const body = await res.json()
      const n = (body?.data?.items ?? []).length
      n > 0 ? ok("检索冒烟", `返回 ${n} 条`) : warn("检索冒烟", "0 条（该项目可能还没有记忆）")
    }
  } catch (e) {
    bad("检索接口", String(e).slice(0, 80))
  }
}

// 7. sidecar
if (existsSync(NEIGHBORS)) {
  try {
    const g = JSON.parse(readFileSync(NEIGHBORS, "utf-8"))
    const nodes = g?.nodes ?? Object.keys(g?.neighbors ?? {}).length
    const ageH = ((Date.now() - statSync(NEIGHBORS).mtimeMs) / 3600000).toFixed(1)
    ageH > 72
      ? warn("邻接表", `${nodes} 节点，${ageH} 小时前生成 —— 建议重跑 node graph.mjs`)
      : ok("邻接表", `${nodes} 节点，${ageH} 小时前`)
  } catch {
    bad("邻接表", "解析失败，重跑 node graph.mjs")
  }
} else {
  warn("邻接表缺失", "图分不会生效；跑 node graph.mjs 生成")
}

if (existsSync(RECORDS)) {
  try {
    const n = Object.keys(JSON.parse(readFileSync(RECORDS, "utf-8"))).length
    ok("结构化记录", `${n} 条（memctx_add 写入的）`)
  } catch {
    warn("records.json", "解析失败")
  }
} else {
  info0("结构化记录", "0 条（用 memctx_add 写过才会有）")
}

// 7.5 数据完整性：向量/正文/标签/类型/图覆盖/孤儿记录（只读，不改数据）
if (existsSync(shard)) {
  try {
    const db = new DatabaseSync(shard, { readOnly: true })
    const rows = db
      .prepare("select id, type, content, tags, vector from memories where deleted_at is null")
      .all()
    db.close()

    const live = rows.filter((r) => r.type !== "prompt") // prompt 是上游捕获的用户提问，检索时过滤，不算缺口
    // 维度不写死：换嵌入模型后是 384/768/1024 都可能，只要求「非空、4 字节对齐、全库一致」
    const vecLens = [...new Set(rows.map((r) => (r.vector ? r.vector.length : 0)))]
    const badVec = rows.filter((r) => !r.vector || r.vector.length === 0 || r.vector.length % 4 !== 0).length
    const mixedDim = vecLens.filter((n) => n > 0).length > 1
    const dims = vecLens.filter((n) => n > 0).map((n) => n / 4)
    const emptyText = rows.filter((r) => !String(r.content ?? "").trim()).length
    const noTag = live.filter((r) => !String(r.tags ?? "").trim()).length
    const noType = live.filter((r) => !r.type).length

    badVec === 0 && !mixedDim
      ? ok("向量完整性", `${rows.length}/${rows.length}（${dims.join("/") || "?"} 维）`)
      : bad("向量完整性", badVec ? `${badVec} 条向量缺失或长度异常` : `维度不一致：${dims.join(" / ")}（换模型后需迁移）`)
    emptyText > 0 ? bad("正文完整性", `${emptyText} 条正文为空`) : null

    const tagRatio = live.length ? (live.length - noTag) / live.length : 1
    tagRatio >= 0.8
      ? ok("标签覆盖率", `${live.length - noTag}/${live.length}（${Math.round(tagRatio * 100)}%）`)
      : warn("标签覆盖率", `${live.length - noTag}/${live.length} 条有标签；无标签的记忆排序会吃亏`)

    if (noType > live.length * 0.5) info0("类型缺失", `${noType}/${live.length} 条 type 为空（多为自动捕获，不影响检索）`)

    if (existsSync(NEIGHBORS)) {
      try {
        const g = JSON.parse(readFileSync(NEIGHBORS, "utf-8"))
        const known = new Set(Object.keys(g?.neighbors ?? {}))
        const missing = live.filter((r) => !known.has(r.id)).length
        const ratio = live.length ? missing / live.length : 0
        missing === 0
          ? ok("邻接表覆盖", `${known.size} 节点，无缺口`)
          : missing >= 10 || ratio >= 0.2
            ? warn("邻接表滞后", `${missing} 条未覆盖（≥10 或 ≥20% 会自动重算；也可手动 node graph.mjs --tag ${tag}）`)
            : ok("邻接表覆盖", `${known.size} 节点，${missing} 条待覆盖（未达重算阈值）`)

        const recs = existsSync(RECORDS) ? JSON.parse(readFileSync(RECORDS, "utf-8")) : {}
        const ids = new Set(rows.map((r) => r.id))
        const orphans = Object.keys(recs).filter((id) => !ids.has(id)).length
        orphans > 0 ? warn("孤儿记录", `${orphans} 条结构化记录找不到对应记忆`) : ok("记录引用", "无孤儿")
      } catch {
        /* 邻接表本身已在上面单独检查 */
      }
    }
  } catch (e) {
    warn("数据完整性", `读取分片失败：${String(e).slice(0, 60)}`)
  }
}

if (existsSync(USAGE)) {
  const lines = readFileSync(USAGE, "utf-8").split("\n").filter(Boolean).length
  const ageMin = ((Date.now() - statSync(USAGE).mtimeMs) / 60000).toFixed(0)
  ok("共现日志", `${lines} 行，最近 ${ageMin} 分钟前`)
} else {
  info0("共现日志", "还没有（用过一轮对话才会产生）")
}

function info0(name, detail) {
  console.log(`  [info]  ${name.padEnd(18)} ${detail}`)
}

// 8. 日志文件
const logFile = join(HOME, ".opencode-mem", "spike-memctx.log")
if (existsSync(logFile)) {
  const ageMin = ((Date.now() - statSync(logFile).mtimeMs) / 60000).toFixed(0)
  ageMin > 60
    ? warn("插件日志", `最近更新在 ${ageMin} 分钟前 —— 插件可能没在跑`)
    : ok("插件日志", `最近 ${ageMin} 分钟内有写入`)
} else {
  bad("插件日志缺失", "插件从未加载过")
}

console.log(
  fails > 0
    ? `\n=> ${fails} 项失败${warns ? `，${warns} 项警告` : ""}`
    : warns > 0
      ? `\n=> 可用，${warns} 项警告`
      : "\n=> 一切正常",
)
process.exit(fails > 0 ? 1 : 0)
