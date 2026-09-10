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

// ── Blind index for note search (W1-28) ──────────────────────────────────────
//
// Encrypted notes cannot be searched: AES-GCM with a random IV per row means the stored bytes have
// no relationship to the plaintext, and two rows holding the same word share nothing. So
// `{ note: { $regex: term } }` matched nothing at all once FIELD_ENCRYPTION_KEY was set — silently,
// with the user simply seeing fewer results.
//
// The fix is a keyed index of the note's words stored beside the ciphertext. A search term is
// hashed the same way and matched for equality, which Mongo can serve from an index, so DB-side
// skip/limit still work and pagination is unaffected.
//
// What this deliberately does not do is preserve substrings: "cof" will not find "coffee". A
// searchable prefix index leaks far more (every prefix of every word), and whole-word search is
// what a note search is actually used for.
//
// The HMAC key is derived from FIELD_ENCRYPTION_KEY rather than being the key itself, so the index
// and the ciphertext never share key material — a leaked token list tells an attacker nothing they
// could use against the encryption.

const INDEX_INFO = 'note-index-v1';
const TOKEN_HEX  = 16;  // 8 bytes: collisions are negligible, and a shorter token stores better.

function getIndexKey() {
  const key = getKey();
  return key && crypto.createHmac('sha256', key).update(INDEX_INFO).digest();
}

/**
 * Splits text into the words a search can match: lowercased, accent-folded, punctuation dropped.
 * "Café — Monthly's bill!" becomes ["cafe", "monthly", "s", "bill"], which is also exactly what a
 * one-word search term is reduced to, so the two sides always agree.
 */
function words(text) {
  return String(text)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * The searchable tokens for a note, or `[]` when there is no key — with encryption off the note is
 * stored in plaintext and searched with a plain regex, so no index is needed or wanted.
 */
exports.noteTokens = function (text) {
  const key = getIndexKey();
  if (!key || !text) return [];

  const seen = new Set();
  for (const word of words(text)) {
    seen.add(crypto.createHmac('sha256', key).update(word).digest('hex').slice(0, TOKEN_HEX));
  }
  return [...seen];
};

/**
 * The token a single search term must match, or `null` if the term has no searchable word in it or
 * encryption is off. A multi-word term takes its first word: the caller falls back to matching the
 * category for anything this cannot express.
 */
exports.noteSearchToken = function (term) {
  const key = getIndexKey();
  if (!key) return null;

  const [first] = words(term);
  if (!first) return null;
  return crypto.createHmac('sha256', key).update(first).digest('hex').slice(0, TOKEN_HEX);
};

/** Whether field encryption is on. Decides which of the two search strategies applies. */
exports.isEncryptionEnabled = function () {
  return getKey() !== null;
};
