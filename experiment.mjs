#!/usr/bin/env node
/**
 * experiment.mjs — 往**真实分片**临时注入「通用工程常识」，测它对召回的影响，测完删掉。
 *
 *   node experiment.mjs --add     # 注入 20 条，id 记到 data/experiment-ids.json
 *   node experiment.mjs --clean   # 按记录的 id 逐条软删
 *
 * 注意：这是唯一会写真实分片的脚本，只用于实验，跑完必须 --clean。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join, normalize, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const API = "http://127.0.0.1:4747"
const TOKEN = readFileSync(join(homedir(), ".opencode-mem", ".auth-token"), "utf-8").trim()
const IDS_FILE = join(HERE, "data", "experiment-ids.json")
const TAG = "synthetic-common"

const dir = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "C:\\Users\\Cros\\Documents\\默认项目"
const tag = `opencode_project_${createHash("sha256").update(`path:${normalize(dir)}`).digest("hex").slice(0, 16)}`

const CORPUS = [
  "并发写同一个 SQLite 文件会返回 SQLITE_BUSY，写操作应当串行化或加重试。",
  "浮点数比较应使用误差范围，不要直接用等号判断相等。",
  "JSON.parse 遇到 undefined 会抛错，序列化前应先过滤掉无效字段。",
  "时间戳在不同接口里可能是毫秒数或 ISO 字符串，解析前应先判断类型。",
  "Windows 文件名不区分大小写，跨平台比较路径前需要归一化。",
  "HTTP 重定向默认不保留 POST 语义，客户端需要显式处理 307 与 308 的区别。",
  "正则表达式里的点号不匹配换行，跨行匹配需要开启 s 标志。",
  "Promise 并发数量应做池化，否则容易耗尽文件句柄。",
  "子进程不会自动继承父进程运行时修改的环境变量。",
  "缓存 TTL 设置过短会导致频繁回源，反而增加下游压力。",
  "读取大文件应使用流式处理，避免一次性载入内存。",
  "数据库索引会降低写入性能，需要权衡读写比例。",
  "UTF-8 文本在不同终端显示可能不同，但字节内容不变。",
  "单元测试不应依赖系统时间，否则会出现偶发失败。",
  "日志中不应包含密钥或个人身份信息。",
  "递归函数必须有终止条件，否则会栈溢出。",
  "跨域请求需要服务端设置 CORS 头，前端无法绕过。",
  "版本号应遵循语义化版本，破坏性变更需要升主版本号。",
  "文件写入后应调用 fsync，否则断电时可能丢失数据。",
  "依赖锁定文件应提交到版本库，保证构建可复现。",
]

async function addAll() {
  const ids = []
  for (const [i, content] of CORPUS.entries()) {
    const res = await fetch(`${API}/api/memories`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-opencode-mem-token": TOKEN },
      body: JSON.stringify({ content, containerTag: tag, tags: [TAG], type: "memory" }),
    })
    const body = await res.json().catch(() => ({}))
    if (body?.data?.id) ids.push(body.data.id)
    process.stdout.write(`\r  ${i + 1}/${CORPUS.length}`)
  }
  mkdirSync(dirname(IDS_FILE), { recursive: true })
  writeFileSync(IDS_FILE, JSON.stringify(ids, null, 2), "utf-8")
  console.log(`\nadded ${ids.length}, ids -> ${IDS_FILE}`)
}

async function cleanAll() {
  if (!existsSync(IDS_FILE)) {
    console.log("没有记录 id，无法清理")
    return
  }
  const ids = JSON.parse(readFileSync(IDS_FILE, "utf-8"))
  let ok = 0
  for (const id of ids) {
    const res = await fetch(`${API}/api/memories/${id}`, {
      method: "DELETE",
      headers: { "x-opencode-mem-token": TOKEN },
    })
    if (res.ok) ok++
  }
  console.log(`deleted ${ok}/${ids.length}`)
}

if (process.argv.includes("--clean")) await cleanAll()
else if (process.argv.includes("--add")) await addAll()
else console.log("usage: node experiment.mjs --add | --clean")
