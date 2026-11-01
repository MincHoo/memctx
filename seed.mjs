#!/usr/bin/env node
/**
 * seed.mjs — 往「隔离分片」灌合成记忆，用于规模与邻居质量的测试。
 *
 * 关键：containerTag 决定落到哪个分片。这里用 opencode_project_00000000000000aa，
 * 与真实项目分片（opencode_project_2cd172641ce59b9e）物理隔离，测完删文件即可。
 *
 * 用法：
 *   node seed.mjs             # 写入 50 条
 *   node seed.mjs --dry       # 只打印，不写入
 *   node seed.mjs --clean     # 尝试删除测试分片（需先停 OpenCode 服务）
 */
import { readFileSync, readdirSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const API_BASE = process.env.MEMCTX_API ?? "http://127.0.0.1:4747"
const TOKEN_FILE = join(homedir(), ".opencode-mem", ".auth-token")
const SHARD_DIR = join(homedir(), ".opencode-mem", "data", "projects")
const CONTAINER_TAG = "opencode_project_00000000000000aa"
const SHARD_HASH = "00000000000000aa"

const argv = process.argv.slice(2)
const DRY = argv.includes("--dry")
const CLEAN = argv.includes("--clean")

// ---------------------------------------------------------------- 语料

/** [内容, tags] —— 分 7 个簇，最后一簇是与技术无关的噪声，用于检验阈值是否会把无关内容连起来 */
const CORPUS = [
  // A. 记忆架构（8）
  ["稳定块在会话首轮由第一条用户消息检索 top-8 生成，整场会话保持不变，以保护前缀缓存。", "architecture,stable-block,cache"],
  ["动态小节每轮按当前问题检索，排除稳定块已有条目，最多补 3 条，追加到用户消息尾部。", "architecture,dynamic,injection"],
  ["打分公式为 0.5 内容相似 + 0.2 标签 + 0.15 关键词 + 0.15 图分，图分缺省时按剩余权重归一。", "architecture,scoring,formula"],
  ["时间衰减按 0.5 的（天数/180）次方计算，pin 住的记忆不参与衰减。", "architecture,decay,pin"],
  ["动态小节的注入阈值取本轮最高分的 75%，且不低于绝对下限 0.18。", "architecture,threshold,dynamic"],
  ["锚点漂移判定为连续两轮最相关记忆不在稳定块内，重锚上限每会话三次。", "architecture,reanchor,drift"],
  ["稳定块和动态小节都必须在每轮重新 push，因为 system 数组每次请求都会重建。", "architecture,hook,system"],
  ["邻接表放在 sidecar 的 neighbors.json，插件按 mtime 懒加载，60 秒内生效。", "architecture,graph,sidecar"],

  // B. 嵌入与检索（7）
  ["本地嵌入模型用 Xenova/bge-m3，1024 维，q8 量化，中文检索可用。", "embedding,bge-m3,chinese"],
  ["早期用 nomic-embed-text-v1 时中文查询全部返回 0，因为那是英文模型。", "embedding,pitfall,chinese"],
  ["上游检索 API 是 GET /api/search，需要 x-opencode-mem-token 请求头。", "api,search,auth"],
  ["token 文件位于 ~/.opencode-mem/.auth-token，首次运行自动生成。", "api,token,path"],
  ["bge-m3 对同域中文文本的相似度基线偏高，0.5 阈值几乎全连，取 0.68 更合理。", "retrieval,threshold,tuning"],
  ["余弦相似度在本地算，直接读 vector 列，4096 字节即 1024 个 float32。", "retrieval,cosine,vector"],
  ["检索结果会混入原始提问条目，需要按 type 过滤掉 prompt 类噪声。", "retrieval,filter,noise"],

  // C. 环境（6）
  ["本机通过 127.0.0.1:7897 的本地代理访问外网。", "env,proxy,network"],
  ["OpenCode 是 2.2.5 桌面版，插件从 npm 拉取后缓存在 ~/.cache/opencode/npm。", "env,opencode,version"],
  ["opencode-mem 的数据库是 libSQL（turso），每个项目一个 shard 文件。", "env,database,libsql"],
  ["分片路径形如 ~/.opencode-mem/data/projects/project_<16hex>_shard_0.db。", "env,path,shard"],
  ["Windows 上数据库文件可能被插件进程占用，删除分片前要先停服务。", "env,windows,lock"],
  ["桌面版改配置后必须完全退出再打开，普通重开窗口不会重新加载插件。", "env,restart,config"],

  // D. 协作规则（8）
  ["变更分三级：小改直接做，中改先说做什么，大改先出计划等确认。", "process,change,rule"],
  ["破坏性操作包括强推、硬重置、批量删除，执行前必须说明并等待确认。", "process,destructive,rule"],
  ["超过 100KB 的文本不得整体读入，先用 grep 定位行号再读区间。", "process,reading,rule"],
  ["工具输出被截断时先看预览，需要细节再按行区间读取。", "process,output,rule"],
  ["写记忆前先检索，相似度达到 0.75 就跳过，避免重复条目。", "process,memory,dedupe"],
  ["记忆条目控制在 500 字以内，只记技术内容，不记寒暄。", "process,memory,style"],
  ["脚本路径以脚本自身目录为基准，禁止依赖当前工作目录。", "process,script,path"],
  ["不打印也不写入密钥，需要引用时用环境变量占位。", "process,security,secret"],

  // E. 发布（6）
  ["上游仓库是 tickernelz/opencode-mem，MIT 许可，当前版本 2.39.0。", "release,upstream,license"],
  ["发布路线定为 C 起步 B 兜底：先做只读旁挂插件，必要时再 fork。", "release,strategy,roadmap"],
  ["插件以 npm 包形式发布，配置里写包名即可加载。", "release,npm,packaging"],
  ["发布前要锁上游版本，因为检索接口不是公开契约。", "release,pinning,risk"],
  ["README 需要面向陌生用户写安装、启用与回滚三步。", "release,docs,readme"],
  ["MIT 允许 fork 后发布，但要保留版权声明并换一个不与上游混淆的名字。", "release,license,fork"],

  // F. 近似重复（5）
  ["图分只在候选集内部计算，邻居不在候选里就不贡献分数。", "graph,candidates,scoring"],
  ["邻接表由 graph 脚本生成，只读分片库，输出邻居文件与评审报告。", "graph,tooling,report"],
  ["重锚会改变系统上下文，代价是一次全量重算，因此每会话限制三次。", "reanchor,cost,cache"],
  ["压缩时注入 5 条快照，目的是让摘要别丢结论，而不是给模型看。", "compaction,snapshot,summary"],
  ["记忆按项目分片存储，跨项目检索需要显式指定范围。", "storage,shard,scope"],

  // G. 无关噪声（10）—— 阈值若把它们连进来，说明阈值太低
  ["周末去菜市场买了西红柿和鸡蛋，准备做番茄炒蛋。", "life,shopping"],
  ["小区门口的咖啡店换了新豆子，酸度比之前高。", "life,coffee"],
  ["跑步五公里配速稳定在六分半，膝盖没有不适。", "life,running"],
  ["阳台的绿萝需要每周浇水一次，夏天要遮阴。", "life,plants"],
  ["地铁早高峰比平时拥挤，建议提前二十分钟出门。", "life,commute"],
  ["书房灯泡换成四千 K，看屏幕时眼睛舒服一些。", "life,lighting"],
  ["冰箱里的酸奶过期了，记得清理。", "life,housing"],
  ["周末计划去图书馆还书，顺便借两本设计类的。", "life,books"],
  ["楼下快递柜在晚上十点后不再开放取件。", "life,delivery"],
  ["冬天的羽绒服送去干洗，三天后取。", "life,laundry"],
]

// ---------------------------------------------------------------- 执行

function token() {
  try {
    return readFileSync(TOKEN_FILE, "utf-8").trim()
  } catch {
    return ""
  }
}

async function clean() {
  const files = readdirSync(SHARD_DIR).filter((f) => f.includes(SHARD_HASH))
  if (files.length === 0) {
    console.log("没有找到测试分片")
    return
  }
  for (const f of files) {
    try {
      rmSync(join(SHARD_DIR, f), { force: true })
      console.log(`deleted ${f}`)
    } catch (e) {
      console.log(`failed ${f}: ${e.message}（先退出 OpenCode 再试）`)
    }
  }
}

async function add(content, tags) {
  const res = await fetch(`${API_BASE}/api/memories`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opencode-mem-token": token(),
    },
    body: JSON.stringify({ content, containerTag: CONTAINER_TAG, tags, type: "memory" }),
    signal: AbortSignal.timeout(30000),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body?.success === false) {
    throw new Error(`HTTP ${res.status} ${JSON.stringify(body).slice(0, 120)}`)
  }
  return body?.data?.id
}

if (CLEAN) {
  await clean()
  process.exit(0)
}

if (DRY) {
  console.log(`would seed ${CORPUS.length} memories into ${CONTAINER_TAG}`)
  process.exit(0)
}

console.log(`seeding ${CORPUS.length} memories -> ${CONTAINER_TAG}`)
const started = Date.now()
let ok = 0
for (const [i, [content, tags]] of CORPUS.entries()) {
  try {
    await add(content, tags.split(","))
    ok++
    process.stdout.write(`\r  ${i + 1}/${CORPUS.length}`)
  } catch (e) {
    console.log(`\n  [${i + 1}] failed: ${e.message}`)
  }
}
console.log(`\ndone: ${ok}/${CORPUS.length} in ${((Date.now() - started) / 1000).toFixed(1)}s`)
console.log(`shard: ${join(SHARD_DIR, `project_${SHARD_HASH}_shard_0.db`)}`)
