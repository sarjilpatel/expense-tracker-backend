// Note encryption is opt-in via FIELD_ENCRYPTION_KEY, which means both states have to keep
// working — and, crucially, existing plaintext notes must survive turning it on.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const KEY = 'a'.repeat(64); // 32 bytes of hex

/** fieldCrypto reads the env var on every call, so a fresh require isn't needed — but the module
 *  is stateless either way. Loading it once keeps the tests honest about that. */
const cryptoPath = require.resolve(path.join(__dirname, '..', 'utils', 'fieldCrypto.js'));

function withKey(value, fn) {
  const prev = process.env.FIELD_ENCRYPTION_KEY;
  if (value === undefined) delete process.env.FIELD_ENCRYPTION_KEY;
  else process.env.FIELD_ENCRYPTION_KEY = value;
  try { return fn(require(cryptoPath)); }
  finally {
    if (prev === undefined) delete process.env.FIELD_ENCRYPTION_KEY;
    else process.env.FIELD_ENCRYPTION_KEY = prev;
  }
}

test('a note round-trips', () => {
  withKey(KEY, ({ encryptField, decryptField }) => {
    const plain = 'lunch with the team — ₹1,240';
    const enc = encryptField(plain);
    assert.notEqual(enc, plain);
    assert.ok(enc.startsWith('ENC1:'));
    assert.equal(decryptField(enc), plain);
  });
});

test('the same note encrypts differently every time', () => {
  // A fresh IV per call. Without it, equal notes are visibly equal in the database.
  withKey(KEY, ({ encryptField }) => {
    assert.notEqual(encryptField('coffee'), encryptField('coffee'));
  });
});

test('with no key set, values pass through untouched', () => {
  withKey(undefined, ({ encryptField, decryptField }) => {
    assert.equal(encryptField('coffee'), 'coffee');
    assert.equal(decryptField('coffee'), 'coffee');
  });
});

test('a malformed key is refused rather than used', () => {
  withKey('abcd', ({ encryptField }) => {
    assert.equal(encryptField('coffee'), 'coffee');
  });
});

test('plaintext written before the key existed still decrypts to itself', () => {
  // This is the migration case: turning encryption on must not corrupt old rows.
  withKey(KEY, ({ decryptField }) => {
    assert.equal(decryptField('an old plaintext note'), 'an old plaintext note');
  });
});

test('ciphertext survives the key being removed, and comes back when it returns', () => {
  const enc = withKey(KEY, ({ encryptField }) => encryptField('secret'));
  // Without the key it is returned as-is rather than throwing or being mangled...
  withKey(undefined, ({ decryptField }) => assert.equal(decryptField(enc), enc));
  // ...and is still readable once the key is back.
  withKey(KEY, ({ decryptField }) => assert.equal(decryptField(enc), 'secret'));
});

test('tampered ciphertext returns the raw value instead of throwing', () => {
  // GCM authentication fails; a 500 on read would make the row unrecoverable through the API.
  withKey(KEY, ({ encryptField, decryptField }) => {
    const enc = encryptField('secret');
    const parts = enc.slice('ENC1:'.length).split(':');
    const tampered = 'ENC1:' + [parts[0], parts[1], Buffer.from('nonsense').toString('base64')].join(':');
    assert.equal(decryptField(tampered), tampered);
    assert.equal(decryptField('ENC1:only:two'), 'ENC1:only:two');
  });
});

test('empty and missing values are left alone', () => {
  withKey(KEY, ({ encryptField, decryptField }) => {
    for (const v of ['', null, undefined]) {
      assert.equal(encryptField(v), v);
      assert.equal(decryptField(v), v);
    }
  });
});

test('the wrong key does not decrypt', () => {
  const enc = withKey(KEY, ({ encryptField }) => encryptField('secret'));
  withKey('b'.repeat(64), ({ decryptField }) => {
    assert.equal(decryptField(enc), enc, 'must fail closed, returning the raw value');
  });
});
