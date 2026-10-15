// Read a TP-Link Easy Managed switch twice, 15 s apart, with the plugin's own
// code, and save the second report (which has traffic rates). Prompts for the
// password without echo; it is not written anywhere.
//
//   bun scripts/try-tplinkswitch.ts <switch ip> <output.json> [uplink ports, e.g. 4,5]
import { writeFileSync } from "node:fs"
import { createInterface } from "node:readline"
import { readSwitch, newSwitchState } from "../plugins/monitoring/TplinkSwitchPlugin.ts"

const [host, out, uplinks] = process.argv.slice(2)
if (!host || !out) { console.error("usage: bun scripts/try-tplinkswitch.ts <switch ip> <output.json> [uplink ports]"); process.exit(1) }
const ask = (q: string, hidden = false) => new Promise<string>((resolve) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true }) as any
  if (hidden) rl._writeToOutput = (s: string) => { if (s.includes(q)) process.stdout.write(s) }
  rl.question(q, (a: string) => { rl.close(); if (hidden) process.stdout.write("\n"); resolve(a) })
})
const username = (await ask("Switch username [admin]: ")) || "admin"
const password = await ask("Switch password (not shown): ", true)
const target = { host, username, password, uplinkPorts: uplinks ? uplinks.split(",").map(Number) : undefined }
const state = newSwitchState()
await readSwitch(target, {}, state)
console.log("first read ok; reading again in 15 s for traffic rates...")
await new Promise((r) => setTimeout(r, 15000))
const report = await readSwitch(target, {}, state)
writeFileSync(out, JSON.stringify(report, null, 2))
console.log(`saved the report to ${out}`)
