// Minimal store-only (uncompressed) ZIP writer — no dependencies.
// SVG compresses well, but bundling a deflate implementation isn't worth it
// for a handful of files that go straight into laser software.

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosStamp(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

class Buf {
  constructor() { this.parts = []; this.len = 0; }
  push(u8) { this.parts.push(u8); this.len += u8.length; return this; }
  u16(v) { return this.push(new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF])); }
  u32(v) { return this.push(new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF])); }
  concat() {
    const out = new Uint8Array(this.len);
    let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

/**
 * @param files {Array<{name:string, data:string|Uint8Array}>}
 * @returns Blob
 */
export function makeZip(files) {
  const enc = new TextEncoder();
  const { time, date } = dosStamp(new Date());
  const body = new Buf();
  const central = new Buf();
  let offset = 0;

  for (const f of files) {
    const name = enc.encode(f.name);
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = crc32(data);

    const local = new Buf();
    local.u32(0x04034B50).u16(20).u16(0x0800).u16(0)      // store, UTF-8 names
         .u16(time).u16(date).u32(crc).u32(data.length).u32(data.length)
         .u16(name.length).u16(0).push(name).push(data);
    const chunk = local.concat();
    body.push(chunk);

    central.u32(0x02014B50).u16(20).u16(20).u16(0x0800).u16(0)
           .u16(time).u16(date).u32(crc).u32(data.length).u32(data.length)
           .u16(name.length).u16(0).u16(0).u16(0).u16(0).u32(0)
           .u32(offset).push(name);

    offset += chunk.length;
  }

  const cd = central.concat();
  const end = new Buf();
  end.u32(0x06054B50).u16(0).u16(0).u16(files.length).u16(files.length)
     .u32(cd.length).u32(offset).u16(0);

  const out = new Buf().push(body.concat()).push(cd).push(end.concat());
  return new Blob([out.concat()], { type: 'application/zip' });
}

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
