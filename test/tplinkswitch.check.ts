// Run: bun test/tplinkswitch.check.ts
// Fixtures are real responses from an ES206X-M2, with the serial and MAC replaced.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { buildReport, ratesBetween, md5Upper } from "../plugins/monitoring/TplinkSwitchPlugin.ts"

assert.equal(md5Upper("admin"), createHash("md5").update("admin").digest("hex").toUpperCase())
assert.equal(md5Upper("admin"), "21232F297A57A5A743894A0E4A801FC3")

const port = (id: number, cfg: string, speed: string, duplex: string) => ({
  port_id: id, port_state_cfg: cfg, port_state_actual: speed === "Link Down" ? "Disabled" : "Enabled",
  port_speed_actual: speed, port_duplex_actual: duplex, port_speed_cfg: "6", port_duplex_cfg: "2", flow_ctrl_cfg: "0", flow_ctrl_actual: "Off",
})
const raw = {
  info: { serial_number: "Y000000000000", sys_ipv4: "192.0.2.2", sys_mac_addr: "02:00:00:00:00:01", fw_ver: "1.0.1 Build 20251128 Rel.41332", hw_ver: "ES206X-M2 1.0", des: "ES206X-M2" },
  ports: { port_list: [
    port(1, "3", "1000Mbps", "Full"), port(2, "3", "1000Mbps", "Full"), port(3, "3", "Link Down", "Link Down"),
    port(4, "3", "2500Mbps", "Full"), port(5, "3", "2500Mbps", "Full"), port(6, "0", "Link Down", "Link Down"),
  ] },
  traffic: { port_list: [
    { port_id: 1, rx_bytes: 119556356, tx_bytes: 156961662 }, { port_id: 2, rx_bytes: 15224512964, tx_bytes: 23769911767 },
    { port_id: 3, rx_bytes: 0, tx_bytes: 0 }, { port_id: 4, rx_bytes: 7169669279, tx_bytes: 56743639246 },
    { port_id: 5, rx_bytes: 80848151841, tx_bytes: 22664932368 }, { port_id: 6, rx_bytes: 0, tx_bytes: 0 },
  ] },
  loops: { port_list: [1, 2, 3, 4, 5, 6].map((id) => ({ port_id: id, port_state: id === 2 ? "2" : id === 3 ? "1" : "0" })) },
}

// report shape matches the snmp switch payload the card already draws
let r = buildReport({ host: "192.0.2.2", uplinkPorts: [4, 3] }, raw, new Map([[4, { inBps: 1200, outBps: 98000 }]]))
assert.equal(r.ip, "192.0.2.2")
assert.equal(r.name, "ES206X-M2")
assert.equal(r.kind, "switch")
assert.equal(r.sysDescr, "ES206X-M2 1.0, firmware 1.0.1 Build 20251128 Rel.41332")
assert.equal(r.portsUp, 4)
assert.equal(r.portsTotal, 6)
assert.deepEqual(r.interfaces[3], { name: "port 4", up: true, adminUp: true, speed: "2500Mbps", duplex: "Full", rxBytes: 7169669279, txBytes: 56743639246, inBps: 1200, outBps: 98000, loop: "normal" })
// enabled with nothing plugged in vs switched off in config
assert.deepEqual([r.interfaces[2].up, r.interfaces[2].adminUp], [false, true])
assert.deepEqual([r.interfaces[5].up, r.interfaces[5].adminUp], [false, false])
assert.equal(r.interfaces[2].speed, undefined)
// loops and uplinks
assert.deepEqual(r.loops, ["port 2"])
assert.deepEqual(r.blocked, ["port 3"])
assert.deepEqual(r.downUplinks, ["port 3"])
// a configured uplink that doesn't exist counts as down
assert.deepEqual(buildReport({ host: "h", uplinkPorts: [9] }, raw, new Map()).downUplinks, ["port 9"])
// a given name wins over the model
assert.equal(buildReport({ host: "h", name: "rack switch" }, raw, new Map()).name, "rack switch")

// rates: bytes per second between readings, nothing on the first reading or after a counter reset
const reading = (at: number, rx: number, tx: number) => ({ at, ports: new Map([[1, { rx, tx }]]) })
assert.equal(ratesBetween(undefined, reading(1000, 5, 5)).size, 0)
assert.deepEqual(ratesBetween(reading(0, 1000, 2000), reading(60000, 61000, 2600)).get(1), { inBps: 1000, outBps: 10 })
assert.equal(ratesBetween(reading(0, 9000, 9000), reading(60000, 10, 10)).get(1), undefined)

console.log("tplinkswitch: all checks passed")
