// A small RFC 3161 timestamp authority for the tests: answers timestamp requests
// over HTTP with real, verifiable tokens signed by a throwaway certificate.
import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const forge = createRequire(import.meta.url)('node-forge');
const { asn1 } = forge;
const U = asn1.Class.UNIVERSAL;
const OID_TST_INFO = '1.2.840.113549.1.9.16.1.4';
const seq = (...items) => asn1.create(U, asn1.Type.SEQUENCE, true, items);
const oid = (o) => asn1.create(U, asn1.Type.OID, false, asn1.oidToDer(o).getBytes());
const int = (n) => asn1.create(U, asn1.Type.INTEGER, false, asn1.integerToDer(n).getBytes());

function identity(name) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = forge.pki.privateKeyFromPem(privateKey.export({ type: 'pkcs1', format: 'pem' }));
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' }));
  cert.serialNumber = '01f3a9';
  cert.validity.notBefore = new Date(Date.now() - 864e5);
  cert.validity.notAfter = new Date(Date.now() + 365 * 864e5);
  const attrs = [{ name: 'commonName', value: name }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([{ name: 'extKeyUsage', critical: true, timeStamping: true }]);
  cert.sign(key, forge.md.sha256.create());
  return { key, cert };
}

/** Start the authority. Returns { url, requests, close }. `wrongHash` makes it stamp other data. */
export async function startTsa({ name = 'Test Timestamp Authority', wrongHash = false } = {}) {
  const { key, cert } = identity(name);
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const query = asn1.fromDer(Buffer.concat(chunks).toString('binary')).value;
      requests.push({ contentType: req.headers['content-type'] });
      const imprint = query[1];
      if (wrongHash) imprint.value[1].value = crypto.randomBytes(32).toString('binary');
      const nonce = query.find((n, k) => k > 1 && n.type === asn1.Type.INTEGER);
      const tstInfo = seq(
        int(1), oid('1.3.6.1.4.1.99999.1'), imprint, int(requests.length),
        asn1.create(U, asn1.Type.GENERALIZEDTIME, false, asn1.dateToGeneralizedTime(new Date())),
        ...(nonce ? [nonce] : []),
      );
      const p7 = forge.pkcs7.createSignedData();
      p7.content = forge.util.createBuffer(asn1.toDer(tstInfo).getBytes());
      p7.addCertificate(cert);
      p7.addSigner({
        key, certificate: cert, digestAlgorithm: forge.pki.oids.sha256,
        authenticatedAttributes: [
          { type: forge.pki.oids.contentType, value: OID_TST_INFO },
          { type: forge.pki.oids.signingTime, value: new Date() },
          { type: forge.pki.oids.messageDigest },
        ],
      });
      p7.sign();
      const token = p7.toAsn1();
      token.value[1].value[0].value[2].value[0] = oid(OID_TST_INFO); // forge only writes "data" there
      const body = Buffer.from(asn1.toDer(seq(seq(int(0)), token)).getBytes(), 'binary');
      res.writeHead(200, { 'content-type': 'application/timestamp-reply' });
      res.end(body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, requests, name, close: () => new Promise((r) => server.close(r)) };
}
