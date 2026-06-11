const crypto = require('crypto');

const ALGO   = 'aes-256-gcm';
const IV_LEN = 12;
const PREFIX = 'ENC1:';

function getKey() {
  const hex = process.env.FIELD_ENCRYPTION_KEY;
  if (!hex) return null;
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== 32) {
    console.error('[fieldCrypto] FIELD_ENCRYPTION_KEY must be 64 hex chars (32 bytes)');
    return null;
  }
  return buf;
}

exports.encryptField = function(text) {
  if (!text) return text;
  const key = getKey();
  if (!key) return text;

  const iv       = crypto.randomBytes(IV_LEN);
  const cipher   = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag      = cipher.getAuthTag();

  return PREFIX + [iv, tag, encrypted].map(b => b.toString('base64')).join(':');
};

exports.decryptField = function(value) {
  if (!value || !value.startsWith(PREFIX)) return value;
  const key = getKey();
  if (!key) return value;

  try {
    const parts = value.slice(PREFIX.length).split(':');
    if (parts.length !== 3) return value;
    const [ivB64, tagB64, cipherB64] = parts;

    const iv         = Buffer.from(ivB64,    'base64');
    const tag        = Buffer.from(tagB64,   'base64');
    const cipherBuf  = Buffer.from(cipherB64,'base64');

    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(cipherBuf), decipher.final()]).toString('utf8');
  } catch {
    return value;
  }
};
