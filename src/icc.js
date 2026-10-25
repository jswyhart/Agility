// An sRGB ICC profile (version 2, display class), built from the standard's
// published values: D50-adapted sRGB primaries and the sRGB tone curve.
// PDF/A needs an output intent with an embedded profile.

const enc = new TextEncoder();
const s15 = (v) => Math.round(v * 65536);

function tag(sig, body) {
  return { sig, body };
}

function xyz(x, y, z) {
  const b = new DataView(new ArrayBuffer(20));
  b.setUint32(0, 0x58595a20); // 'XYZ '
  b.setInt32(8, s15(x));
  b.setInt32(12, s15(y));
  b.setInt32(16, s15(z));
  return new Uint8Array(b.buffer);
}

function curve() {
  const n = 1024;
  const b = new DataView(new ArrayBuffer(12 + n * 2));
  b.setUint32(0, 0x63757276); // 'curv'
  b.setUint32(8, n);
  for (let i = 0; i < n; i++) {
    const c = i / (n - 1);
    const lin = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    b.setUint16(12 + i * 2, Math.round(lin * 65535));
  }
  return new Uint8Array(b.buffer);
}

function textDescription(text) {
  const ascii = enc.encode(`${text}\0`);
  const b = new Uint8Array(12 + ascii.length + 4 + 4 + 2 + 1 + 67);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0x64657363); // 'desc'
  v.setUint32(8, ascii.length);
  b.set(ascii, 12);
  return b;
}

function text(t) {
  const ascii = enc.encode(`${t}\0`);
  const b = new Uint8Array(8 + ascii.length);
  new DataView(b.buffer).setUint32(0, 0x74657874); // 'text'
  b.set(ascii, 8);
  return b;
}

const sig = (s) => [...s].reduce((n, c) => (n << 8) | c.charCodeAt(0), 0) >>> 0;

export function srgbProfile() {
  const trc = curve();
  const tags = [
    tag('desc', textDescription('sRGB IEC61966-2.1')),
    tag('cprt', text('No copyright, use freely')),
    tag('wtpt', xyz(0.9642, 1.0, 0.8249)),
    tag('rXYZ', xyz(0.4361, 0.2225, 0.0139)),
    tag('gXYZ', xyz(0.3851, 0.7169, 0.0971)),
    tag('bXYZ', xyz(0.1431, 0.0606, 0.7141)),
    tag('rTRC', trc),
    tag('gTRC', trc),
    tag('bTRC', trc),
  ];
  const tableSize = 4 + tags.length * 12;
  let offset = 128 + tableSize;
  const placed = new Map(); // shared data (the three curves) is stored once
  const entries = tags.map((t) => {
    if (!placed.has(t.body)) {
      placed.set(t.body, offset);
      offset += Math.ceil(t.body.length / 4) * 4;
    }
    return { sig: t.sig, offset: placed.get(t.body), size: t.body.length };
  });
  const out = new Uint8Array(offset);
  const v = new DataView(out.buffer);
  v.setUint32(0, offset); // profile size
  v.setUint32(8, 0x02100000); // version 2.1
  v.setUint32(12, sig('mntr'));
  v.setUint32(16, sig('RGB '));
  v.setUint32(20, sig('XYZ '));
  const now = new Date();
  [now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds()]
    .forEach((n, k) => v.setUint16(24 + k * 2, n));
  v.setUint32(36, sig('acsp'));
  v.setInt32(68, s15(0.9642)); // illuminant D50
  v.setInt32(72, s15(1.0));
  v.setInt32(76, s15(0.8249));
  v.setUint32(128, tags.length);
  entries.forEach((e, k) => {
    v.setUint32(132 + k * 12, sig(e.sig));
    v.setUint32(136 + k * 12, e.offset);
    v.setUint32(140 + k * 12, e.size);
  });
  for (const [body, at] of placed) out.set(body, at);
  return out;
}
