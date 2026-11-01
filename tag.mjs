import { createHash } from "node:crypto"
import { join, normalize } from "node:path"
import { existsSync } from "node:fs"
import { homedir } from "node:os"

const dir = process.argv[2] ?? "C:\\Users\\Cros\\Documents\\默认项目"
const identity = `path:${normalize(dir)}`
const hash = createHash("sha256").update(identity).digest("hex").slice(0, 16)
const tag = `opencode_project_${hash}`
const shard = join(homedir(), ".opencode-mem", "data", "projects", `project_${hash}_shard_0.db`)
console.log("identity:", identity)
console.log("tag:     ", tag)
console.log("shard:   ", shard)
console.log("exists:  ", existsSync(shard))
