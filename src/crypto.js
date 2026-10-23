// Password protection: the PDF Standard Security Handler, revision 4 (AES-128),
// which every current PDF reader supports. pdf-lib can't encrypt, so this walks
// the document and encrypts each string and stream with its per-object key.

const { PDFDocument, PDFName, PDFDict, PDFArray, PDFString, PDFHexString, PDFNumber, PDFRawStream } = window.PDFLib;

const PAD = new Uint8Array([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

// ---- MD5 (RFC 1321) ----------------------------------------------------------------
const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

export function md5(data) {
  const len = data.length;
  const total = ((len + 8) >>> 6) * 64 + 64;
  const buf = new Uint8Array(total);
  buf.set(data);
  buf[len] = 0x80;
  const bits = len * 8;
  const view = new DataView(buf.buffer);
  view.setUint32(total - 8, bits >>> 0, true);
  view.setUint32(total - 4, Math.floor(bits / 2 ** 32), true);
  let [a0, b0, c0, d0] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  for (let off = 0; off < total; off += 64) {
    const M = Array.from({ length: 16 }, (_, i) => view.getUint32(off + i * 4, true));
    let [A, B, C, D] = [a0, b0, c0, d0];
    for (let i = 0; i < 64; i++) {
      let F;
      let g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((v, i) => ov.setUint32(i * 4, v, true));
  return out;
}

function rc4(key, data) {
  const s = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = new Uint8Array(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

const padPassword = (pw) => {
  const bytes = new TextEncoder().encode(pw).slice(0, 32);
  return concat(bytes, PAD.slice(0, 32 - bytes.length));
};

const md5Rounds = (h) => {
  for (let i = 0; i < 50; i++) h = md5(h.slice(0, 16));
  return h.slice(0, 16);
};

const rc4Rounds = (key, data) => {
  let out = rc4(key, data);
  for (let i = 1; i <= 19; i++) out = rc4(key.map((b) => b ^ i), out);
  return out;
};

const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

// ---- Encryption -----------------------------------------------------------------------

/**
 * Encrypt a PDF so it needs `userPassword` to open. `ownerPassword` (optional)
 * grants full rights; permissions: { print, copy, modify } (default all allowed).
 */
export async function encryptPdf(bytes, userPassword, ownerPassword, permissions = {}) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const { context } = doc;
  const owner = ownerPassword || toHex(crypto.getRandomValues(new Uint8Array(16)));
  const id0 = crypto.getRandomValues(new Uint8Array(16));
  context.trailerInfo.ID = context.obj([PDFHexString.of(toHex(id0)), PDFHexString.of(toHex(id0))]);

  // Permission bits (Table 22): 3 print, 4 modify, 5 copy, 6 annotate, 9 fill forms,
  // 10 accessibility copy, 11 assemble, 12 high-quality print. Reserved bits set.
  let P = 0xfffff0c0;
  if (permissions.print !== false) P |= (1 << 2) | (1 << 11);
  if (permissions.modify !== false) P |= (1 << 3) | (1 << 5) | (1 << 8) | (1 << 10);
  if (permissions.copy !== false) P |= (1 << 4) | (1 << 9);
  P |= 0; // as signed 32-bit
  const pBytes = new Uint8Array(4);
  new DataView(pBytes.buffer).setInt32(0, P, true);

  // Algorithm 3: the owner entry.
  const ownerKey = md5Rounds(md5(padPassword(owner)));
  const O = rc4Rounds(ownerKey, padPassword(userPassword));
  // Algorithm 2: the file key.
  const fileKey = md5Rounds(md5(concat(padPassword(userPassword), O, pBytes, id0)));
  // Algorithm 5: the user entry.
  const U = concat(rc4Rounds(fileKey, md5(concat(PAD, id0))), new Uint8Array(16));

  const keyFor = (ref) => {
    const n = ref.objectNumber;
    const g = ref.generationNumber;
    const salt = new Uint8Array([n & 255, (n >> 8) & 255, (n >> 16) & 255, g & 255, (g >> 8) & 255, 0x73, 0x41, 0x6c, 0x54]);
    return md5(concat(fileKey, salt)).slice(0, 16);
  };
  const aes = async (key, data) => {
    const iv = crypto.getRandomValues(new Uint8Array(16));
    const k = await crypto.subtle.importKey('raw', key, 'AES-CBC', false, ['encrypt']);
    return concat(iv, new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, k, data)));
  };

  // Encrypt the strings inside a direct object, returning its replacement.
  const encryptValue = async (key, value) => {
    if (value instanceof PDFString || value instanceof PDFHexString) return PDFHexString.of(toHex(await aes(key, value.asBytes())));
    if (value instanceof PDFArray) {
      for (let i = 0; i < value.size(); i++) value.set(i, await encryptValue(key, value.get(i)));
      return value;
    }
    if (value instanceof PDFDict) {
      for (const [k, v] of value.entries()) value.set(k, await encryptValue(key, v));
      return value;
    }
    return value;
  };

  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    const type = obj?.dict?.get(PDFName.of('Type'))?.toString() ?? (obj instanceof PDFDict ? obj.get(PDFName.of('Type'))?.toString() : null);
    if (type === '/XRef' || type === '/ObjStm') {
      context.delete(ref); // rewritten as a plain cross-reference table
      continue;
    }
    const key = keyFor(ref);
    if (obj?.dict instanceof PDFDict && typeof obj.getContents === 'function') {
      await encryptValue(key, obj.dict);
      context.assign(ref, PDFRawStream.of(obj.dict, await aes(key, obj.getContents())));
    } else {
      context.assign(ref, await encryptValue(key, obj));
    }
  }

  context.trailerInfo.Encrypt = context.register(context.obj({
    Filter: 'Standard', V: 4, R: 4, Length: 128,
    CF: { StdCF: { AuthEvent: 'DocOpen', CFM: 'AESV2', Length: 16 } },
    StmF: 'StdCF', StrF: 'StdCF',
    O: PDFHexString.of(toHex(O)), U: PDFHexString.of(toHex(U)), P: PDFNumber.of(P),
  }));
  return doc.save({ useObjectStreams: false, updateFieldAppearances: false });
}

