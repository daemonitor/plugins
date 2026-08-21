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
  kind?: "printer" | "switch" | "device" | "qnap"
  community?: string // default "public"
  version?: "1" | "2c" // default 2c
  tonerWarnPct?: number // supply level at/under this = warning (default 10)
  volumeWarnPct?: number // volume fullness at/over this = warning (default 90)
  tempWarnC?: number // cpu/disk temp at/over this = warning (default 70)
  // Name of the uplink interface (e.g. "eth0"). Summing all interfaces
  // double-counts transit traffic and vendor pseudo-interfaces, so the NET
  // headline comes from this link alone when set.
  wanInterface?: string
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

// Generic SYSTEM / IF-MIB OIDs (switches, APs, anything SNMP-capable).
const SYS = {
  descr: "1.3.6.1.2.1.1.1.0",   // sysDescr
  uptime: "1.3.6.1.2.1.1.3.0",  // sysUpTime (timeticks, 1/100s)
  name: "1.3.6.1.2.1.1.5.0",    // sysName
  ifOper: "1.3.6.1.2.1.2.2.1.8", // ifOperStatus (walk): 1=up 2=down
  ifAdmin: "1.3.6.1.2.1.2.2.1.7", // ifAdminStatus (walk): 1=up (enabled)
  ifName: "1.3.6.1.2.1.31.1.1.1.1",  // ifName (walk) — eth0/eth1/itf0/...
  ifHCIn: "1.3.6.1.2.1.31.1.1.1.6",  // ifHCInOctets (walk, Counter64)
  ifHCOut: "1.3.6.1.2.1.31.1.1.1.10", // ifHCOutOctets (walk, Counter64)
}

// UCD-SNMP-MIB + HOST-RESOURCES — CPU/RAM/load on net-snmp devices (EdgeOS
// routers, Linux hosts). All best-effort: absent on gear that doesn't ship the
// UCD MIB (many switches), so every read is null-tolerant.
const UCD = {
  cpuIdle: "1.3.6.1.4.1.2021.11.11.0",  // ssCpuIdle (%) → cpu% = 100 - idle
  load1: "1.3.6.1.4.1.2021.10.1.3.1",   // laLoad 1-min
  load5: "1.3.6.1.4.1.2021.10.1.3.2",
  load15: "1.3.6.1.4.1.2021.10.1.3.3",
  memTotal: "1.3.6.1.4.1.2021.4.5.0",   // memTotalReal (KB)
  memAvail: "1.3.6.1.4.1.2021.4.6.0",   // memAvailReal (KB, free excl. cache)
  memBuffer: "1.3.6.1.4.1.2021.4.14.0", // memBuffer (KB)
  memCached: "1.3.6.1.4.1.2021.4.15.0", // memCached (KB)
  hrProcLoad: "1.3.6.1.2.1.25.3.3.1.2", // hrProcessorLoad (walk, per-core %) — CPU fallback
}

// Previous cumulative octet counters PER INTERFACE (target ip -> ifIndex), for
// per-link throughput rates across polls.
const netPrevIf: Record<string, Record<string, { in: number; out: number; ts: number }>> = {}

// QNAP enterprise MIB (NAS-MIB, 1.3.6.1.4.1.24681.1.2). A full walk of this
// subtree times out on QTS, so everything here is fetched by exact OID.
const QNAP = {
  cpuUsage: "1.3.6.1.4.1.24681.1.2.1.0",   // systemCPU-Usage e.g. "3.5 %"
  cpuTemp: "1.3.6.1.4.1.24681.1.2.5.0",    // cpu-Temperature e.g. "67 C/152 F"
  sysTemp: "1.3.6.1.4.1.24681.1.2.6.0",    // systemTemperature
  model: "1.3.6.1.4.1.24681.1.2.12.0",     // e.g. "TS-963X"
  hdNumber: "1.3.6.1.4.1.24681.1.2.10.0",  // installed disk count
  hdDescr: "1.3.6.1.4.1.24681.1.2.11.1.2.",  // + index
  hdTemp: "1.3.6.1.4.1.24681.1.2.11.1.3.",
  hdStatus: "1.3.6.1.4.1.24681.1.2.11.1.4.", // 0 = ready/ok, negative = fault/empty
  hdModel: "1.3.6.1.4.1.24681.1.2.11.1.5.",  // "--" only when the bay is empty
  hdCapacity: "1.3.6.1.4.1.24681.1.2.11.1.6.", // "7.28 TB" / "--"
  hdSmart: "1.3.6.1.4.1.24681.1.2.11.1.7.",  // "GOOD" / "Warning"
  memTotal: "1.3.6.1.4.1.24681.1.2.2.0",   // "16013.4 MB"
  memFree: "1.3.6.1.4.1.24681.1.2.3.0",    // "11984.9 MB"
  fanSpeed: "1.3.6.1.4.1.24681.1.2.15.1.3.", // + index, "1835 RPM"
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "")
}

// QNAP reports temps as "67 C/152 F" and percentages as "3.5 %" — pull the number.
function parseC(s: string | null): number | undefined {
  const m = /(-?\d+(?:\.\d+)?)\s*C/.exec(s || "")
  return m ? Math.round(Number(m[1])) : undefined
}
function parseNum(s: string | null): number | undefined {
  const m = /(-?\d+(?:\.\d+)?)/.exec(s || "")
  return m ? Number(m[1]) : undefined
}

// net-snmp renders octet strings that contain a NUL/non-printable byte (e.g. HP's
// NUL-terminated "Black Cartridge 81A HP CF281A\0") as space-separated hex.
// Decode that back to text, and strip control chars from any value.
function decodeSnmp(s: string): string {
  const t = s.trim()
  if (/^([0-9A-Fa-f]{2})(\s+[0-9A-Fa-f]{2})+\s*$/.test(t)) {
    const bytes = t.split(/\s+/).map((h) => parseInt(h, 16))
    return Buffer.from(bytes).toString("latin1").replace(/[\x00-\x1f\x7f]+/g, "").trim()
  }
  return t.replace(/[\x00-\x1f\x7f]+/g, "").trim()
}

async function snmpGet(t: SnmpTarget, oid: string, timeout = 8000): Promise<string | null> {
  try {
    const { stdout } = await pexec(
      "snmpget",
      ["-v", t.version || "2c", "-c", t.community || "public", "-Oevq", "-t", "2", "-r", "1", t.ip, oid],
      { timeout },
    )
    const raw = stdout.trim().replace(/^"|"$/g, "")
    if (!raw || /No Such|no response|Timeout/i.test(raw)) return null
    return decodeSnmp(raw)
  } catch {
    return null
  }
}

async function snmpWalk(t: SnmpTarget, oid: string, timeout = 10000): Promise<string[]> {
  try {
    const { stdout } = await pexec(
      "snmpwalk",
      ["-v", t.version || "2c", "-c", t.community || "public", "-Oeqv", "-t", "2", "-r", "1", t.ip, oid],
      { timeout },
    )
    return stdout.split("\n").map((l) => decodeSnmp(l.trim().replace(/^"|"$/g, ""))).filter(Boolean)
  } catch {
    return []
  }
}

async function collectPrinter(t: SnmpTarget): Promise<any> {
  const warnPct = t.tonerWarnPct ?? 10
  // Walk LEVELS (clean numeric values, one per row) to get the supply indices,
  // then fetch each supply's description/max by that index — a single get whose
  // (possibly multi-line hex) value decodeSnmp handles, so a long description
  // can't be split into phantom supplies and misalign the levels.
  const [model, serial, pagesRaw, statusRaw, levelRows] = await Promise.all([
    snmpGet(t, OID.model),
    snmpGet(t, OID.serial),
    snmpGet(t, OID.pages),
    snmpGet(t, OID.status),
    snmpWalkIndexed(t, OID.supplyLevel),
  ])

  // No response at all → the printer is unreachable / SNMP off.
  if (model == null && serial == null && pagesRaw == null && !levelRows.length) {
    return { name: t.name, ip: t.ip, kind: "printer", reachable: false }
  }

  // prtMarkerSuppliesLevel semantics: -2 = unknown, -3 = "some remaining" (a
  // level the device won't quantify); else a count out of MaxCapacity (which can
  // itself be -2 = unknown).
  const supplies = await Promise.all(levelRows.map(async (row) => {
    const [descRaw, maxRaw] = await Promise.all([
      snmpGet(t, `${OID.supplyDesc}.${row.idx}`),
      snmpGet(t, `${OID.supplyMax}.${row.idx}`),
    ])
    const lvl = Number(row.val)
    const max = Number(maxRaw)
    let pct: number | null = null
    if (lvl === -3) pct = 100
    else if (lvl >= 0 && max > 0) pct = Math.round((lvl / max) * 100)
    return { name: descRaw || "supply", level: lvl, max, pct }
  }))
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

// Generic SNMP device (switch/AP/…): identity, uptime, and enabled-port link
// state so a down uplink or dead switch surfaces. Reachability via SNMP is more
// reliable than ICMP — many devices drop ping but answer SNMP.
async function collectDevice(t: SnmpTarget): Promise<any> {
  const [descr, name, uptimeRaw, oper, admin] = await Promise.all([
    snmpGet(t, SYS.descr),
    snmpGet(t, SYS.name),
    snmpGet(t, SYS.uptime),
    snmpWalkIndexed(t, SYS.ifOper),
    snmpWalkIndexed(t, SYS.ifAdmin),
  ])
  if (descr == null && name == null && !oper.length) {
    return { name: t.name, ip: t.ip, kind: t.kind || "device", reachable: false }
  }
  // Index the link-state walks by ifIndex so each interface can carry its own
  // up/down (positional zipping breaks whenever the two walks differ in length).
  const byIndex = (rows: { idx: string; val: string }[]): Record<string, string> => {
    const m: Record<string, string> = {}
    for (const r of rows) m[r.idx] = r.val
    return m
  }
  const operByIdx = byIndex(oper)
  const adminByIdx = byIndex(admin)
  // Values arrive numeric (-Oe), but tolerate an enum rendering like "up(1)"
  // from any agent/MIB combination that slips one through.
  const enumNum = (v?: string): number | undefined => {
    if (v == null) return undefined
    const m = /\((\d+)\)\s*$/.exec(v) || /^\s*(-?\d+)\s*$/.exec(v)
    return m ? Number(m[1]) : undefined
  }

  // Only count ADMIN-enabled ports; an enabled port that's operationally down is
  // a real link-down (ignore the many disabled ports on a big switch).
  let portsTotal = 0
  let portsUp = 0
  for (const idx of Object.keys(adminByIdx)) {
    if (enumNum(adminByIdx[idx]) === 1) {
      portsTotal++
      if (enumNum(operByIdx[idx]) === 1) portsUp++
    }
  }
  // sysUpTime timeticks → seconds
  const upSecs = uptimeRaw != null ? Math.round((Number(String(uptimeRaw).replace(/[^0-9]/g, "")) || 0) / 100) : undefined

  // CPU / RAM / load / network — best-effort UCD-SNMP + IF-MIB counters. Absent
  // on gear without the UCD MIB (returns "No Such Object" fast → null), so every
  // field is optional and simply omitted when unsupported.
  const [cpuIdle, load1, load5, load15, memTotal, memAvail, memBuffer, memCached, procLoads, ifNames, hcInIdx, hcOutIdx] =
    await Promise.all([
      snmpGet(t, UCD.cpuIdle), snmpGet(t, UCD.load1), snmpGet(t, UCD.load5), snmpGet(t, UCD.load15),
      snmpGet(t, UCD.memTotal), snmpGet(t, UCD.memAvail), snmpGet(t, UCD.memBuffer), snmpGet(t, UCD.memCached),
      snmpWalk(t, UCD.hrProcLoad), snmpWalkIndexed(t, SYS.ifName),
      snmpWalkIndexed(t, SYS.ifHCIn), snmpWalkIndexed(t, SYS.ifHCOut),
    ])

  // CPU %: prefer ssCpuIdle (100 - idle); fall back to avg per-core hrProcessorLoad.
  let cpuPct: number | undefined
  if (cpuIdle != null && !isNaN(Number(cpuIdle))) {
    cpuPct = Math.max(0, Math.min(100, 100 - Math.round(Number(cpuIdle))))
  } else {
    const cores = procLoads.map(Number).filter((n) => !isNaN(n))
    if (cores.length) cpuPct = Math.round(cores.reduce((a, b) => a + b, 0) / cores.length)
  }

  const load1n = parseNum(load1)
  const loadavg = [parseNum(load1), parseNum(load5), parseNum(load15)].filter((n): n is number => n != null)

  // RAM used %: (total - free - buffers - cache) / total. memAvailReal excludes
  // cache already on some agents; subtracting buffer+cache is safe (they default 0).
  let memPct: number | undefined, memTotalMB: number | undefined
  const mTot = parseNum(memTotal), mAvail = parseNum(memAvail)
  const mBuf = parseNum(memBuffer) || 0, mCache = parseNum(memCached) || 0
  if (mTot && mTot > 0 && mAvail != null) {
    const usedKb = Math.max(0, mTot - mAvail - mBuf - mCache)
    memPct = Math.round((usedKb / mTot) * 100)
    memTotalMB = Math.round(mTot / 1024)
  }

  // Network throughput, PER INTERFACE (bytes/sec).
  //
  // Summing every interface is meaningless on a router: a transiting packet is
  // counted once arriving on the WAN and again leaving on the LAN, so
  // sum(in) === sum(out) by construction — and vendors add aggregate pseudo
  // interfaces (EdgeOS `itf0`) that mirror the whole load a second time. The
  // observed effect was ~5x inflation with in/out identical to the eye.
  //
  // So: rate each interface separately, skip loopback/pseudo, and let the target
  // name its WAN (`wanInterface`) to headline the figure that actually means
  // "internet traffic". Without one, the headline is left undefined rather than
  // reporting a number we know to be wrong.
  const PSEUDO = /^(lo|imq\d*|itf\d*|ifb\d*|sit\d*|gre\d*|teql\d*|tunl\d*)$/i
  const nameByIdx = byIndex(ifNames)
  const inByIdx = byIndex(hcInIdx)
  const outByIdx = byIndex(hcOutIdx)

  const now = Date.now()
  const prevIf = netPrevIf[t.ip] || {}
  const nextIf: Record<string, { in: number; out: number; ts: number }> = {}
  const interfaces: { name: string; inBps?: number; outBps?: number; up?: boolean; adminUp?: boolean }[] = []
  for (const idx of Object.keys(inByIdx)) {
    const name = (nameByIdx[idx] || `if${idx}`).replace(/^"|"$/g, "")
    const cin = Number(inByIdx[idx]), cout = Number(outByIdx[idx])
    if (isNaN(cin) || isNaN(cout)) continue
    nextIf[idx] = { in: cin, out: cout, ts: now }
    if (PSEUDO.test(name)) continue
    const p = prevIf[idx]
    let inBps: number | undefined, outBps: number | undefined
    if (p && cin >= p.in && cout >= p.out && now > p.ts) {
      const dt = (now - p.ts) / 1000
      if (dt > 0) {
        inBps = Math.round((cin - p.in) / dt)
        outBps = Math.round((cout - p.out) / dt)
      }
    }
    // ifOperStatus 1=up, ifAdminStatus 1=enabled. A link that's admin-enabled but
    // operationally down is a real fault; an admin-disabled port is just off.
    const adminUp = adminByIdx[idx] != null ? enumNum(adminByIdx[idx]) === 1 : undefined
    const linkUp = operByIdx[idx] != null ? enumNum(operByIdx[idx]) === 1 : undefined
    interfaces.push({ name, inBps, outBps, up: linkUp, adminUp })
  }
  netPrevIf[t.ip] = nextIf

  // Headline = the WAN link when the target names one.
  const wanName = t.wanInterface
  const wan = wanName ? interfaces.find((i) => i.name === wanName) : undefined
  const netIn = wan?.inBps
  const netOut = wan?.outBps

  return {
    name: t.name,
    ip: t.ip,
    kind: t.kind || "device",
    reachable: true,
    sysDescr: descr || undefined,
    sysName: name || undefined,
    uptimeSecs: upSecs,
    portsUp,
    portsTotal,
    cpuPct,
    cpuCores: procLoads.length || undefined, // for load-per-core normalization
    load1: load1n,
    loadavg: loadavg.length ? loadavg : undefined,
    memPct,
    memTotalMB,
    netIn,
    netOut,
    wanInterface: wanName,
    // Per-link rates (loopback/pseudo excluded), busiest first.
    interfaces: interfaces
      .slice()
      .sort((a, b) => ((b.inBps || 0) + (b.outBps || 0)) - ((a.inBps || 0) + (a.outBps || 0))),
  }
}

// Walk that keeps each row's index (numeric OID suffix) — needed to resolve the
// hrStorage table entries for the data volumes.
async function snmpWalkIndexed(t: SnmpTarget, oid: string, timeout = 10000): Promise<{ idx: string; val: string }[]> {
  try {
    const { stdout } = await pexec(
      "snmpwalk",
      ["-v", t.version || "2c", "-c", t.community || "public", "-Oen", "-t", "2", "-r", "1", t.ip, oid],
      { timeout },
    )
    return stdout.split("\n").map((l) => {
      const m = /^(\S+)\s*=\s*[^:]+:\s*(.*)$/.exec(l.trim())
      if (!m) return null
      // snmpwalk -On emits a leading dot (".1.3.6…") the bare OID lacks.
      const clean = m[1].replace(/^\./, "")
      const idx = clean.startsWith(oid) ? clean.slice(oid.length).replace(/^\./, "") : clean
      return { idx, val: m[2].trim().replace(/^"|"$/g, "") }
    }).filter(Boolean) as { idx: string; val: string }[]
  } catch {
    return []
  }
}

// QNAP NAS: CPU load, cpu/system temps, per-disk health + temp, and data-volume
// fullness. Uses the QNAP enterprise MIB by exact OID (walk times out) plus
// HOST-RESOURCES for CPU load and volume sizes.
async function collectQnap(t: SnmpTarget): Promise<any> {
  const tempWarn = t.tempWarnC ?? 70
  const volWarn = t.volumeWarnPct ?? 90
  // The light scalar gets can run together, but the WALKS must be SERIALIZED:
  // QNAP's SNMP agent silently drops rows (and whole tables) under concurrent
  // sessions, producing partial reads that flip a failing NAS back to a false
  // "healthy". 5-min cadence — sequential latency is fine.
  const [model, cpuTemp, sysTemp, memTotal, memFree] = await Promise.all([
    snmpGet(t, QNAP.model), snmpGet(t, QNAP.cpuTemp), snmpGet(t, QNAP.sysTemp),
    snmpGet(t, QNAP.memTotal), snmpGet(t, QNAP.memFree),
  ])
  if (model == null && cpuTemp == null) {
    return { name: t.name, ip: t.ip, kind: "qnap", reachable: false }
  }
  const cpuLoads = await snmpWalk(t, "1.3.6.1.2.1.25.3.3.1.2")            // hrProcessorLoad (per core)
  const storDescrs = await snmpWalkIndexed(t, "1.3.6.1.2.1.25.2.3.1.3")  // hrStorageDescr
  const fanSpeeds = await snmpWalk(t, "1.3.6.1.4.1.24681.1.2.15.1.3")    // SystemFanSpeed table

  // CPU: average per-core load.
  const cores = cpuLoads.map(Number).filter((n) => !isNaN(n))
  const cpuPct = cores.length ? Math.round(cores.reduce((a, b) => a + b, 0) / cores.length) : undefined

  // RAM used %.  Values look like "16013.4 MB".
  const memTotalMB = parseNum(memTotal), memFreeMB = parseNum(memFree)
  const memPct = memTotalMB && memTotalMB > 0 && memFreeMB != null
    ? Math.round(((memTotalMB - memFreeMB) / memTotalMB) * 100) : undefined

  // Fans — each entry looks like "1835 RPM".
  const fans = fanSpeeds.map((f) => parseNum(f)).filter((n): n is number => n != null && n > 0)

  // Disks — walk each column of the disk table ONCE (6 small walks) rather than
  // 6 gets × N bays. QNAP's SNMP agent is flaky under concurrent-get bursts and
  // silently drops rows (partial reads that hid disks); a per-column walk is a
  // single session each — far gentler and returns every populated row atomically.
  // Presence keys on MODEL/CAPACITY ("--" = empty bay), so a FAILING disk
  // (unreadable temp, negative status) is still reported, not mistaken for empty.
  const DT = "1.3.6.1.4.1.24681.1.2.11.1." // disk table columns: 2=descr 3=temp 4=status 5=model 6=capacity 7=smart
  // Serialized (not Promise.all) — concurrent column walks are what make the
  // agent drop rows.
  const wStatus = await snmpWalkIndexed(t, DT + "4")
  const wTemp = await snmpWalkIndexed(t, DT + "3")
  const wSmart = await snmpWalkIndexed(t, DT + "7")
  const wDescr = await snmpWalkIndexed(t, DT + "2")
  const wModel = await snmpWalkIndexed(t, DT + "5")
  const wCap = await snmpWalkIndexed(t, DT + "6")
  const col = (rows: { idx: string; val: string }[]): Record<string, string> => {
    const m: Record<string, string> = {}
    for (const r of rows) m[r.idx] = r.val
    return m
  }
  const cSt = col(wStatus), cTp = col(wTemp), cSm = col(wSmart), cDs = col(wDescr), cMd = col(wModel), cCap = col(wCap)
  const slots = (Object.keys(cMd).length ? Object.keys(cMd) : Object.keys(cDs))
    .sort((a, b) => Number(a) - Number(b))
  const disks: any[] = []
  for (const i of slots) {
    const model = cMd[i] && cMd[i] !== "--" ? cMd[i] : undefined
    const capacity = cCap[i] && cCap[i] !== "--" ? cCap[i] : undefined
    // Only a truly empty bay (no model AND no capacity) is skipped.
    if (!model && !capacity) continue
    let status = cSt[i] != null ? Number(cSt[i]) : undefined
    const tempC = parseC(cTp[i] || null)
    let smart = cSm[i] && cSm[i] !== "--" ? cSm[i] : undefined
    // A present disk MUST carry a health verdict (status or SMART). If the
    // status/smart column walks came back empty for this row that cycle, the
    // disk would look healthy purely for lack of a reading — the exact bug that
    // flips a failing NAS green. Fall back to a targeted per-disk get before
    // giving up on the row.
    if (status == null) {
      const s = await snmpGet(t, DT + "4." + i)
      if (s != null && s !== "" && !isNaN(Number(s))) status = Number(s)
    }
    if (smart == null) {
      const s = await snmpGet(t, DT + "7." + i)
      if (s != null && s !== "" && s !== "--") smart = s
    }
    disks.push({ slot: Number(i), descr: cDs[i] || undefined, model, capacity, tempC, status, smart })
  }
  // A reachable QNAP always has ≥1 disk. Zero means the disk-table walks came
  // back empty (agent timed out) — treat as an INCOMPLETE read, not a clean
  // bill of health, so a real disk error isn't falsely cleared to green.
  if (!disks.length) {
    return { name: t.name, ip: t.ip, kind: "qnap", reachable: true, error: "SNMP read incomplete — disk table empty" }
  }
  // Every present disk must have a health verdict after the fallback gets. If
  // any disk still lacks BOTH a status and a SMART reading, we cannot certify it
  // — the read is incomplete, so report that rather than a false all-clear.
  const unverified = disks.filter((d) => d.status == null && d.smart == null)
  if (unverified.length) {
    return {
      name: t.name, ip: t.ip, kind: "qnap", reachable: true,
      error: `SNMP read incomplete — no health verdict for ${unverified.length} disk(s): ${unverified.map((d) => d.descr || `slot ${d.slot}`).join(", ")}`,
    }
  }

  // A present disk is bad only on a real error status, an explicitly-bad SMART
  // verdict, or overheating — not a blank "--" or an empty bay.
  const badDisks = disks.filter((d) =>
    (d.status != null && d.status !== 0) ||
    (typeof d.smart === "string" && /warn|abnormal|fail|error|bad|caution/i.test(d.smart)) ||
    (d.tempC != null && d.tempC >= tempWarn))

  // Volumes — the CACHEDEVn_DATA mounts from hrStorage.
  const volumes: any[] = []
  for (const row of storDescrs.filter((r) => /CACHEDEV\d+_DATA$/.test(r.val))) {
    const [units, size, used] = await Promise.all([
      snmpGet(t, `1.3.6.1.2.1.25.2.3.1.4.${row.idx}`), snmpGet(t, `1.3.6.1.2.1.25.2.3.1.5.${row.idx}`), snmpGet(t, `1.3.6.1.2.1.25.2.3.1.6.${row.idx}`),
    ])
    const u = parseNum(units) || 1, sz = parseNum(size) || 0, us = parseNum(used) || 0
    if (sz > 0) volumes.push({ mount: row.val, totalGB: Math.round((sz * u) / 1e9), usedGB: Math.round((us * u) / 1e9), pct: Math.round((us / sz) * 100) })
  }
  const fullVols = volumes.filter((v) => v.pct >= volWarn)

  return {
    name: t.name, ip: t.ip, kind: "qnap", reachable: true,
    model: model || undefined,
    cpuPct, cpuTempC: parseC(cpuTemp), sysTempC: parseC(sysTemp),
    memPct, memTotalMB: memTotalMB || undefined,
    fans, fanRpm: fans.length ? Math.min(...fans) : undefined,
    disks, diskCount: disks.length,
    badDisks: badDisks.map((d) => ({ slot: d.slot, descr: d.descr, model: d.model, status: d.status, smart: d.smart, tempC: d.tempC })),
    volumes, fullVolumes: fullVols,
    tempWarnC: tempWarn, volumeWarnPct: volWarn,
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
          const data =
            t.kind === "qnap" ? await collectQnap(t)
              : t.kind === "printer" || !t.kind ? await collectPrinter(t)
                : await collectDevice(t)
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
