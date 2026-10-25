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

// ---- Signing ----------------------------------------------------------------------

/**
 * Sign PDF bytes. opts: { certId, password, reason, location, contact,
 * visible: { page, rect: [x1, y1, x2, y2] (user space) } | null }.
 */
async function signPdf(store, bytes, opts) {
  const { pdflibAddPlaceholder } = require('@signpdf/placeholder-pdf-lib');
  const { P12Signer } = require('@signpdf/signer-p12');
  const signpdf = require('@signpdf/signpdf').default;
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
    name: who.name, location: opts.location || '', signingTime: now, signatureLength: 16384, widgetRect, appName: 'Agility',
  });
  const prepared = await doc.save({ useObjectStreams: false });
  const signed = await signpdf.sign(Buffer.from(prepared), new P12Signer(p12, { passphrase: opts.password }), now);
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
      const hex = text.slice(a + b + 1, c - 1).replace(/(00)+$/, '');
      const p7 = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(forge.util.hexToBytes(hex)));
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
      Object.assign(result, {
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

module.exports = { CertificateStore, signPdf, verifySignatures };
