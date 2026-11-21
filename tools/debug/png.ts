// PNG in and out for the debug tools, with nothing but Node's zlib: 8-bit RGB or RGBA pictures
// without interlacing (what a browser's screenshot and toDataURL give), as plain RGBA bytes.

import { readFileSync, writeFileSync } from "node:fs";
import { crc32, deflateSync, inflateSync } from "node:zlib";

export interface Picture {
  w: number;
  h: number;
  data: Uint8Array; // RGBA
}

export function decodePng(from: string | Buffer): Picture {
  const b = typeof from === "string" ? readFileSync(from) : from;
  let o = 8, w = 0, h = 0, type = 6;
  const idat: Buffer[] = [];
  while (o < b.length) {
    const len = b.readUInt32BE(o), t = b.toString("latin1", o + 4, o + 8);
    if (t === "IHDR") {
      w = b.readUInt32BE(o + 8);
      h = b.readUInt32BE(o + 12);
      type = b[o + 17];
      if (b[o + 16] !== 8 || b[o + 20] !== 0) throw new Error("png: only 8 bits a channel, not interlaced");
    }
    if (t === "IDAT") idat.push(b.subarray(o + 8, o + 8 + len));
    o += len + 12;
  }
  const bpp = type === 6 ? 4 : type === 2 ? 3 : 0;
  if (!bpp) throw new Error(`png: colour type ${type} is not RGB or RGBA`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp, cur = new Uint8Array(stride), out = new Uint8Array(w * h * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, up = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) {
        const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      cur[i] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      out[(y * w + x) * 4] = cur[x * bpp];
      out[(y * w + x) * 4 + 1] = cur[x * bpp + 1];
      out[(y * w + x) * 4 + 2] = cur[x * bpp + 2];
      out[(y * w + x) * 4 + 3] = bpp === 4 ? cur[x * bpp + 3] : 255;
    }
    prev = cur.slice();
  }
  return { w, h, data: out };
}

export function encodePng(p: Picture): Buffer {
  const { w, h, data } = p;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(data.buffer, data.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  const chunk = (type: string, body: Buffer) => {
    const out = Buffer.alloc(body.length + 12);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, "latin1");
    body.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, body.length + 8)), body.length + 8);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

export function savePng(file: string, p: Picture): void {
  writeFileSync(file, encodePng(p));
}

/** A blank picture in one colour (r, g, b). */
export function blank(w: number, h: number, r: number, g: number, b: number): Picture {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  }
  return { w, h, data };
}

/** Copy the piece (sx, sy, w, h) of `from` into `to` at (x, y), every pixel `scale` big. */
export function paste(to: Picture, from: Picture, x: number, y: number, sx = 0, sy = 0, w = from.w - sx, h = from.h - sy, scale = 1): void {
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const o = ((sy + j) * from.w + sx + i) * 4;
      for (let q = 0; q < scale; q++) {
        for (let p = 0; p < scale; p++) {
          const X = x + i * scale + p, Y = y + j * scale + q;
          if (X < 0 || Y < 0 || X >= to.w || Y >= to.h) continue;
          to.data.set(from.data.subarray(o, o + 4), (Y * to.w + X) * 4);
        }
      }
    }
  }
}

/** How many pixels of two pictures differ (all of the larger one, if their sizes do). */
export function differing(a: Picture, b: Picture): number {
  if (a.w !== b.w || a.h !== b.h) return Math.max(a.w * a.h, b.w * b.h);
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2] || a.data[i + 3] !== b.data[i + 3]) n++;
  return n;
}
