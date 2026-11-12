#!/usr/bin/env node
// A pretend IP camera for testing the camera plugin without hardware.
//
//   node scripts/fake-camera.mjs [port=8554] [user=admin] [pass=secret]
//
// GET  /snapshot.jpg           a fresh JPEG, behind HTTP Digest auth
// POST /onvif/device_service   ONVIF device calls (GetSystemDateAndTime, GetCapabilities)
// POST /onvif/media_service    ONVIF media calls (GetProfiles, GetSnapshotUri), WS-Security checked
//
// Frames come from ffmpeg's test pattern, whose counter and sweep move two a second, so
// each snapshot differs. Needs ffmpeg on PATH.
import http from "node:http"
import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"

const [port = "8554", user = "admin", pass = "secret"] = process.argv.slice(2)
const realm = "fake-camera"
const md5 = (s) => createHash("md5").update(s).digest("hex")

let latest = null
const ff = spawn("ffmpeg", [
  "-loglevel", "error", "-re", "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=2",
  "-f", "mjpeg", "-q:v", "5", "pipe:1",
])
let buf = Buffer.alloc(0)
ff.stdout.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk])
  for (;;) {
    const start = buf.indexOf(Buffer.from([0xff, 0xd8]))
    const end = buf.indexOf(Buffer.from([0xff, 0xd9]), start + 2)
    if (start < 0 || end < 0) break
    latest = buf.subarray(start, end + 2)
    buf = buf.subarray(end + 2)
  }
})
ff.stderr.pipe(process.stderr)
ff.on("exit", (code) => { console.error(`ffmpeg exited (${code})`); process.exit(1) })

function digestOk(header, method) {
  if (!/^Digest /i.test(header || "")) return false
  const p = {}
  for (const m of header.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) p[m[1]] = m[2] ?? m[3]
  const ha1 = md5(`${p.username}:${realm}:${pass}`)
  const ha2 = md5(`${method}:${p.uri}`)
  const want = p.qop ? md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`) : md5(`${ha1}:${p.nonce}:${ha2}`)
  return p.username === user && p.response === want
}

function wsOk(xml) {
  const get = (t) => xml.match(new RegExp(`<(?:\\w+:)?${t}(?:\\s[^>]*)?>([^<]*)<`))?.[1]
  const nonce = get("Nonce"), created = get("Created"), digest = get("Password")
  if (get("Username") !== user || !nonce || !created) return false
  if (Math.abs(Date.parse(created) - Date.now()) > 30_000) return false
  const want = createHash("sha1").update(Buffer.concat([Buffer.from(nonce, "base64"), Buffer.from(created + pass)])).digest("base64")
  return want === digest
}

const soap = (body) =>
  `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema"><s:Body>${body}</s:Body></s:Envelope>`
const fault = `<s:Fault><s:Code><s:Value>s:Sender</s:Value><s:Subcode><s:Value>ter:NotAuthorized</s:Value></s:Subcode></s:Code></s:Fault>`

http.createServer((req, res) => {
  const host = req.headers.host
  if (req.method === "GET" && req.url.startsWith("/snapshot.jpg")) {
    if (!digestOk(req.headers.authorization, "GET")) {
      res.writeHead(401, { "www-authenticate": `Digest realm="${realm}", qop="auth", nonce="${randomBytes(12).toString("hex")}", algorithm=MD5` })
      return res.end()
    }
    if (!latest) { res.writeHead(503); return res.end("warming up") }
    res.writeHead(200, { "content-type": "image/jpeg", "content-length": latest.length })
    return res.end(latest)
  }
  if (req.method === "POST" && req.url.startsWith("/onvif/")) {
    let xml = ""
    req.on("data", (c) => { xml += c })
    req.on("end", () => {
      const send = (status, body) => { res.writeHead(status, { "content-type": "application/soap+xml" }); res.end(soap(body)) }
      if (/GetSystemDateAndTime/.test(xml)) {
        const d = new Date()
        return send(200, `<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime><tt:UTCDateTime><tt:Time><tt:Hour>${d.getUTCHours()}</tt:Hour><tt:Minute>${d.getUTCMinutes()}</tt:Minute><tt:Second>${d.getUTCSeconds()}</tt:Second></tt:Time><tt:Date><tt:Year>${d.getUTCFullYear()}</tt:Year><tt:Month>${d.getUTCMonth() + 1}</tt:Month><tt:Day>${d.getUTCDate()}</tt:Day></tt:Date></tt:UTCDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>`)
      }
      if (!wsOk(xml)) return send(400, fault)
      if (/GetCapabilities/.test(xml)) return send(200, `<tds:GetCapabilitiesResponse><tds:Capabilities><tt:Media><tt:XAddr>http://10.255.0.9/onvif/media_service</tt:XAddr></tt:Media></tds:Capabilities></tds:GetCapabilitiesResponse>`)
      if (/GetProfiles/.test(xml)) return send(200, `<trt:GetProfilesResponse><trt:Profiles token="main" fixed="true"><tt:Name>main</tt:Name></trt:Profiles><trt:Profiles token="sub" fixed="true"><tt:Name>sub</tt:Name></trt:Profiles></trt:GetProfilesResponse>`)
      if (/GetSnapshotUri/.test(xml)) {
        const token = xml.match(/ProfileToken>([^<]+)</)?.[1]
        return send(200, `<trt:GetSnapshotUriResponse><trt:MediaUri><tt:Uri>http://${host}/snapshot.jpg?profile=${token}&amp;x=1</tt:Uri></trt:MediaUri></trt:GetSnapshotUriResponse>`)
      }
      send(400, `<s:Fault><s:Reason><s:Text>not implemented</s:Text></s:Reason></s:Fault>`)
    })
    return
  }
  res.writeHead(404)
  res.end()
}).listen(Number(port), () => console.log(`fake camera on http://localhost:${port}/snapshot.jpg (user ${user}), ONVIF at /onvif/device_service`))
