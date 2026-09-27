// Minimal EXIF writer: stamps the real "date taken" and a caption into a
// JPEG so photo apps (Google Photos, Apple Photos, ...) file old prints
// under the right year instead of the day they were scanned.

const enc = new TextEncoder();

/** Parse "1987", "1987-06", "1987-06-14" (also with / or .) to EXIF format. */
export function exifDate(input) {
  if (!input) return null;
  const m = String(input).trim().match(/^(\d{4})(?:[-/.](\d{1,2}))?(?:[-/.](\d{1,2}))?$/);
  if (!m) return null;
  const y = +m[1], mo = m[2] ? +m[2] : 1, d = m[3] ? +m[3] : 1;
  if (y < 1826 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${y}:${p(mo)}:${p(d)} 12:00:00`;
}

function nowExif() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Build one IFD. entries: [{ tag, type, count, value(Uint8Array for data | number) }]
function buildIfd(entries, startOffset, nextIfd = 0) {
  entries.sort((a, b) => a.tag - b.tag);
  const headerLen = 2 + entries.length * 12 + 4;
  let dataLen = 0;
  for (const e of entries) if (e.bytes && e.bytes.length > 4) dataLen += e.bytes.length + (e.bytes.length & 1);
  const out = new Uint8Array(headerLen + dataLen);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, entries.length);
  let dataPos = headerLen;
  entries.forEach((e, i) => {
    const o = 2 + i * 12;
    dv.setUint16(o, e.tag);
    dv.setUint16(o + 2, e.type);
    dv.setUint32(o + 4, e.count);
    if (e.bytes) {
      if (e.bytes.length <= 4) out.set(e.bytes, o + 8);
      else {
        dv.setUint32(o + 8, startOffset + dataPos);
        out.set(e.bytes, dataPos);
        dataPos += e.bytes.length + (e.bytes.length & 1);
      }
    } else if (e.type === 3) {
      dv.setUint16(o + 8, e.value);
    } else {
      dv.setUint32(o + 8, e.value);
    }
  });
  dv.setUint32(2 + entries.length * 12, nextIfd);
  return out;
}

const ascii = (s) => { const b = enc.encode(s); const o = new Uint8Array(b.length + 1); o.set(b); return o; };

function buildExif({ date, description, software }) {
  const ifd0 = [
    { tag: 0x0112, type: 3, count: 1, value: 1 }, // Orientation: already upright
    { tag: 0x0131, type: 2, bytes: ascii(software || 'Scan') },
  ];
  if (description) ifd0.push({ tag: 0x010E, type: 2, bytes: ascii(description) });
  if (date) ifd0.push({ tag: 0x0132, type: 2, bytes: ascii(date) });
  ifd0.push({ tag: 0x8769, type: 4, count: 1, value: 0 }); // patched below
  ifd0.forEach((e) => { if (e.bytes) e.count = e.bytes.length; });

  const exif = [{ tag: 0x9004, type: 2, bytes: ascii(nowExif()) }];
  if (date) exif.push({ tag: 0x9003, type: 2, bytes: ascii(date) });
  exif.forEach((e) => { e.count = e.bytes.length; });

  // First pass to learn IFD0's size, then point it at the Exif IFD.
  const first = buildIfd(ifd0.map((e) => ({ ...e })), 8);
  const exifOffset = 8 + first.length;
  ifd0.find((e) => e.tag === 0x8769).value = exifOffset;
  const ifd0Bytes = buildIfd(ifd0, 8);
  const exifBytes = buildIfd(exif, exifOffset);

  const tiff = new Uint8Array(8 + ifd0Bytes.length + exifBytes.length);
  tiff.set([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8]); // big-endian, IFD0 at 8
  tiff.set(ifd0Bytes, 8);
  tiff.set(exifBytes, 8 + ifd0Bytes.length);

  const payloadLen = 6 + tiff.length;
  const seg = new Uint8Array(4 + payloadLen);
  seg.set([0xff, 0xe1, (payloadLen + 2) >> 8, (payloadLen + 2) & 0xff]);
  seg.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4); // "Exif\0\0"
  seg.set(tiff, 10);
  return seg;
}

/** Return a copy of a JPEG blob with EXIF metadata. */
export async function withExif(blob, { date, description, software } = {}) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return blob;
  let pos = 2;
  // Drop the encoder's APP0 (JFIF) / APP1 segments; EXIF replaces them.
  while (pos + 4 <= buf.length && buf[pos] === 0xff && (buf[pos + 1] === 0xe0 || buf[pos + 1] === 0xe1)) {
    pos += 2 + ((buf[pos + 2] << 8) | buf[pos + 3]);
  }
  const seg = buildExif({ date: exifDate(date), description: (description || '').trim(), software });
  return new Blob([buf.subarray(0, 2), seg, buf.subarray(pos)], { type: 'image/jpeg' });
}
