// Run: bun test/supabase.check.ts
import assert from "node:assert/strict"
import { parseProm, pickMetrics } from "../plugins/monitoring/SupabasePlugin.ts"

const text = `# HELP node_filesystem_size_bytes Filesystem size in bytes.
# TYPE node_filesystem_size_bytes gauge
node_filesystem_size_bytes{device="/dev/nvme0n1p2",fstype="ext4",mountpoint="/"} 1e+10
node_filesystem_size_bytes{device="/dev/nvme1n1",fstype="ext4",mountpoint="/data"} 8e+09
node_filesystem_avail_bytes{device="/dev/nvme0n1p2",fstype="ext4",mountpoint="/"} 9e+09
node_filesystem_avail_bytes{device="/dev/nvme1n1",fstype="ext4",mountpoint="/data"} 2e+09
node_memory_MemTotal_bytes 4000
node_memory_MemAvailable_bytes 1000
pg_stat_database_num_backends{datname="postgres"} 12
pg_stat_database_num_backends{datname="template1"} 0
pg_settings_max_connections 60
pg_up NaN
`
const samples = parseProm(text)
// Comments are skipped, labels are read, and a non-finite value is dropped.
assert.equal(samples.length, 9)
assert.equal(samples[1].labels.mountpoint, "/data")

const m = pickMetrics(samples)
// The data volume wins over root: that is the one Postgres fills.
assert.equal(m.diskTotalBytes, 8e9)
assert.equal(m.diskPct, 75)
assert.equal(m.memPct, 75)
assert.equal(m.connections, 12)
assert.equal(m.maxConnections, 60)
// An absent series is "not measured", never zero.
assert.equal(m.dbSizeBytes, null)
assert.equal(pickMetrics([]).diskPct, null)

console.log("supabase.check ok")
