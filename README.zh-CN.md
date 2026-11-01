# opencode-memctx

> 给 [opencode-mem](https://github.com/tickernelz/opencode-mem) 换一套上下文注入方式：**每轮都拿到新鲜记忆，同时不破坏提示词缓存。**
>
> English: [README.md](./README.md) · 开发日志（中文）：[NOTES.md](./NOTES.md)

`opencode-mem` 原本只有两个坏选择：注入最新记忆（前缀稳定，但内容陈旧），或者每轮把向量检索结果写回系统提示（内容新鲜，但前缀一变，整段对话就要重新计费）。这个插件走第三条路：

- **稳定块**：会话第一句话检索 top-8，按会话缓存，每次请求内容完全一致 → 前缀缓存不失效。
- **每轮小尾巴**：一小段相关记忆追加到**用户消息末尾**（不是系统提示），只有新消息本身不同。新鲜，但不重算。
- **打分**：`0.5 内容 + 0.2 标签 + 0.15 关键词 + 0.15 图`，乘 180 天半衰期（pin 的记忆不衰减）。
- **图重排**：邻接表由存储的向量离线算出（`neighbors.json`）。
- **重锚**：如果「最相关的记忆」连续两轮都不在稳定块里，就按新话题重建（每会话最多 3 次）。
- **压缩快照**：把关键记忆塞进压缩请求，避免摘要丢掉结论。

它**不 fork** `opencode-mem`：只读它的本地 REST 接口，不往它的数据库写任何东西。

---

## 环境要求

| | |
|---|---|
| OpenCode | 2.2.5 及以上（需要 V2 插件 API：`Plugin.define`、`session.hook`） |
| opencode-mem | 2.39.x，web server 已开且只监听本机（默认 `127.0.0.1:4747`） |
| Node | ≥ 22.5（图工具用内置的 `node:sqlite`） |

## 安装

1. 把本目录放在一个固定的位置（本地插件按目录加载，任何路径都行）：

   ```powershell
   git clone <本仓库地址> C:\Users\你\opencode-memctx
   ```

   > 不要既放进 `~/.config/opencode/plugins/` 又在 `plugins` 里写一遍——那个目录会被自动扫描，会加载两次。

2. 加进 `~/.config/opencode/opencode.json`（`plugins` 数组，用绝对路径）：

   ```jsonc
   {
     "plugins": [
       "opencode-mem@latest",
       "/absolute/path/to/opencode-memctx"
     ]
   }
   ```

3. 关掉上游自己的注入，否则上下文里会有两份记忆：

   ```jsonc
   // ~/.config/opencode/opencode-mem.jsonc
   "chatMessage": { "enabled": false }
   ```

4. **完全退出**再打开 OpenCode（桌面版要退出进程，不是关窗口）。配置改动重启才生效。

### 验证

```powershell
Get-Content "$env:USERPROFILE\.opencode-mem\spike-memctx.log" -Tail 5
```

正常会看到：

```
setup v2: api=http://127.0.0.1:4747 token=ok graph=… scope=opencode_project_…
stable session=… hash=… n=8 ids=… anchor="…"
sys session=… hash=… parts=5 bytes=…
```

如果对话之后没有新行，说明插件没加载，去翻 OpenCode 服务日志里的 `loading plugin`。

### 装了没反应？先跑自检

```powershell
node doctor.mjs --dir C:\你的\项目目录
```

逐项检查：node 版本、插件配置、上游注入是否还开着、token、项目 tag 与分片、检索接口、邻接表、sidecar 存储，最后给出一行结论：

```
  [ok]    web server         http://127.0.0.1:4747 status=ok
  [ok]    检索冒烟               返回 3 条
  [warn]  邻接表缺失           图分不会生效；跑 node graph.mjs 生成
=> 可用，1 项警告
```

### 回滚

把 `chatMessage.enabled` 改回 `true`，从 `plugins` 里删掉路径，重启。插件除了自己的日志文件外不写任何东西。

---

## 工具

全部是独立脚本，不需要构建：

| 命令 | 作用 |
|---|---|
| `node probe.mjs "查询"` | 直接调上游检索接口，打印命中与相似度 |
| `node graph.mjs` | 重建邻接表（`data/neighbors.json`）并出人工抽查报告 |
| `node check.mjs data/neighbors.json` | 邻居质量：最高权重边、跨簇边、孤立节点 |
| `node eval.mjs` | 与「纯向量排序」做 A/B |
| `node gate.mjs --dir <项目目录>` | 发布闸门：召回或平均名次退步就失败 |
| `node test.mjs` | 全量自测（用 fixture 语料，不需要真实记忆） |
| `node doctor.mjs --dir <项目目录>` | 诊断「装了但没反应」 |
| `node tokens.mjs <sessionID>` | 单会话逐次请求的输入量/缓存命中率 |
| `node seed.mjs` / `--clean` | 往**隔离分片**灌合成记忆，做规模测试 |
| `node tag.mjs [目录]` | 打印某个目录对应的 container tag 与分片路径 |

## 结构化记忆与行为边

两个 sidecar 文件，上游数据库始终只读：

| 文件 | 内容 |
|---|---|
| `data/records.json` | 按记忆 id 存 `kind / condition / source / validUntil / supersedes` |
| `data/coactivation.jsonl` | 每轮一行：这一轮同时注入了哪些记忆 |

插件注册了一个工具 **`memctx_add`**，写入时带上这些字段：

```
memctx_add(content, kind, condition, source, tags?, supersedes?)
```

注入时会渲染出来（`(decision, rel 0.39)` … `↳ 条件: …；来源: …`）；被取代（有 `validUntil`）的记录不再注入，但仍可查询。

行为边在读取时现算：

```
w(i,j) = Jaccard(i,j) × 0.5^(Δt / 90 天)
```

再与结构边按「取较大权重」合并。

> 注意：`records.json` 只覆盖通过 `memctx_add` 写入的记忆。用普通 `memory` 工具写的条目照常工作，只是没有条件/来源可渲染。

## 不依赖真实数据的自测

```powershell
npm test
```

往隔离容器灌 28 条 fixture 记忆，生成邻接表，跑 22 个用例，断言召回率，最后全部删除。不碰你的真实记忆，所以换台机器也能跑（需要 OpenCode + opencode-mem 在运行）。

## 评估

14 个真实问题，对比「纯向量顺序」（上游打分里的主导项）与本插件的排序。数字会随语料规模变化，两次都列出来：

```
15 条记忆   纯向量     召回@3: 10/14   平均名次 3.8
            本插件     召回@3: 12/14   平均名次 2.1

27 条记忆   纯向量     召回@3:  9/14   平均名次 6.1
            本插件     召回@3: 10/14   平均名次 2.4
```

语料越大差距越小（候选变多、竞争变强），但本插件两项都占优。

`gate.mjs` 把它变成通过/失败。判据是**相对上游纯向量**（绝对名次会随语料膨胀漂移），并附带配对显著性：

```
gate: 14 用例，topK=3
  相对判定（主判据，对比上游纯向量）
    召回：11 vs 6   PASS
    平均名次：2.93 vs 18.93   PASS
  绝对兜底（只保留召回地板，防两边一起烂）
    召回：11 / 14   要求 ≥ 7   PASS
  统计（配对差异是否可信）
    召回 95% CI：52.4%–92.4%（11/14）
    McNemar：仅我们命中 5，仅上游命中 0，p=0.06（差异不显著）

=> 通过
```

发布前跑一次：

```powershell
node gate.mjs --dir C:\path\to\the\project\whose\memories\you\evaluate
```

`--dir` 不能省：脚本按目录推算项目的 container tag，从插件目录里跑（`cwd` 变了）会算错、检索不到任何候选。它需要活着的 OpenCode + opencode-mem，所以是本地发布前检查，不适合当 CI。

### 独立评估集（held-out）

上面的 14 + 15 例是**开发集**，已被用于挑权重，不再无偏。`fixtures/heldout-2026-11.json` 是 33 条由三个独立子代理按记忆导出材料出的题，调参期间从未使用。

```powershell
npm run heldout:check -- --dir <项目> fixtures/heldout-2026-11.json          # 完整性校验
node gate.mjs --no-default --cases fixtures/heldout-2026-11.json --dir <项目>  # 发布前跑一次
```

规则：用前先校验，**每次发布只跑一次**，不许拿它调参，结果与文件 SHA-256 一起记录（见 `NOTES.md` §12.6）。

### 调参前该知道的两件事

- **通用常识会拖后腿。** 注入 20 条靠谱的工程常识后，召回@3 从 `11/14` 掉到 `10/14`，平均名次从 `2.2` 崩到 `9.7`。它们对任何查询都「有点相关」，会均匀挤掉真正的答案。
- **图分必须阻尼。** `max(边权 × 邻居分)` 会让相邻节点互相抬轿子；λ = 1.0 在 51 条语料上实测最好（0.5 时盲测掉到 7/15）。

## 配置

常量在 `index.ts` 顶部，排序权重在 `lib/score.mjs`。支持的环境变量：

| 环境变量 | 默认值 | 含义 |
|---|---|---|
| `MEMCTX_API` | `http://127.0.0.1:4747` | opencode-mem web server 地址 |
| `MEMCTX_NEIGHBORS` | `./data/neighbors.json` | 邻接表路径 |
| `MEMCTX_EXPAND` | `2` | 图候选扩展跳数（`0` 关闭） |
| `MEMCTX_EXPAND_SEEDS` | `5` | 用 API 前几名做扩展种子 |
| `MEMCTX_EXPAND_MAX` | `20` | 最多补入多少条候选外记忆 |
| `MEMCTX_GRAPHMODE` | `max` | `max` 或 `ppr` |
| `MEMCTX_PPR_DAMPING` | `0.85` | PPR 阻尼（仅 ppr 模式） |
| `MEMCTX_PPR_SEEDS` | `5` | PPR 种子数 |
| `MEMCTX_DEDUP` | `1` | MMR 多样性强度；`1` = 关闭 |
| `MEMCTX_HUB_ALPHA` | `0` | hub 抑制强度；`0` = 关闭（实测负收益） |

可调项：`STABLE_K`(8)、`DYNAMIC_K`(3)、权重 `W_CONTENT/W_TAGS/W_KEYWORD/W_GRAPH`、`GRAPH_LAMBDA`(1)、`DECAY_HALF_LIFE_DAYS`(180)、`DRIFT_TURNS`(2)、`MAX_REANCHORS`(3)。

## 已知限制

- 稳定块锚在会话**第一句**上；重锚是启发式的，且会让缓存失效一次（全量重算）。
- `/api/search` 是私有契约。请锁上游版本，路由一变召回会静默失效。
- 每轮的小尾巴写进了用户消息，会留在对话记录里（每轮约 100–200 token）。
- 扩展进来的候选没有查询向量分，只能靠 BM25 补，纯改写场景会偏弱。
- PPR 与 MMR 已实现，但在 ~50 条语料上实测负收益，默认关闭。
- `neighbors.json` 是手动跑 `graph.mjs` 生成的，不是持续更新。
- Windows 上 OpenCode 运行时会锁住分片文件，删除前必须先退出。

## 许可证

MIT。`opencode-mem` 本身是 tickernelz 的 MIT 项目；本项目是独立伴生插件，不是 fork。
