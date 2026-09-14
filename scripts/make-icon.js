/**
 * 生成应用图标：
 *   src/renderer/tray.png  32×32   托盘图标
 *   src/renderer/icon.ico  256×256 应用/安装包图标（ICO 内嵌 PNG）
 */
const zlib = require('node:zlib')
const fs = require('node:fs')
const path = require('node:path')

function crc32(buf) {
  let c
  const table = []
  for (let n = 0; n < 256; n++) {
    c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xFFFFFFFF
  for (const b of buf) crc = table[(crc ^ b) & 0xFF] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  let p = 0
  for (let y = 0; y < height; y++) {
    raw[p++] = 0
    rgba.copy(raw, p, y * width * 4, (y + 1) * width * 4)
    p += width * 4
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function insideRoundRect(px, py, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(px, x0 + r), x1 - r)
  const cy = Math.min(Math.max(py, y0 + r), y1 - r)
  return Math.hypot(px - cx, py - cy) <= r + 0.5
}

/** 4x4 超采样，得到平滑边缘 */
function drawIcon(size) {
  const buf = Buffer.alloc(size * size * 4)
  const S = size
  const m = S * 0.11 // 外边距
  const gap = S * 0.062
  const inner = S - m * 2
  const tile = (inner - gap) / 2
  const rOuter = S * 0.22
  const rTile = tile * 0.22

  const tiles = [
    { x: m, y: m, color: [79, 140, 255] },
    { x: m + tile + gap, y: m, color: [127, 176, 255] },
    { x: m, y: m + tile + gap, color: [127, 176, 255] },
    { x: m + tile + gap, y: m + tile + gap, color: [79, 140, 255] },
  ]
  const bg = [27, 31, 39]

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let sr = 0, sg = 0, sb = 0, sa = 0
      const SS = 4
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS
          const py = y + (sy + 0.5) / SS
          if (!insideRoundRect(px, py, 0, 0, S, S, rOuter)) continue
          let cr = bg[0], cg = bg[1], cb = bg[2]
          for (const t of tiles) {
            if (insideRoundRect(px, py, t.x, t.y, t.x + tile, t.y + tile, rTile)) {
              cr = t.color[0]
              cg = t.color[1]
              cb = t.color[2]
              break
            }
          }
          sr += cr
          sg += cg
          sb += cb
          sa += 255
        }
      }
      const n = SS * SS
      const i = (y * S + x) * 4
      if (sa > 0) {
        const cov = sa / (n * 255)
        buf[i] = Math.round(sr / n / cov)
        buf[i + 1] = Math.round(sg / n / cov)
        buf[i + 2] = Math.round(sb / n / cov)
        buf[i + 3] = Math.round(cov * 255)
      }
    }
  }
  return buf
}

function makeIco(png, size) {
  const dir = Buffer.alloc(6)
  dir.writeUInt16LE(0, 0)
  dir.writeUInt16LE(1, 2)
  dir.writeUInt16LE(1, 4)
  const entry = Buffer.alloc(16)
  entry[0] = size >= 256 ? 0 : size
  entry[1] = size >= 256 ? 0 : size
  entry[2] = 0
  entry[3] = 0
  entry.writeUInt16LE(1, 4)
  entry.writeUInt16LE(32, 6)
  entry.writeUInt32LE(png.length, 8)
  entry.writeUInt32LE(22, 12)
  return Buffer.concat([dir, entry, png])
}

const outDir = path.join(__dirname, '..', 'src', 'renderer')
fs.mkdirSync(outDir, { recursive: true })

const png32 = encodePng(32, 32, drawIcon(32))
fs.writeFileSync(path.join(outDir, 'tray.png'), png32)

const png256 = encodePng(256, 256, drawIcon(256))
fs.writeFileSync(path.join(outDir, 'icon.ico'), makeIco(png256, 256))

console.log('tray.png', png32.length, 'bytes')
console.log('icon.ico', fs.statSync(path.join(outDir, 'icon.ico')).size, 'bytes')
