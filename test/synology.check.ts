// Run: bun test/synology.check.ts
import assert from "node:assert/strict"
import { authErrorText, summarise } from "../plugins/monitoring/SynologyPlugin.ts"

// Shapes as a DS420j on DSM 7.4 answers them.
const disk = (name: string, over = {}) => ({ name, device: "/dev/sda", model: "WD101EFBX", temp: 32, status: "normal", smart_status: "normal", unc: 0, ...over })
const storage = (over: any = {}) => ({
  disks: [disk("Drive 1"), disk("Drive 2")],
  storagePools: [{ id: "reuse_1", status: "normal", device_type: "raid_6" }],
  volumes: [{ id: "volume_1", vol_path: "/volume1", status: "normal", size: { total: "19898539249664", used: "8526858752000" } }],
  ...over,
})
const usb = { devices: [{ dev_id: "sdq", status: "normal", partitions: [{ share_name: "usbshare1", status: "normal", total_size_mb: 11444211, used_size_mb: 6029763 }] }] }
const system = { model: "DS420j", sys_temp: 48, temperature_warning: false }
const util = { cpu: { user_load: 0, system_load: 1, other_load: 1 }, memory: { real_usage: 23, total_real: 1011668 } }

const ok = summarise(storage(), usb, system, util, { expectedVolumes: ["volume1", "usbshare1"] })
assert.equal(ok.error, undefined)
assert.equal(ok.kind, "qnap")
assert.equal(ok.model, "DS420j")
assert.equal(ok.cpuPct, 2)
assert.equal(ok.memPct, 23)
assert.equal(ok.sysTempC, 48)
assert.equal(ok.diskCount, 3)
assert.deepEqual(ok.badDisks, [])
assert.deepEqual(ok.fullVolumes, [])
assert.deepEqual(ok.volumes[0], { mount: "/volume1", totalGB: 19899, usedGB: 8527, pct: 43 })
assert.deepEqual(ok.volumes[1], { mount: "usbshare1", totalGB: 12000, usedGB: 6323, pct: 53 })

// Any status other than normal is bad, including ones never seen before.
assert.match(summarise(storage({ storagePools: [{ status: "degrade", device_type: "raid_6" }] }), null, null, null).error!, /raid_6 degrade/)
assert.match(summarise(storage({ volumes: [{ vol_path: "/volume1", status: "crashed", size: {} }] }), null, null, null).error!, /volume1 crashed/)
assert.equal(summarise(storage({ disks: [disk("Drive 1", { status: "failing" })] }), null, null, null).badDisks.length, 1)

// A disk can look fine overall and still be the one to replace.
assert.equal(summarise(storage({ disks: [disk("Drive 1", { smart_status: "abnormal" })] }), null, null, null).badDisks[0].smart, "abnormal")
assert.equal(summarise(storage({ disks: [disk("Drive 1", { unc: 3 })] }), null, null, null).badDisks[0].smart, "3 uncorrectable")
assert.equal(summarise(storage({ disks: [disk("Drive 1", { temp: 70 })] }), null, null, null).badDisks.length, 1)

// A USB disk that drops off is only visible as an absence.
assert.match(summarise(storage(), null, system, util, { expectedVolumes: ["usbshare1"] }).error!, /usbshare1 missing/)
assert.match(summarise(storage({ disks: [] }), null, null, null).error!, /no disks/)
assert.match(summarise(storage(), null, { temperature_warning: true }, null).error!, /overheating/)

// Thresholds, and a card that survives the extras failing.
assert.equal(summarise(storage(), null, null, null, { volumeWarnPct: 40 }).fullVolumes.length, 1)
assert.equal(summarise(storage(), null, null, null).model, undefined)

// Refused logins back off; a network error doesn't count as one.
assert.match(authErrorText(400)!, /wrong/)
assert.match(authErrorText(407)!, /auto block/)
assert.equal(authErrorText(119), undefined)

console.log("synology ok")
