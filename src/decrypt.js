// Opening password-protected PDFs for editing.
//
// pdf-lib can't read encrypted files, so this decrypts at the byte level first:
// it finds each "n g obj … endobj", decrypts its strings and stream data with
// the object's key, and writes a plain file that pdf-lib can parse (pdf-lib
// scans objects rather than trusting the cross-reference table). Supports the
// Standard security handler, revisions 2–6 (RC4 40–128, AES-128, AES-256).

import { md5 } from './crypto.js';

const PAD = new Uint8Array([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

const latin1 = (b) => { let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return s; };
const fromLatin1 = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 255);
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
const equal = (a, b, n = a.length) => { for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false; return true; };

function rc4(key, data) {
  const s = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; [s[i], s[j]] = [s[j], s[i]]; }
  const out = new Uint8Array(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255; j = (j + s[i]) & 255; [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

async function aesDecrypt(key, data, { iv: givenIv = null } = {}) {
  const iv = givenIv || data.subarray(0, 16);
  const body = givenIv ? data : data.subarray(16);
  if (!body.length) return new Uint8Array();
  const k = await crypto.subtle.importKey('raw', key, 'AES-CBC', false, ['decrypt']);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, k, body));
  } catch {
    // Bad padding: decrypt with a valid padding block appended, then drop it.
    const pad = await crypto.subtle.importKey('raw', key, 'AES-CBC', false, ['encrypt']);
    const last = body.subarray(body.length - 16);
    const extra = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: last }, pad, new Uint8Array(0)));
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, k, concat(body, extra.subarray(0, 16))));
    return plain;
  }
}

async function aesEncryptRaw(key, iv, data) {
  // AES-CBC without padding (output truncated to the input length).
  const k = await crypto.subtle.importKey('raw', key, 'AES-CBC', false, ['encrypt']);
  return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, k, data)).subarray(0, data.length);
}

const sha = async (alg, data) => new Uint8Array(await crypto.subtle.digest(alg, data));

// ---- Reading the encryption dictionary -------------------------------------------------

// A tiny reader for the few PDF values we need (numbers, names, strings, dicts).
function readValue(s, i) {
  const ws = /\s/;
  while (i < s.length && (ws.test(s[i]) || s[i] === '%')) {
    if (s[i] === '%') while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++;
    else i++;
  }
  const c = s[i];
  if (c === '<' && s[i + 1] === '<') {
    const dict = {};
    i += 2;
    for (;;) {
      while (ws.test(s[i])) i++;
      if (s[i] === '>' && s[i + 1] === '>') return [dict, i + 2];
      const [key, j] = readValue(s, i);
      const [val, k] = readValue(s, j);
      dict[key] = val;
      i = k;
    }
  }
  if (c === '<') {
    const end = s.indexOf('>', i);
    const hex = s.slice(i + 1, end).replace(/\s/g, '');
    const bytes = new Uint8Array(Math.ceil(hex.length / 2));
    for (let k = 0; k < bytes.length; k++) bytes[k] = parseInt(hex.substr(k * 2, 2).padEnd(2, '0'), 16);
    return [{ bytes }, end + 1];
  }
  if (c === '(') {
    const [bytes, end] = readLiteral(s, i);
    return [{ bytes }, end];
  }
  if (c === '/') {
    let j = i + 1;
    while (j < s.length && !/[\s/<>[\]()%{}]/.test(s[j])) j++;
    return [s.slice(i, j), j];
  }
  if (c === '[') {
    const arr = [];
    i++;
    for (;;) {
      while (ws.test(s[i])) i++;
      if (s[i] === ']') return [arr, i + 1];
      const [v, j] = readValue(s, i);
      arr.push(v);
      i = j;
    }
  }
  const m = /^[+-]?\d*\.?\d+(\s+\d+\s+R)?|^(true|false|null)/.exec(s.slice(i, i + 40));
  if (m) {
    if (m[1]) {
      const [num, gen] = m[0].split(/\s+/);
      return [{ ref: [Number(num), Number(gen)] }, i + m[0].length];
    }
    return [m[2] ? m[2] : Number(m[0]), i + m[0].length];
  }
  return [null, i + 1];
}

function readLiteral(s, i) {
  const out = [];
  let depth = 1;
  i++;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 0x5c) {
      const n = s[++i];
      const map = { n: 10, r: 13, t: 9, b: 8, f: 12 };
      if (n in map) out.push(map[n]);
      else if (n >= '0' && n <= '7') {
        let v = n.charCodeAt(0) - 48;
        for (let k = 0; k < 2 && s[i + 1] >= '0' && s[i + 1] <= '7'; k++) v = v * 8 + (s.charCodeAt(++i) - 48);
        out.push(v & 255);
      } else if (n === '\r') { if (s[i + 1] === '\n') i++; } else if (n !== '\n') out.push(n.charCodeAt(0));
      i++;
      continue;
    }
    if (c === 0x28) depth++;
    if (c === 0x29 && --depth === 0) return [new Uint8Array(out), i + 1];
    out.push(c);
    i++;
  }
  return [new Uint8Array(out), i];
}

// Where each object starts: "n g obj" positions (last definition wins, like incremental updates).
function indexObjects(s) {
  const objs = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  for (let m; (m = re.exec(s));) objs.set(`${m[1]} ${m[2]}`, { num: Number(m[1]), gen: Number(m[2]), start: m.index, body: m.index + m[0].length });
  return objs;
}

function resolve(s, objs, v) {
  if (v && v.ref) {
    const o = objs.get(v.ref.join(' '));
    return o ? readValue(s, o.body)[0] : null;
  }
  return v;
}

// /Encrypt and /ID live in the trailer (or the cross-reference stream dictionary);
// the last occurrence is the newest revision's.
function findTrailerValue(s, key) {
  const re = new RegExp(`/${key}(?=[\\s\\[<(/0-9])`, 'g');
  let last = null;
  for (let m; (m = re.exec(s));) last = m;
  return last ? readValue(s, last.index + key.length + 1)[0] : null;
}

// ---- Keys ------------------------------------------------------------------------------

const padPassword = (pw) => {
  const b = new TextEncoder().encode(pw).slice(0, 32);
  return concat(b, PAD.slice(0, 32 - b.length));
};

function legacyFileKey(enc, idFirst, password) {
  const n = enc.R === 2 ? 5 : (enc.Length || 40) / 8;
  const p = new Uint8Array(4);
  new DataView(p.buffer).setInt32(0, enc.P, true);
  const parts = [padPassword(password), enc.O, p, idFirst];
  if (enc.R >= 4 && enc.EncryptMetadata === 'false') parts.push(new Uint8Array([255, 255, 255, 255]));
  let h = md5(concat(...parts));
  if (enc.R >= 3) for (let i = 0; i < 50; i++) h = md5(h.subarray(0, n));
  return h.subarray(0, n);
}

function legacyUserCheck(enc, idFirst, key) {
  if (enc.R === 2) return equal(rc4(key, PAD), enc.U, 32);
  let x = rc4(key, md5(concat(PAD, idFirst)));
  for (let i = 1; i <= 19; i++) x = rc4(key.map((b) => b ^ i), x);
  return equal(x, enc.U, 16);
}

function legacyOwnerToUser(enc, ownerPw) {
  const n = enc.R === 2 ? 5 : (enc.Length || 40) / 8;
  let h = md5(padPassword(ownerPw));
  if (enc.R >= 3) for (let i = 0; i < 50; i++) h = md5(h.subarray(0, n));
  const key = h.subarray(0, n);
  let x = enc.O.slice(0, 32);
  if (enc.R === 2) x = rc4(key, x);
  else for (let i = 19; i >= 0; i--) x = rc4(key.map((b) => b ^ i), x);
  // The result is the padded user password; trim the padding back off.
  for (let k = 0; k <= 32; k++) if (equal(x.subarray(k), PAD, 32 - k)) return new TextDecoder('latin1').decode(x.subarray(0, k));
  return new TextDecoder('latin1').decode(x);
}

// Algorithm 2.B (revision 6) / plain SHA-256 (revision 5).
async function hash6(password, salt, userKey, R) {
  let K = await sha('SHA-256', concat(password, salt, userKey));
  if (R === 5) return K;
  // At least 64 rounds, then until the last byte of E is <= rounds done - 32.
  for (let done = 0; ;) {
    const K1 = concat(...Array(64).fill(concat(password, K, userKey)));
    const E = await aesEncryptRaw(K.subarray(0, 16), K.subarray(16, 32), K1);
    const mod = E.subarray(0, 16).reduce((acc, b) => acc + b, 0) % 3;
    K = await sha(['SHA-256', 'SHA-384', 'SHA-512'][mod], E);
    done++;
    if (done >= 64 && E[E.length - 1] <= done - 32) break;
  }
  return K.subarray(0, 32);
}

async function aes256FileKey(enc, password) {
  const pw = new TextEncoder().encode(password).slice(0, 127);
  const U = enc.U;
  const O = enc.O;
  const asOwner = equal(await hash6(pw, O.subarray(32, 40), U.subarray(0, 48), enc.R), O, 32);
  const asUser = !asOwner && equal(await hash6(pw, U.subarray(32, 40), new Uint8Array(), enc.R), U, 32);
  if (!asOwner && !asUser) return null;
  const k = asOwner ? await hash6(pw, O.subarray(40, 48), U.subarray(0, 48), enc.R) : await hash6(pw, U.subarray(40, 48), new Uint8Array(), enc.R);
  const wrapped = asOwner ? enc.OE : enc.UE;
  // OE/UE are unpadded; aesDecrypt copes with that.
  const fileKey = await aesDecrypt(k, wrapped, { iv: new Uint8Array(16) });
  return { key: fileKey.subarray(0, 32), owner: asOwner };
}

// ---- Public API ----------------------------------------------------------------------

/** Quick check: does this file use the Standard security handler? */
export function isEncrypted(bytes) {
  return /\/Encrypt\s+\d+\s+\d+\s+R|\/Encrypt\s*<</.test(latin1(bytes.subarray(Math.max(0, bytes.length - 4096))))
    || /\/Encrypt\s+\d+\s+\d+\s+R/.test(latin1(bytes));
}

/**
 * Decrypt a PDF. Tries `password` as the owner password, then as the user
 * password. Returns { bytes, owner, permissions } or null if the password is
 * wrong. permissions: { print, modify, copy, annotate, fill }.
 */
export async function decryptPdf(bytes, password = '') {
  const s = latin1(bytes);
  const objs = indexObjects(s);
  const encRaw = findTrailerValue(s, 'Encrypt');
  const encRef = encRaw?.ref ? encRaw.ref.join(' ') : null;
  const encDict = resolve(s, objs, encRaw);
  if (!encDict || encDict['/Filter'] !== '/Standard') throw new Error('Unsupported encryption');
  const idArr = resolve(s, objs, findTrailerValue(s, 'ID'));
  const idFirst = idArr?.[0]?.bytes || new Uint8Array();
  const num = (v) => resolve(s, objs, v);
  const enc = {
    V: num(encDict['/V']) || 0, R: num(encDict['/R']), Length: num(encDict['/Length']) || 40, P: num(encDict['/P']) | 0,
    O: encDict['/O'].bytes, U: encDict['/U'].bytes, OE: encDict['/OE']?.bytes, UE: encDict['/UE']?.bytes,
    EncryptMetadata: encDict['/EncryptMetadata'],
  };

  // Which cipher strings and streams use (V4+ crypt filters; earlier versions RC4).
  let method = 'rc4';
  if (enc.V >= 4) {
    const cf = encDict['/CF'] || {};
    const filter = cf[encDict['/StmF']] || cf['/StdCF'] || {};
    const cfm = filter['/CFM'];
    method = cfm === '/AESV2' ? 'aes128' : cfm === '/AESV3' ? 'aes256' : cfm === '/None' ? 'none' : 'rc4';
    if (enc.V === 4 && filter['/Length']) enc.Length = filter['/Length'] < 40 ? filter['/Length'] * 8 : filter['/Length'];
  }

  let fileKey;
  let owner = false;
  if (enc.R >= 5) {
    const r = await aes256FileKey(enc, password);
    if (!r) return null;
    fileKey = r.key;
    owner = r.owner;
  } else {
    const asOwnerUser = legacyOwnerToUser(enc, password);
    const ownerKey = legacyFileKey(enc, idFirst, asOwnerUser);
    if (legacyUserCheck(enc, idFirst, ownerKey)) {
      fileKey = ownerKey;
      owner = true;
    } else {
      const userKey = legacyFileKey(enc, idFirst, password);
      if (!legacyUserCheck(enc, idFirst, userKey)) return null;
      fileKey = userKey;
    }
  }

  const objectKey = (n, g) => {
    if (method === 'aes256') return fileKey;
    const salt = method === 'aes128' ? [0x73, 0x41, 0x6c, 0x54] : [];
    const h = md5(concat(fileKey, new Uint8Array([n & 255, (n >> 8) & 255, (n >> 16) & 255, g & 255, (g >> 8) & 255, ...salt])));
    return h.subarray(0, Math.min(fileKey.length + 5, 16));
  };
  const decryptBytes = (key, data) => (method === 'none' ? data : method === 'rc4' ? rc4(key, data) : aesDecrypt(key, data));

  // Rewrite every object: decrypted strings become hex strings, stream data is
  // decrypted and its /Length fixed.
  const out = [];
  let cursor = 0;
  const ordered = [...objs.values()].sort((a, b) => a.start - b.start);
  for (let k = 0; k < ordered.length; k++) {
    const o = ordered[k];
    const end = s.indexOf('endobj', o.body);
    if (end < 0) continue;
    const key = `${o.num} ${o.gen}`;
    const bodyText = s.slice(o.body, end);
    if (key === encRef || /\/Type\s*\/XRef\b/.test(bodyText.slice(0, 400))) {
      out.push(s.slice(cursor, end));
      cursor = end;
      continue;
    }
    out.push(s.slice(cursor, o.body));
    const ok = objectKey(o.num, o.gen);
    out.push(await rewriteObject(s, o.body, end, ok, decryptBytes, objs, method === 'none' || (enc.EncryptMetadata === 'false' && /\/Type\s*\/Metadata/.test(bodyText.slice(0, 300)))));
    cursor = end;
  }
  out.push(s.slice(cursor));
  let plain = out.join('');
  // Drop the encryption reference from trailers / xref stream dictionaries.
  plain = plain.replace(/\/Encrypt\s+\d+\s+\d+\s+R/g, '');

  const P = enc.P;
  const bit = (n) => (P & (1 << (n - 1))) !== 0;
  return {
    bytes: fromLatin1(plain),
    owner,
    permissions: { print: bit(3), modify: bit(4), copy: bit(5), annotate: bit(6), fill: bit(9) || bit(6) },
  };
}

// Decrypt the strings in s[from, to) and, if present, the stream that follows the dict.
async function rewriteObject(s, from, to, key, decryptBytes, objs, skipStream) {
  const parts = [];
  let i = from;
  let last = from;
  let dictLength = null;
  while (i < to) {
    const c = s[i];
    if (c === '%') { while (i < to && s[i] !== '\n' && s[i] !== '\r') i++; continue; }
    if (c === '(') {
      const [bytes, j] = readLiteral(s, i);
      parts.push(s.slice(last, i), hexOf(await decryptBytes(key, bytes)));
      i = last = j;
      continue;
    }
    if (c === '<' && s[i + 1] !== '<') {
      const [{ bytes }, j] = readValue(s, i);
      parts.push(s.slice(last, i), hexOf(await decryptBytes(key, bytes)));
      i = last = j;
      continue;
    }
    if (c === '<' && s[i + 1] === '<') { i += 2; continue; }
    if (c === '/' && s.startsWith('/Length', i) && !/[A-Za-z0-9]/.test(s[i + 7])) {
      const [v] = readValue(s, i + 7);
      dictLength = resolve(s, objs, v);
    }
    if (s.startsWith('stream', i) && /\s/.test(s[i - 1] ?? ' ') && (s[i + 6] === '\r' || s[i + 6] === '\n')) {
      let start = i + 6;
      if (s[start] === '\r') start++;
      if (s[start] === '\n') start++;
      let len = typeof dictLength === 'number' ? dictLength : -1;
      if (len < 0 || !/^\s*endstream/.test(s.slice(start + len, start + len + 24))) {
        const e = s.indexOf('endstream', start);
        len = e - start;
        while (len > 0 && (s[start + len - 1] === '\n' || s[start + len - 1] === '\r')) len--;
      }
      const data = fromLatin1(s.slice(start, start + len));
      const plain = skipStream ? data : await decryptBytes(key, data);
      // Put the real length into the dictionary (it may have been an indirect ref).
      let head = parts.join('') + s.slice(last, i);
      parts.length = 0;
      head = head.replace(/\/Length\s+(\d+\s+\d+\s+R|\d+)/, `/Length ${plain.length}`);
      const tailStart = s.indexOf('endstream', start + len);
      return `${head}stream\n${latin1(plain)}\n${s.slice(tailStart, to)}`;
    }
    i++;
  }
  parts.push(s.slice(last, to));
  return parts.join('');
}

const hexOf = (b) => `<${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}>`;
