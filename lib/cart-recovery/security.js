'use strict';
const crypto = require('node:crypto');

function verifySignature(raw, timestamp, signature, secret, now = Date.now()) {
  if (!secret || !/^\d{10}$/.test(String(timestamp)) || !/^sha256=[a-f0-9]{64}$/.test(String(signature))) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'));
}
function signBody(body, secret, timestamp = Math.floor(Date.now() / 1000)) {
  return { 'Content-Type': 'application/json', 'X-LUKO-Timestamp': String(timestamp),
    'X-LUKO-Signature': `sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}` };
}
function key(secret) {
  if (!secret || secret.length < 32) throw Object.assign(new Error('Recovery encryption configuration unavailable.'), { code: 'CART_CONFIG_MISSING' });
  return crypto.createHash('sha256').update(`luko-cart-recovery-v1:${secret}`).digest();
}
function seal(value, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(secret), iv);
  const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), bytes.toString('base64url')].join('.');
}
function unseal(value, secret) {
  const [version, nonce, tag, bytes] = String(value).split('.');
  if (version !== 'v1') throw new Error('Invalid recovery ciphertext.');
  const cipher = crypto.createDecipheriv('aes-256-gcm', key(secret), Buffer.from(nonce, 'base64url'));
  cipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([cipher.update(Buffer.from(bytes, 'base64url')), cipher.final()]).toString('utf8');
}
module.exports = { verifySignature, signBody, seal, unseal };
