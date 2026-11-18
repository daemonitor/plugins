// Run: bun test/docker-removed.check.ts
// A project that drops out of `docker ps -a` is reported removed once; a failed
// listing reports nothing.
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, chmodSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { createDockerPlugin } from "../plugins/monitoring/DockerPlugin.ts"

const dir = mkdtempSync(join(tmpdir(), "docker-removed-"))
const ps = join(dir, "ps.txt")
const bin = join(dir, "docker")
// Fake engine: `ps` prints ps.txt (or fails when it holds FAIL), everything else prints nothing.
writeFileSync(bin, `#!/bin/sh\nif [ "$1" = ps ]; then grep -q FAIL "${ps}" && exit 1; cat "${ps}"; fi\nexit 0\n`)
chmodSync(bin, 0o755)

const plugin = createDockerPlugin()
plugin.config = { dockerBin: bin }
let sent: { id: string; removed: boolean }[] = []
plugin.send = async (data: any, id?: string) => { sent.push({ id: id!, removed: !!data.removed }) }
await plugin.setup()

const round = async (lines: string) => { writeFileSync(ps, lines); sent = []; await plugin.refresh(); return sent }
const row = (id: string, name: string, project = "") => `${id}|${name}|img|running|Up 1 minute|${project}|${project ? "svc" : ""}\n`

assert.deepEqual(await round(row("a", "app-web-1", "app") + row("b", "ci_postgres16_1")), [
  { id: "docker-app", removed: false }, { id: "docker-ci_postgres16_1", removed: false },
])
assert.deepEqual(await round(row("a", "app-web-1", "app")), [
  { id: "docker-app", removed: false }, { id: "docker-ci_postgres16_1", removed: true },
], "gone from the listing: removed once")
assert.deepEqual(await round(row("a", "app-web-1", "app")), [{ id: "docker-app", removed: false }], "not repeated")
assert.deepEqual(await round("FAIL"), [], "a failed listing removes nothing")
assert.deepEqual(await round(row("a", "app-web-1", "app")), [{ id: "docker-app", removed: false }], "still there after a failure")
console.log("docker-removed check: ok")
