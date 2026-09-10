// W1-28 regression: notes are written through `encryptField` — AES-256-GCM with a random IV per
// row — but `getTransactions` searched them with `{ note: { $regex: term } }`. The stored bytes
// have no relationship to the plaintext and the IV differs per row, so once FIELD_ENCRYPTION_KEY
// was set no note search could ever match. It failed silently: the user saw fewer results and no
// error, and guest mode (which searches plaintext on the device) kept working, so the same screen
// behaved differently depending on whether you were signed in.
//
// The fix is a blind index — `noteTokens`, a keyed HMAC per word of the note, stored beside the
// ciphertext and matched for equality. Whole words only, but index-served, which is what keeps
// skip/limit on the database instead of decrypting the whole scoped set in Node.

const test   = require('node:test');
const assert = require('node:assert/strict');
const { loadWithStubs, mockRes } = require('./helpers/stubs');

const KEY = 'a'.repeat(64);

/** Runs `fn` with FIELD_ENCRYPTION_KEY set to `key` (null to unset it), always restoring. */
function withKey(key, fn) {
  const prev = process.env.FIELD_ENCRYPTION_KEY;
  if (key === null) delete process.env.FIELD_ENCRYPTION_KEY;
  else process.env.FIELD_ENCRYPTION_KEY = key;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.FIELD_ENCRYPTION_KEY;
    else process.env.FIELD_ENCRYPTION_KEY = prev;
  }
}

/** The same, for an async body — the variable has to stay set across the await. */
async function withKeyAsync(key, fn) {
  const prev = process.env.FIELD_ENCRYPTION_KEY;
  if (key === null) delete process.env.FIELD_ENCRYPTION_KEY;
  else process.env.FIELD_ENCRYPTION_KEY = key;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.FIELD_ENCRYPTION_KEY;
    else process.env.FIELD_ENCRYPTION_KEY = prev;
  }
}

// The module reads the key on every call rather than caching it, which is what makes the two
// helpers above work at all.
const fieldCrypto = require('../utils/fieldCrypto');

// ── The index itself ─────────────────────────────────────────────────────────

test('a word in the note matches the same word searched for', async () => {
  withKey(KEY, () => {
    const { noteTokens, noteSearchToken } = fieldCrypto;
    assert.ok(noteTokens('Morning coffee run').includes(noteSearchToken('coffee')),
      'this is the entire feature');
  });
});

test('case and accents are folded on both sides', async () => {
  withKey(KEY, () => {
    const { noteTokens, noteSearchToken } = fieldCrypto;
    assert.ok(noteTokens('Café').includes(noteSearchToken('CAFE')));
    assert.ok(noteTokens('CAFE').includes(noteSearchToken('café')));
  });
});

test('punctuation is not part of a word', async () => {
  withKey(KEY, () => {
    const { noteTokens, noteSearchToken } = fieldCrypto;
    assert.ok(noteTokens("Monthly's bill!").includes(noteSearchToken('bill')));
    assert.ok(noteTokens('taxi-fare').includes(noteSearchToken('taxi')));
  });
});

test('a partial word does not match — this is the documented trade-off', async () => {
  // A prefix-searchable index would have to store every prefix of every word, which leaks far
  // more about the notes than whole words do. Whole-word matching is the deliberate limit, and it
  // is pinned here so that nobody quietly "fixes" it into a leak.
  withKey(KEY, () => {
    const { noteTokens, noteSearchToken } = fieldCrypto;
    assert.equal(noteTokens('coffee').includes(noteSearchToken('cof')), false);
    assert.equal(noteTokens('coffee').includes(noteSearchToken('offee')), false);
  });
});

test('the token reveals neither the note nor the encryption key', async () => {
  withKey(KEY, () => {
    const [token] = fieldCrypto.noteTokens('coffee');
    assert.match(token, /^[0-9a-f]{16}$/);
    assert.equal(token.includes('coffee'), false);
    assert.equal(KEY.includes(token), false, 'the HMAC key is derived, not FIELD_ENCRYPTION_KEY');
  });
});

test('a different key produces different tokens for the same word', async () => {
  const a = withKey(KEY,            () => fieldCrypto.noteTokens('coffee')[0]);
  const b = withKey('b'.repeat(64), () => fieldCrypto.noteTokens('coffee')[0]);
  assert.notEqual(a, b, 'tokens must be rebuilt on key rotation, and this is how you can tell');
});

test('the same word always produces the same token under one key', async () => {
  // Equality matching is the whole mechanism — a per-call salt would make the index unusable.
  const a = withKey(KEY, () => fieldCrypto.noteTokens('coffee')[0]);
  const b = withKey(KEY, () => fieldCrypto.noteTokens('Coffee beans')[0]);
  assert.equal(a, b);
});

test('a repeated word is stored once', async () => {
  withKey(KEY, () => {
    assert.equal(fieldCrypto.noteTokens('taxi taxi taxi').length, 1);
  });
});

test('with no key there is no index at all', async () => {
  // Encryption off means the note is plaintext and a regex works — building an index anyway would
  // store a searchable digest of every note for no benefit.
  withKey(null, () => {
    const { noteTokens, noteSearchToken, isEncryptionEnabled } = fieldCrypto;
    assert.equal(isEncryptionEnabled(), false);
    assert.deepEqual(noteTokens('coffee'), []);
    assert.equal(noteSearchToken('coffee'), null);
  });
});

test('an empty or symbol-only note produces no tokens', async () => {
  withKey(KEY, () => {
    const { noteTokens, noteSearchToken } = fieldCrypto;
    assert.deepEqual(noteTokens(''), []);
    assert.deepEqual(noteTokens('!!! ???'), []);
    assert.equal(noteSearchToken('***'), null, 'a wordless term must not become a match-all');
  });
});

test('an encrypted note still round-trips — the index did not change storage', async () => {
  withKey(KEY, () => {
    const { encryptField, decryptField } = fieldCrypto;
    assert.equal(decryptField(encryptField('Morning coffee run')), 'Morning coffee run');
  });
});

// ── The query the controller builds ──────────────────────────────────────────

/** Runs the real getTransactions and returns the filter it handed to Mongo. */
async function search(query, user) {
  let captured = null;
  const Transaction = {
    find: (q) => {
      captured = q;
      const chain = {
        sort: () => chain, skip: () => chain, limit: () => chain,
        populate: () => chain, lean: async () => [],
      };
      return chain;
    },
    countDocuments: async () => 0,
  };
  const ctrl = loadWithStubs('controllers/transactionController.js', {
    '../models/Transaction': Transaction,
    '../models/User': { findById: async () => user },
    '../models/Group': {},
    '../models/Account': {},
  });
  const res = mockRes();
  await ctrl.getTransactions({ query, user: { id: user._id } }, res);
  return { captured, res };
}

const solo   = { _id: 'u1', groupId: null };
const member = { _id: 'u1', groupId: 'g1' };

/** The clauses of the text-match $or, wherever the privacy scope left it. */
const textClauses = (captured) =>
  Array.isArray(captured.$and) ? captured.$and[1].$or : captured.$or;

test('with encryption on, the search matches the index and not the ciphertext', async () => {
  const { captured, res } = await withKeyAsync(KEY, () => search({ search: 'coffee' }, solo));
  assert.equal(res.statusCode, null, 'handler should not have errored');

  const clauses = textClauses(captured);
  const tokenClause = clauses.find((c) => c.noteTokens);
  assert.ok(tokenClause, 'expected a noteTokens clause: ' + JSON.stringify(clauses));

  const expected = withKey(KEY, () => fieldCrypto.noteSearchToken('coffee'));
  assert.equal(tokenClause.noteTokens, expected);

  assert.equal(clauses.some((c) => c.note), false,
    'a $regex over ciphertext can never match and only costs a collection scan');
});

test('the category is still searched alongside the note', async () => {
  const { captured } = await withKeyAsync(KEY, () => search({ search: 'coffee' }, solo));
  assert.ok(textClauses(captured).some((c) => c.category), 'category search must survive');
});

test('with encryption off, the note is matched with a regex as before', async () => {
  // A deployment with no key stores plaintext notes, and substring search still works there.
  const { captured } = await withKeyAsync(null, () => search({ search: 'coffee' }, solo));
  const clauses = textClauses(captured);

  assert.ok(clauses.some((c) => c.note && c.note.$regex === 'coffee'));
  assert.equal(clauses.some((c) => c.noteTokens), false, 'there is no index to match against');
});

test('a symbol-only search term produces no note clause at all', async () => {
  // `noteSearchToken` returns null there, and `{ noteTokens: null }` would match every row that
  // has no tokens — i.e. every transaction without a note.
  const { captured } = await withKeyAsync(KEY, () => search({ search: '***' }, solo));
  const clauses = textClauses(captured);

  assert.equal(clauses.some((c) => c.noteTokens), false,
    'a null token must never reach the query: ' + JSON.stringify(clauses));
  assert.ok(clauses.some((c) => c.category), 'the category clause still stands on its own');
});

test('the privacy scope still wraps the text match on the encrypted path', async () => {
  // W1-08's bug, re-checked here because W1-28 changed the shape of the clause it wraps.
  const { captured } = await withKeyAsync(KEY, () => search({ search: 'coffee' }, member));

  assert.ok(Array.isArray(captured.$and), 'expected privacy AND text');
  assert.deepEqual(captured.$and[0], { $or: [{ isPrivate: { $ne: true } }, { userId: 'u1' }] });
  assert.equal(captured.$or, undefined);
});

// ── The write side ───────────────────────────────────────────────────────────
//
// A search that reads an index nothing writes finds nothing, exactly as loudly as the bug it
// replaced — i.e. not at all. There are three places a note is written, and all three have to
// index it.

/** Runs a controller export with model stubs, returning whatever the stubs captured. */
function runWrite(handler, req, { user = solo, created = {}, existing = null } = {}) {
  const captured = {};
  const Transaction = {
    create: async (doc) => { captured.doc = doc; return { _id: 't1', ...created }; },
    insertMany: async (docs) => { captured.docs = docs; return docs.map((d, i) => ({ _id: i, ...d })); },
    findById: async () => existing,
    // The controller wraps the update in `$set` and chains `.populate()` onto it.
    findByIdAndUpdate: (_id, update) => {
      captured.fields = update.$set;
      return { populate: async () => ({ toObject: () => ({ _id: 't1' }) }) };
    },
  };
  const ctrl = loadWithStubs('controllers/transactionController.js', {
    '../models/Transaction': Transaction,
    '../models/User': {
      findById: () => {
        const p = Promise.resolve(user);
        p.select = () => p; p.lean = () => p;
        return p;
      },
    },
    '../models/Group': { findById: async () => null },
    '../models/Account': { exists: async () => false, find: () => ({ lean: async () => [] }) },
  });
  const res = mockRes();
  return ctrl[handler]({ ...req, user: { id: user._id }, app: { get: () => null } }, res)
    .then(() => ({ captured, res }));
}

test('a created transaction is indexed by the words of its note', async () => {
  // The round trip, end to end: what create stores is what search looks for. Asserting the two
  // halves separately would let them drift apart while both tests still passed.
  const { captured } = await withKeyAsync(KEY, () => runWrite('addTransaction', {
    body: { amount: 5, type: 'expense', category: 'Food', note: 'Morning coffee run' },
  }));

  const token = withKey(KEY, () => fieldCrypto.noteSearchToken('coffee'));
  assert.ok(captured.doc.noteTokens.includes(token),
    'searching "coffee" would not find this row: ' + JSON.stringify(captured.doc.noteTokens));
  assert.equal(captured.doc.noteTokens.length, 3, 'one per distinct word');
  assert.ok(captured.doc.note.startsWith('ENC1:'), 'the note itself is still encrypted');
});

test('editing a note replaces the index rather than adding to it', async () => {
  // A stale token keeps the row findable by a word the note no longer contains — which, for a
  // note the user deliberately edited, is the leak they were trying to close.
  const existing = { userId: { toString: () => 'u1' }, date: new Date(), isRecurring: false };
  const { captured, res } = await withKeyAsync(KEY, () => runWrite('updateTransaction', {
    params: { id: 't1' }, body: { note: 'taxi fare' },
  }, { existing }));

  const taxi   = withKey(KEY, () => fieldCrypto.noteSearchToken('taxi'));
  const coffee = withKey(KEY, () => fieldCrypto.noteSearchToken('coffee'));
  assert.equal(res.statusCode, null, 'the handler errored before writing anything');
  assert.ok(captured.fields.noteTokens.includes(taxi));
  assert.equal(captured.fields.noteTokens.includes(coffee), false);
});

test('an edit that does not touch the note leaves the index alone', async () => {
  // Rewriting it from an undefined note would blank the tokens of a row whose note is unchanged.
  const existing = { userId: { toString: () => 'u1' }, date: new Date(), isRecurring: false };
  const { captured, res } = await withKeyAsync(KEY, () => runWrite('updateTransaction', {
    params: { id: 't1' }, body: { amount: 12 },
  }, { existing }));

  assert.equal(res.statusCode, null, 'the handler errored before writing anything');
  assert.equal('noteTokens' in captured.fields, false, JSON.stringify(captured.fields));
});

test('imported transactions are indexed too', async () => {
  // The CSV/guest-sync path builds its documents separately, so it can miss the index on its own.
  const { captured } = await withKeyAsync(KEY, () => runWrite('importTransactions', {
    body: { transactions: [{ amount: 5, category: 'Food', note: 'Morning coffee run' }] },
  }));

  const token = withKey(KEY, () => fieldCrypto.noteSearchToken('coffee'));
  assert.ok(captured.docs[0].noteTokens.includes(token),
    'a row imported from a guest device would be unsearchable');
});

test('with no key set, nothing is indexed on write', async () => {
  const { captured } = await withKeyAsync(null, () => runWrite('addTransaction', {
    body: { amount: 5, type: 'expense', category: 'Food', note: 'Morning coffee run' },
  }));

  assert.deepEqual(captured.doc.noteTokens, []);
  assert.equal(captured.doc.note, 'Morning coffee run', 'and the note is stored as written');
});
