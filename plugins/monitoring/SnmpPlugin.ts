import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createMonitoringPlugin, MonitoringPluginBase } from "../../lib/MonitoringPlugin"

// SNMP monitor. First target class: printers (standard Printer-MIB) — model,
// serial, lifetime page count, and per-supply toner/consumable levels. Shells
// out to net-snmp's snmpget/snmpwalk (add `snmp` to the client image) rather
// than pulling an npm SNMP stack, matching the other CLI-backed plugins.
//
// One client_state per target (type "snmp-printer", uid snmp-<slug>). Severity
// is decided server-side (clientstate/update.put.ts): a supply at/under its
// warn threshold → warning; an error/offline printer status → error.

const pexec = promisify(execFile)

interface SnmpTarget {
  name: string
  ip: string
  kind?: "printer" // more kinds (switch, ups, …) later
  community?: string // default "public"
  version?: "1" | "2c" // default 2c
  tonerWarnPct?: number // supply level at/under this = warning (default 10)
}

interface SnmpConfig {
  targets?: SnmpTarget[]
  community?: string
  refreshInterval?: number
}

// Printer-MIB / HOST-RESOURCES OIDs
const OID = {
  model: "1.3.6.1.2.1.25.3.2.1.3.1",           // hrDeviceDescr
  serial: "1.3.6.1.2.1.43.5.1.1.17.1",          // prtGeneralSerialNumber
  pages: "1.3.6.1.2.1.43.10.2.1.4.1.1",         // prtMarkerLifeCount
  status: "1.3.6.1.2.1.25.3.5.1.1.1",           // hrPrinterStatus (3=idle,4=printing,5=warmup)
  supplyDesc: "1.3.6.1.2.1.43.11.1.1.6",        // prtMarkerSuppliesDescription (walk)
  supplyMax: "1.3.6.1.2.1.43.11.1.1.8",         // prtMarkerSuppliesMaxCapacity (walk)
  supplyLevel: "1.3.6.1.2.1.43.11.1.1.9",       // prtMarkerSuppliesLevel (walk)
}

const PRINTER_STATUS: Record<string, string> = { "1": "other", "2": "unknown", "3": "idle", "4": "printing", "5": "warmup" }

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "")
}

async function snmpGet(t: SnmpTarget, oid: string, timeout = 8000): Promise<string | null> {
  try {
    const { stdout } = await pexec(
      "snmpget",
      ["-v", t.version || "2c", "-c", t.community || "public", "-Ovq", "-t", "2", "-r", "1", t.ip, oid],
      { timeout },
    )
    const v = stdout.trim().replace(/^"|"$/g, "")
    return v && !/No Such|no response|Timeout/i.test(v) ? v : null
  } catch {
    return null
  }
}

async function snmpWalk(t: SnmpTarget, oid: string, timeout = 10000): Promise<string[]> {
  try {
    const { stdout } = await pexec(
      "snmpwalk",
      ["-v", t.version || "2c", "-c", t.community || "public", "-Oqv", "-t", "2", "-r", "1", t.ip, oid],
      { timeout },
    )
    return stdout.split("\n").map((l) => l.trim().replace(/^"|"$/g, "")).filter(Boolean)
  } catch {
    return []
  }
}

async function collectPrinter(t: SnmpTarget): Promise<any> {
  const warnPct = t.tonerWarnPct ?? 10
  const [model, serial, pagesRaw, statusRaw, descs, maxes, levels] = await Promise.all([
    snmpGet(t, OID.model),
    snmpGet(t, OID.serial),
    snmpGet(t, OID.pages),
    snmpGet(t, OID.status),
    snmpWalk(t, OID.supplyDesc),
    snmpWalk(t, OID.supplyMax),
    snmpWalk(t, OID.supplyLevel),
  ])

  // No response at all → the printer is unreachable / SNMP off.
  if (model == null && serial == null && pagesRaw == null && !descs.length) {
    return { name: t.name, ip: t.ip, kind: "printer", reachable: false }
  }

  // Pair descriptions with levels. prtMarkerSuppliesLevel semantics: -2 =
  // unknown, -3 = "some remaining" (a level the device won't quantify); else a
  // count out of MaxCapacity (which can itself be -2 = unknown).
  const supplies = descs.map((desc, i) => {
    const max = Number(maxes[i])
    const lvl = Number(levels[i])
    let pct: number | null = null
    if (lvl === -3) pct = 100 // "ok / some remaining"
    else if (lvl >= 0 && max > 0) pct = Math.round((lvl / max) * 100)
    return { name: desc, level: lvl, max, pct }
  })
  const low = supplies.filter((s) => s.pct != null && s.pct <= warnPct)

  return {
    name: t.name,
    ip: t.ip,
    kind: "printer",
    reachable: true,
    model: model || undefined,
    serial: serial || undefined,
    pages: pagesRaw != null ? Number(pagesRaw) : undefined,
    status: statusRaw != null ? PRINTER_STATUS[statusRaw] || statusRaw : undefined,
    supplies,
    lowSupplies: low.map((s) => ({ name: s.name, pct: s.pct })),
    warnPct,
  }
}

export function createSnmpPlugin() {
  let refreshTimer: any = null

  const targetsOf = (plugin: MonitoringPluginBase): SnmpTarget[] => {
    const cfg = (plugin.config || {}) as SnmpConfig
    return (Array.isArray(cfg.targets) ? cfg.targets : [])
      .filter((t) => t?.ip)
      .map((t) => ({ ...t, community: t.community || cfg.community || "public" }))
  }

  const refreshFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    await Promise.all(
      targetsOf(plugin).map(async (t) => {
        try {
          const data = t.kind === "printer" || !t.kind ? await collectPrinter(t) : { name: t.name, ip: t.ip, kind: t.kind }
          await plugin.send(data, `snmp-${slug(t.name || t.ip)}`)
        } catch (e: any) {
          await plugin.send({ name: t.name, ip: t.ip, kind: t.kind || "printer", error: String(e?.message || e).slice(0, 160) }, `snmp-${slug(t.name || t.ip)}`)
        }
      }),
    )
  }

  const monitorFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    await refreshFn(plugin)
    refreshTimer = setInterval(() => refreshFn(plugin), (plugin.config as SnmpConfig)?.refreshInterval || 300000)
  }

  const teardownFn = async (): Promise<void> => {
    if (refreshTimer) clearInterval(refreshTimer)
    refreshTimer = null
  }

  return createMonitoringPlugin(
    "snmp",
    "snmp",
    "SNMP monitor (printers: model, pages, toner levels)",
    async () => {},
    monitorFn,
    refreshFn,
    teardownFn,
  )
}

export default createSnmpPlugin
