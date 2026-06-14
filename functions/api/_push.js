// functions/api/_push.js — Web Push (VAPID + aes128gcm) on Workers crypto.
// No npm deps. Implements RFC 8291 (encryption) + RFC 8292 (VAPID).

const b64uTo = (s) => {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const toB64u = (buf) => {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const cat = (...arrs) => {
  const len = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};
const utf8 = (s) => new TextEncoder().encode(s);

async function importVapidKey(privB64u, pubB64u) {
  const d = b64uTo(privB64u);
  const raw = b64uTo(pubB64u); // 65 bytes, 0x04 || X || Y
  const x = toB64u(raw.slice(1, 33));
  const y = toB64u(raw.slice(33, 65));
  const jwk = { kty: 'EC', crv: 'P-256', d: toB64u(d), x, y, ext: true };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

async function vapidAuth(endpoint, env) {
  const url = new URL(endpoint);
  const aud = `${url.protocol}//${url.host}`;
  const header = toB64u(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = toB64u(utf8(JSON.stringify({
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.PUSH_SUBJECT || 'mailto:charter@willsmithaviation.com',
  })));
  const signingInput = `${header}.${payload}`;
  const key = await importVapidKey(env.VAPID_PRIVATE, env.VAPID_PUBLIC);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(signingInput));
  const jwt = `${signingInput}.${toB64u(sig)}`;
  return { Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC}` };
}

async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}

// Encrypt payload for one subscription (aes128gcm, single record).
async function encrypt(payload, p256dhB64u, authB64u) {
  const clientPub = b64uTo(p256dhB64u);
  const authSecret = b64uTo(authB64u);
  const plaintext = utf8(payload);

  const localKp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const localPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', localKp.publicKey)); // 65 bytes
  const clientKey = await crypto.subtle.importKey('raw', clientPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: clientKey }, localKp.privateKey, 256));

  // PRK_key = HKDF(auth, ecdh, "WebPush: info\0"||clientPub||serverPub, 32)
  const keyInfo = cat(utf8('WebPush: info\0'), clientPub, localPubRaw);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const record = cat(plaintext, new Uint8Array([0x02])); // delimiter (last record)
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, record));

  // header: salt(16) || rs(4, =4096) || idlen(1) || keyid(serverPub)
  const rs = new Uint8Array([0, 0, 0x10, 0]);
  const header = cat(salt, rs, new Uint8Array([localPubRaw.length]), localPubRaw);
  return cat(header, ct);
}

export async function sendPush(env, sub, dataObj) {
  const body = await encrypt(JSON.stringify(dataObj), sub.p256dh, sub.auth);
  const auth = await vapidAuth(sub.endpoint, env);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      ...auth,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'high',
    },
    body,
  });
  return res.status; // 201 ok; 404/410 = expired subscription (caller should prune)
}

// Notify every staff subscription; prune dead ones.
export async function pushAllStaff(env, dataObj) {
  if (!env.VAPID_PRIVATE || !env.VAPID_PUBLIC) return { sent: 0, reason: 'no_vapid' };
  const subs = (await env.DB.prepare('SELECT * FROM push_subs').all()).results;
  let sent = 0;
  for (const s of subs) {
    try {
      const code = await sendPush(env, s, dataObj);
      if (code === 201 || code === 200) sent++;
      else if (code === 404 || code === 410) await env.DB.prepare('DELETE FROM push_subs WHERE id=?1').bind(s.id).run();
    } catch (_) { /* skip */ }
  }
  return { sent };
}
