// Run: bun test/camera.check.ts
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { cameraId, createCameraPlugin, digestHeader, jpegSize, parseCameraTime, wsSecurity } from "../plugins/monitoring/CameraPlugin.ts"

const plugin = createCameraPlugin()
assert.equal(plugin.getName(), "camera")

// RFC 2617's worked example.
const h = digestHeader(
  'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
  "GET", "/dir/index.html", "Mufasa", "Circle Of Life", "0a4f113b",
)
assert.match(h, /response="6629fae49393a05397450978507c4ef1"/)
assert.match(h, /opaque="5ccc069c403ebaf9f0171e9517f40e41"/)
assert.match(h, /qop=auth, nc=00000001, cnonce="0a4f113b"/)

// SOI, an APP0 segment, then SOF0 for 1280x720.
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xd0, 0x05, 0x00, 0x03, 0, 0, 0, 0, 0, 0])
assert.deepEqual(jpegSize(jpeg), { width: 1280, height: 720 })
assert.equal(jpegSize(Uint8Array.from([0x89, 0x50, 0x4e, 0x47])), undefined) // PNG

// The camera checks the digest the same way.
const nonce = Buffer.from("0123456789abcdef")
const ws = wsSecurity("admin", "secret", new Date("2026-11-12T10:00:00.123Z"), nonce)
const created = ws.match(/<Created[^>]*>([^<]+)</)![1]
assert.equal(created, "2026-11-12T10:00:00Z")
const want = createHash("sha1").update(Buffer.concat([nonce, Buffer.from(created + "secret")])).digest("base64")
assert.ok(ws.includes(`>${want}</Password>`))

const clock = parseCameraTime("<tt:UTCDateTime><tt:Time><tt:Hour>9</tt:Hour><tt:Minute>5</tt:Minute><tt:Second>7</tt:Second></tt:Time><tt:Date><tt:Year>2026</tt:Year><tt:Month>11</tt:Month><tt:Day>12</tt:Day></tt:Date></tt:UTCDateTime>")
assert.equal(clock?.toISOString(), "2026-11-12T09:05:07.000Z")
assert.equal(parseCameraTime("<nothing/>"), undefined)

// Ids stay put when a camera is renamed, and differ per channel and profile.
assert.equal(cameraId({ name: "Lobby", url: "http://192.168.1.20/ISAPI/Streaming/channels/101/picture" }), "camera-192-168-1-20-isapi-streaming-channels-101-picture")
assert.notEqual(cameraId({ url: "http://192.168.1.20/ISAPI/Streaming/channels/201/picture" }), cameraId({ url: "http://192.168.1.20/ISAPI/Streaming/channels/101/picture" }))
assert.equal(cameraId({ driver: "onvif", host: "192.168.1.21:8000", profile: 1 }), "camera-192-168-1-21-8000-p1")
assert.equal(cameraId({ id: "front-door", url: "http://x/y" }), "front-door")

console.log("camera check: ok")
