// One-off probe for a TP-Link Omada Easy Managed (ES) switch's web API.
// Logs in, saves the read-only status responses to a JSON file, logs out.
// The password is read without echo and never written anywhere.
//
//   node scripts/probe-tplink-es.mjs <switch-ip> <output.json>
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const [host, out = 'tplink-es-probe.json'] = process.argv.slice(2)
if (!host) { console.error('usage: node scripts/probe-tplink-es.mjs <switch ip> [output.json]'); process.exit(1) }
const base = `http://${host}`
const headers = { 'Content-Type': 'application/json;charset=utf-8', 'X-Requested-With': 'XMLHttpRequest', SourceType: 'switch_web' }

function ask(q, hidden = false) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    if (hidden) rl._writeToOutput = (s) => { if (s.includes(q)) process.stdout.write(s) }
    rl.question(q, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a) })
  })
}

const user = (await ask('Switch username [admin]: ')) || 'admin'
const pass = await ask('Switch password (not shown): ', true)
const md5 = createHash('md5').update(pass).digest('hex').toUpperCase()

const login = await fetch(`${base}/login/status`, { method: 'POST', headers, body: JSON.stringify({ login_user: user, login_pwd: md5 }) }).then((r) => r.json())
if (login.error_code || !login.result?.token) {
  console.error(`Login refused (error_code ${login.error_code}). Stopping so the switch doesn't count more failed attempts.`)
  process.exit(1)
}
const auth = { ...headers, Authorization: login.result.token }

const READS = [
  '/device_name',
  '/modules/get_support_module_status',
  '/system_summary/system_information_status',
  '/system_summary/ip_settings_status',
  '/switching/port_settings_status',
  '/monitoring/port_list_status',
  '/port_list/port_and_lag_list_status',
  '/traffic_summary/traffic_summary_status',
  '/traffic_summary/traffic_summary_port_status',
  '/loop_detection/loop_detection_status',
  '/loop_detection/loop_prevention_status',
  '/poe/poe_config/global_cfg',
  '/poe/poe_config/perport_cfg',
  '/lag/lag_configuration_status',
  '/controller/get_controller_status',
]
const results = { login: { ...login.result, token: '(redacted)' } }
for (const path of READS) {
  try {
    results[path] = await fetch(base + path, { headers: auth }).then((r) => r.json())
  } catch (e) {
    results[path] = { probeError: String(e.message || e) }
  }
}
await fetch(`${base}/show_up/logout_status`, { method: 'POST', headers: auth, body: '{}' }).catch(() => {})

writeFileSync(out, JSON.stringify(results, null, 2))
console.log(`Saved ${READS.length} responses to ${out} and logged out.`)
