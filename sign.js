// Certificate-based digital signatures (PAdES-style CMS, adbe.pkcs7.detached).
//
// Signing uses @signpdf with a PKCS#12 identity: one the user imports (.p12/.pfx
// from a certificate authority or their organization) or a self-signed one
// created here. Verification parses the CMS with node-forge but checks the
// digest and signature with Node's crypto (forge's own RSA verification has a
// known weakness), and checks the chain against Node's bundled root certificates.

const crypto = require('node:crypto');
const tls = require('node:tls');
const fs = require('node:fs/promises');
const path = require('node:path');
const forge = require('node-forge');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

// ---- Certificates ----------------------------------------------------------------

function certSummary(cert) {
  const attr = (list, name) => list.getField(name)?.value || '';
  return {
    name: attr(cert.subject, 'CN'),
    email: attr(cert.subject, 'E') || cert.subject.attributes.find((a) => a.name === 'emailAddress')?.value || '',
    org: attr(cert.subject, 'O'),
    issuer: attr(cert.issuer, 'CN') || attr(cert.issuer, 'O'),
    selfSigned: cert.isIssuer(cert),
    validTo: cert.validity.notAfter.toISOString(),
    fingerprint: crypto.createHash('sha256').update(Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary')).digest('hex'),
  };
}

function readP12(der, password) {
  const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.binary.raw.encode(new Uint8Array(der))), password);
  const certs = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
  const keys = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || []),
  ];
  if (!keys.length || !certs.length) throw new Error('This file has no signing key and certificate.');
  // The signing certificate is the one matching the private key.
  const key = keys[0].key;
  const own = certs.find((b) => b.cert.publicKey.n?.equals?.(key.n)) || certs[0];
  return { cert: own.cert, key };
}

/** Self-signed identity → PKCS#12 bytes protected by `password`. */
function createSelfSigned({ name, email, org }, password) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = forge.pki.privateKeyFromPem(privateKey.export({ type: 'pkcs1', format: 'pem' }));
  const pub = forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' }));
  const cert = forge.pki.createCertificate();
  cert.publicKey = pub;
  cert.serialNumber = crypto.randomBytes(9).toString('hex');
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 5 * 365 * 864e5);
  const attrs = [{ name: 'commonName', value: name }];
  if (org) attrs.push({ name: 'organizationName', value: org });
  if (email) attrs.push({ name: 'emailAddress', value: email });
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true },
    { name: 'extKeyUsage', emailProtection: true },
  ]);
  cert.sign(key, forge.md.sha256.create());
  const asn1 = forge.pkcs12.toPkcs12Asn1(key, [cert], password, { algorithm: 'aes256', friendlyName: name });
  return new Uint8Array(Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary'));
}

class CertificateStore {
  constructor(dir) {
    this.dir = dir;
  }

  async list() {
    try {
      return JSON.parse(await fs.readFile(path.join(this.dir, 'index.json'), 'utf8'));
    } catch {
      return [];
    }
  }

  async #save(list) {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(path.join(this.dir, 'index.json'), JSON.stringify(list, null, 2));
  }

  async #add(p12, password) {
    const { cert } = readP12(p12, password); // also checks the password
    const info = { id: crypto.randomUUID(), ...certSummary(cert), added: new Date().toISOString() };
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(path.join(this.dir, `${info.id}.p12`), p12);
    const list = (await this.list()).filter((c) => c.fingerprint !== info.fingerprint);
    await this.#save([info, ...list]);
    return info;
  }

  create(subject, password) {
    return this.#add(createSelfSigned(subject, password), password);
  }

  async import(file, password) {
    return this.#add(new Uint8Array(await fs.readFile(file)), password);
  }

  async remove(id) {
    await fs.rm(path.join(this.dir, `${id}.p12`), { force: true });
    await this.#save((await this.list()).filter((c) => c.id !== id));
  }

  async p12(id) {
    return fs.readFile(path.join(this.dir, `${id}.p12`));
  }
}

// ---- Timestamps (RFC 3161) ---------------------------------------------------------
// A timestamp authority countersigns the signature value with the current time.
// That proves the signature existed then, so it stays verifiable after the
// signer's certificate expires. Only a hash of the signature leaves the computer.

const { asn1 } = forge;
const U = asn1.Class.UNIVERSAL;
const OID_TIMESTAMP_TOKEN = '1.2.840.113549.1.9.16.2.14';
const OID_TST_INFO = '1.2.840.113549.1.9.16.1.4';
const DEFAULT_TSA = 'http://timestamp.digicert.com';
const bin = (s) => Buffer.from(s, 'binary');
const der = (node) => bin(asn1.toDer(node).getBytes());
const seq = (...items) => asn1.create(U, asn1.Type.SEQUENCE, true, items);
const oidNode = (oid) => asn1.create(U, asn1.Type.OID, false, asn1.oidToDer(oid).getBytes());
const isContext = (node, n) => node?.tagClass === asn1.Class.CONTEXT_SPECIFIC && node.type === n;

/** The pieces of a CMS SignedData (ContentInfo ASN.1) that signing and verifying need. */
function parseSignedData(contentInfo) {
  const sd = contentInfo.value[1].value[0].value;
  const encap = sd[2].value;
  const certSet = sd.find((n) => isContext(n, 0));
  const signerInfo = sd[sd.length - 1].value[0];
  const si = signerInfo.value;
  const signedAttrs = si.find((n) => isContext(n, 0));
  const unsignedAttrs = si.find((n, k) => k > 3 && isContext(n, 1));
  const signature = si.find((n, k) => k > 3 && n.tagClass === U && n.type === asn1.Type.OCTETSTRING);
  let content = null;
  if (encap[1]) {
    const octets = encap[1].value[0];
    // Usually one OCTET STRING; a constructed one is its pieces joined.
    content = bin(typeof octets.value === 'string' ? octets.value : octets.value.map((p) => p.value).join(''));
  }
  return {
    contentType: asn1.derToOid(encap[0].value),
    content,
    certs: (certSet?.value || []).map((c) => { try { return new crypto.X509Certificate(der(c)); } catch { return null; } }).filter(Boolean),
    signerInfo,
    serial: si[1].value?.[1]?.value ? bin(si[1].value[1].value).toString('hex').replace(/^(00)+/, '') : null,
    digestOid: asn1.derToOid(si[2].value[0].value),
    signedAttrs: signedAttrs?.value || null,
    unsignedAttrs: unsignedAttrs?.value || [],
    signature: bin(signature.value),
  };
}

const attrValue = (attrs, oid) => (attrs || []).find((a) => asn1.derToOid(a.value[0].value) === oid)?.value[1].value[0];

/** Ask a timestamp authority for a token over `signature` (Buffer). Returns the token's ASN.1. */
async function requestTimestamp(url, signature) {
  const hash = crypto.createHash('sha256').update(signature).digest();
  const nonce = crypto.randomBytes(8);
  nonce[0] &= 0x7f; // a positive INTEGER
  if (nonce[0] === 0) nonce[0] = 1;
  const request = der(seq(
    asn1.create(U, asn1.Type.INTEGER, false, asn1.integerToDer(1).getBytes()),
    seq(seq(oidNode(forge.pki.oids.sha256), asn1.create(U, asn1.Type.NULL, false, '')), asn1.create(U, asn1.Type.OCTETSTRING, false, hash.toString('binary'))),
    asn1.create(U, asn1.Type.INTEGER, false, nonce.toString('binary')),
    asn1.create(U, asn1.Type.BOOLEAN, false, '\xff'), // certReq: include the authority's certificate
  ));
  let body;
  try {
    const res = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/timestamp-query' }, body: request, signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`the server answered ${res.status}`);
    body = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    throw new Error(`Couldn't get a timestamp from ${url} (${err.cause?.code || err.cause?.errors?.[0]?.code || err.message}). Check the connection and the server address, or sign without a timestamp.`);
  }
  let token;
  let info;
  try {
    const response = asn1.fromDer(body.toString('binary'));
    const status = response.value[0].value[0].value.charCodeAt(0);
    if (status > 1 || !response.value[1]) throw new Error(`request refused (status ${status})`);
    token = response.value[1];
    info = readTimestampToken(token);
  } catch (err) {
    throw new Error(`The timestamp server at ${url} sent an answer that can't be used (${err.message}).`);
  }
  if (!info.imprint.equals(hash) || (info.nonce && info.nonce !== nonce.toString('hex'))) {
    throw new Error(`The timestamp from ${url} is for different data; not using it.`);
  }
  return token;
}

/** Read and check a timestamp token (ASN.1): who issued it, when, over which hash. */
function readTimestampToken(token) {
  const sd = parseSignedData(token);
  if (sd.contentType !== OID_TST_INFO || !sd.content) throw new Error('not a timestamp token');
  const tst = asn1.fromDer(sd.content.toString('binary')).value;
  const imprint = tst[2].value;
  const genTime = tst.find((n, k) => k > 2 && n.tagClass === U && n.type === asn1.Type.GENERALIZEDTIME);
  const nonce = tst.find((n, k) => k > 4 && n.tagClass === U && n.type === asn1.Type.INTEGER);
  // The authority's certificate: the one the signer info names, else whichever verifies.
  const named = sd.certs.find((c) => c.serialNumber.toLowerCase().replace(/^(00)+/, '') === sd.serial);
  const alg = DIGESTS[sd.digestOid] || 'sha256';
  let cert = named || sd.certs[0];
  let valid = false;
  if (sd.signedAttrs) {
    const md = attrValue(sd.signedAttrs, forge.pki.oids.messageDigest);
    const digestOk = md && bin(md.value).equals(crypto.createHash(alg).update(sd.content).digest());
    const signedBytes = der(asn1.create(U, asn1.Type.SET, true, sd.signedAttrs));
    const verifies = (c) => { try { return crypto.verify(alg, signedBytes, c.publicKey, sd.signature); } catch { return false; } };
    const signer = digestOk ? (named ? [named] : sd.certs).find(verifies) : null;
    if (signer) {
      cert = signer;
      valid = true;
    }
  }
  return {
    valid,
    time: asn1.generalizedTimeToDate(genTime.value),
    imprint: bin(imprint[1].value),
    imprintAlg: DIGESTS[asn1.derToOid(imprint[0].value[0].value)] || 'sha256',
    nonce: nonce ? bin(nonce.value).toString('hex') : null,
    authority: cert ? (cert.subject.match(/CN=([^\n]+)/) || [])[1] || cert.subject : '',
    trusted: !!cert && chainTrusted(cert, sd.certs),
  };
}

// ---- Signing ----------------------------------------------------------------------

/**
 * Sign PDF bytes. opts: { certId, password, reason, location, contact,
 * visible: { page, rect: [x1, y1, x2, y2] (user space) } | null,
 * timestampUrl: a timestamp authority to countersign the signing time, or '' }.
 */
async function signPdf(store, bytes, opts) {
  const { pdflibAddPlaceholder } = require('@signpdf/placeholder-pdf-lib');
  const { P12Signer } = require('@signpdf/signer-p12');
  const signpdf = require('@signpdf/signpdf').default;
  const tsa = (opts.timestampUrl || '').trim();
  if (tsa && !/^https?:\/\//i.test(tsa)) throw new Error('The timestamp server address must start with http:// or https://');
  // The same signer, with the authority's token added as an unsigned attribute.
  class TimestampingSigner extends P12Signer {
    async sign(pdfBuffer, signingTime) {
      const cms = asn1.fromDer((await super.sign(pdfBuffer, signingTime)).toString('binary'));
      const { signerInfo, signature } = parseSignedData(cms);
      const token = await requestTimestamp(tsa, signature);
      signerInfo.value.push(asn1.create(asn1.Class.CONTEXT_SPECIFIC, 1, true, [
        seq(oidNode(OID_TIMESTAMP_TOKEN), asn1.create(U, asn1.Type.SET, true, [token])),
      ]));
      return der(cms);
    }
  }
  const p12 = await store.p12(opts.certId);
  const { cert } = readP12(p12, opts.password); // a clear error for a wrong password
  const who = certSummary(cert);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const now = new Date();
  let widgetRect = [0, 0, 0, 0];
  let page = doc.getPage(0);
  if (opts.visible) {
    page = doc.getPage(opts.visible.page);
    widgetRect = opts.visible.rect;
    // The visible stamp is part of the page, so it is covered by the signature.
    const [x1, y1, x2, y2] = widgetRect;
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const w = x2 - x1;
    const h = y2 - y1;
    page.drawRectangle({ x: x1, y: y1, width: w, height: h, borderColor: rgb(0.11, 0.3, 0.73), borderWidth: 1, color: rgb(0.95, 0.97, 1) });
    const lines = [
      [bold, `Digitally signed by ${who.name}`],
      [font, `Date: ${now.toLocaleString()}`],
      ...(opts.reason ? [[font, `Reason: ${opts.reason}`]] : []),
      ...(opts.location ? [[font, `Location: ${opts.location}`]] : []),
    ];
    // Fit every line in the box (1.25 line spacing, a small margin).
    const size = Math.max(5, Math.min(11, (h - 8) / (lines.length * 1.25 + 0.25)));
    lines.forEach(([f, text], k) => {
      let t = text;
      while (t.length > 4 && f.widthOfTextAtSize(t, size) > w - 8) t = `${t.slice(0, -2)}…`;
      page.drawText(t.replace(/[^\x20-\xff]/g, '?'), { x: x1 + 4, y: y2 - 4 - size * (k + 1) * 1.25, size, font: f, color: rgb(0.1, 0.15, 0.35) });
    });
  }
  pdflibAddPlaceholder({
    pdfDoc: doc, pdfPage: page, reason: opts.reason || 'Signed', contactInfo: opts.contact || who.email || '',
    name: who.name, location: opts.location || '', signingTime: now, signatureLength: tsa ? 32768 : 16384, widgetRect, appName: 'Agility',
  });
  const prepared = await doc.save({ useObjectStreams: false });
  const signed = await signpdf.sign(Buffer.from(prepared), new (tsa ? TimestampingSigner : P12Signer)(p12, { passphrase: opts.password }), now);
  return new Uint8Array(signed);
}

// ---- Verification -------------------------------------------------------------------

const DIGESTS = {
  [forge.pki.oids.sha1]: 'sha1', [forge.pki.oids.sha256]: 'sha256', [forge.pki.oids.sha384]: 'sha384', [forge.pki.oids.sha512]: 'sha512',
};
let roots = null;
const rootCerts = () => (roots ||= tls.rootCertificates.map((pem) => { try { return new crypto.X509Certificate(pem); } catch { return null; } }).filter(Boolean));

// Is `leaf` (X509Certificate) issued, via `chain`, by a bundled root certificate?
function chainTrusted(leaf, chain) {
  let cur = leaf;
  for (let depth = 0; depth < 8; depth++) {
    const root = rootCerts().find((r) => cur.checkIssued(r) && cur.verify(r.publicKey));
    if (root) return true;
    const next = chain.find((c) => c !== cur && cur.checkIssued(c) && cur.verify(c.publicKey));
    if (!next) return false;
    cur = next;
  }
  return false;
}

/** Check every signature in a PDF. ownFingerprints: certificates of this user's own identities. */
function verifySignatures(bytes, ownFingerprints = []) {
  const buf = Buffer.from(bytes);
  const text = buf.toString('latin1');
  const results = [];
  const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  for (let m; (m = re.exec(text));) {
    const [a, b, c, d] = m.slice(1).map(Number);
    const result = { intact: false, coversWholeFile: c + d === buf.length };
    try {
      // The CMS is zero-padded to fill its placeholder; its own length says where it ends
      // (stripping trailing zeros would also eat a signature that happens to end in 00).
      const padded = Buffer.from(text.slice(a + b + 1, c - 1).replace(/[^0-9a-fA-F]/g, ''), 'hex');
      const lenBytes = padded[1] & 0x80 ? padded[1] & 0x7f : 0;
      const cmsLength = 2 + lenBytes + (lenBytes ? padded.readUIntBE(2, lenBytes) : padded[1]);
      const p7 = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(padded.subarray(0, cmsLength).toString('binary')));
      const signed = Buffer.concat([buf.subarray(a, a + b), buf.subarray(c, c + d)]);
      const cap = p7.rawCapture;
      const alg = DIGESTS[forge.asn1.derToOid(cap.digestAlgorithm)] || 'sha256';
      const attrs = cap.authenticatedAttributes || [];
      const attr = (oid) => attrs.find((x) => forge.asn1.derToOid(x.value[0].value) === oid)?.value[1].value[0];
      const md = attr(forge.pki.oids.messageDigest);
      const time = attr(forge.pki.oids.signingTime);
      const certs = p7.certificates.map((x) => new crypto.X509Certificate(Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(x)).getBytes(), 'binary')));
      const signer = certs[0];
      const digestOk = md && Buffer.from(md.value, 'binary').equals(crypto.createHash(alg).update(signed).digest());
      // The signature covers the DER of the signed attributes as a SET.
      const set = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, attrs);
      const sigOk = crypto.verify(alg, Buffer.from(forge.asn1.toDer(set).getBytes(), 'binary'), signer.publicKey, Buffer.from(cap.signature, 'binary'));
      const fingerprint = crypto.createHash('sha256').update(signer.raw).digest('hex');
      const signerName = (signer.subject.match(/CN=([^\n]+)/) || [])[1] || signer.subject;
      // The signature dictionary (the object holding /ByteRange) has the reason and location,
      // as literal or hex strings.
      const dict = text.slice(text.lastIndexOf(' obj', m.index), text.indexOf('endobj', m.index));
      const field = (k) => {
        const lit = dict.match(new RegExp(`/${k}\\s*\\(((?:\\\\.|[^)])*)\\)`));
        if (lit) return lit[1].replace(/\\(.)/g, '$1');
        const hx = dict.match(new RegExp(`/${k}\\s*<([0-9a-fA-F]*)>`));
        if (!hx) return '';
        const raw = Buffer.from(hx[1], 'hex');
        return raw[0] === 0xfe && raw[1] === 0xff ? raw.subarray(2).swap16().toString('utf16le') : raw.toString('latin1');
      };
      // A timestamp token, if the signer asked an authority for one.
      let timestamp = null;
      const token = attrValue(cap.unauthenticatedAttributes, OID_TIMESTAMP_TOKEN);
      if (token) {
        try {
          const t = readTimestampToken(token);
          const matches = t.imprint.equals(crypto.createHash(t.imprintAlg).update(Buffer.from(cap.signature, 'binary')).digest());
          timestamp = { valid: t.valid && matches, time: t.time.toISOString(), authority: t.authority, trusted: t.trusted };
        } catch {
          timestamp = { valid: false, time: null, authority: '', trusted: false };
        }
      }
      const provenTime = timestamp?.valid ? new Date(timestamp.time) : null;
      Object.assign(result, {
        timestamp,
        // Expired now, with no timestamp proving it was signed while still valid.
        certExpired: new Date(signer.validTo) < new Date(),
        signedWhileValid: !!provenTime && provenTime >= new Date(signer.validFrom) && provenTime <= new Date(signer.validTo),
        intact: !!(digestOk && sigOk),
        signer: signerName,
        issuer: (signer.issuer.match(/CN=([^\n]+)/) || [])[1] || signer.issuer,
        selfSigned: signer.subject === signer.issuer,
        trusted: chainTrusted(signer, certs),
        own: ownFingerprints.includes(fingerprint),
        signedAt: time ? forge.asn1.utcTimeToDate?.(time.value)?.toISOString?.() ?? null : null,
        reason: field('Reason'),
        location: field('Location'),
        validTo: signer.validTo,
      });
    } catch (err) {
      result.error = err.message;
    }
    results.push(result);
  }
  return results;
}

module.exports = { CertificateStore, signPdf, verifySignatures, DEFAULT_TSA };
