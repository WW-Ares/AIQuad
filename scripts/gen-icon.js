const zlib = require('zlib')
const fs = require('fs')
const path = require('path')

const W = 32
const H = 32
const raw = Buffer.alloc((W * 4 + 1) * H)
let p = 0
for (let y = 0; y < H; y++) {
  raw[p++] = 0
  for (let x = 0; x < W; x++) {
    const inCircle = Math.hypot(x - 15.5, y - 15.5) < 15
    if (!inCircle) {
      raw[p++] = 0
      raw[p++] = 0
      raw[p++] = 0
      raw[p++] = 0
    }
    else {
      const corner = (x < 8 && y < 8) || (x > 23 && y < 8) || (x < 8 && y > 23) || (x > 23 && y > 23)
      if (corner) {
        raw[p++] = 0x4f
        raw[p++] = 0x8c
        raw[p++] = 0xff
        raw[p++] = 255
      }
      else {
        raw[p++] = 0x2f
        raw[p++] = 0x36
        raw[p++] = 0x46
        raw[p++] = 255
      }
    }
  }
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const t = Buffer.from(type, 'ascii')
  const body = Buffer.concat([t, data])
  const crcTable = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  let crc = 0xFFFFFFFF
  for (const b of body) crc = crcTable[(crc ^ b) & 0xFF] ^ (crc >>> 8)
  crc = (crc ^ 0xFFFFFFFF) >>> 0
  const c = Buffer.alloc(4)
  c.writeUInt32BE(crc)
  return Buffer.concat([len, body, c])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0)
ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8
ihdr[9] = 6

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
])

const out = path.join(__dirname, '..', 'src', 'renderer', 'tray.png')
fs.writeFileSync(out, png)
console.log('tray.png written:', out, png.length, 'bytes')
