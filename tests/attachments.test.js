// Receipts (W3-24): uploaded against the caller's own transaction by clientId, readable by anyone
// who may see the row, and a stray upload against a row that has not landed is taken back out
// of S3 rather than left to leak.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadWithStubs } = require('./helpers/stubs');

const ME = 'u-me', OTHER = 'u-other', HOME = 'g-home';

function harness(rows) {
  const s3 = { deleted: [] };
  const txs = rows.map((r) => ({ receiptKey: null, deletedAt: null, saved: 0, ...r, async save() { this.saved += 1; } }));
  const match = (r, f) => Object.entries(f).every(([k, v]) => {
    if (k === '$or') return v.some((x) => match(r, x));
    if (v && typeof v === 'object' && '$in' in v) return v.$in.map(String).includes(String(r[k]));
    if (v && typeof v === 'object' && '$ne' in v) return r[k] !== v.$ne;
    if (v === null) return r[k] == null;
    return String(r[k]) === String(v);
  });
  const ctrl = loadWithStubs('controllers/attachmentController.js', {
    '../models/Transaction': { findOne: async (f) => txs.find((r) => match(r, f)) || null },
    '../models/Group': { find: async (f) => (f.members === ME || f.members === OTHER ? [{ _id: HOME }] : []) },
    '../middleware/uploadMiddleware': { s3Client: { send: async (cmd) => { s3.deleted.push(cmd.input.Key); } } },
    '@aws-sdk/client-s3': { GetObjectCommand: class { constructor(i) { this.input = i; } }, DeleteObjectCommand: class { constructor(i) { this.input = i; } } },
    '@aws-sdk/s3-request-presigner': { getSignedUrl: async (_c, cmd) => `https://signed/${cmd.input.Key}` },
  });
  const res = () => { const r = { statusCode: null, body: null }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
  return { ctrl, txs, s3, res };
}

const req = (user, clientId, extra = {}) => ({ user: { id: user }, params: { clientId }, ...extra });

test('an upload attaches to the caller\'s transaction by clientId and replaces the previous object', async () => {
  const h = harness([{ _id: 't1', userId: ME, clientId: 'dev-1', receiptKey: 'receipts/u-me/old.jpg' }]);
  const r = h.res();
  await h.ctrl.uploadReceipt(req(ME, 'dev-1', { file: { key: 'receipts/u-me/new.jpg' } }), r);
  assert.equal(r.statusCode, null, JSON.stringify(r.body));
  assert.equal(h.txs[0].receiptKey, 'receipts/u-me/new.jpg');
  assert.equal(h.txs[0].saved, 1, 'saved, so updatedAt/syncedAt move and other devices hear about it');
  assert.deepEqual(h.s3.deleted, ['receipts/u-me/old.jpg']);
});

test('an upload against a row that has not landed is a 404 and the object is deleted again', async () => {
  const h = harness([]);
  const r = h.res();
  await h.ctrl.uploadReceipt(req(ME, 'not-yet', { file: { key: 'receipts/u-me/stray.jpg' } }), r);
  assert.equal(r.statusCode, 404);
  assert.deepEqual(h.s3.deleted, ['receipts/u-me/stray.jpg']);
});

test('someone else\'s transaction cannot be given a receipt, even from the same group', async () => {
  const h = harness([{ _id: 't1', userId: OTHER, groupId: HOME, clientId: 'theirs' }]);
  const r = h.res();
  await h.ctrl.uploadReceipt(req(ME, 'theirs', { file: { key: 'receipts/u-me/x.jpg' } }), r);
  assert.equal(r.statusCode, 404);
  assert.equal(h.txs[0].receiptKey, null);
});

test('the URL is readable for a group member\'s non-private row and refused for a private one', async () => {
  const h = harness([
    { _id: 't1', userId: OTHER, groupId: HOME, clientId: 'shared',  receiptKey: 'k1' },
    { _id: 't2', userId: OTHER, groupId: HOME, clientId: 'private', receiptKey: 'k2', isPrivate: true },
    { _id: 't3', userId: ME,    groupId: HOME, clientId: 'none' },
  ]);
  let r = h.res();
  await h.ctrl.receiptUrl(req(ME, 'shared'), r);
  assert.equal(r.body.url, 'https://signed/k1');

  r = h.res();
  await h.ctrl.receiptUrl(req(ME, 'private'), r);
  assert.equal(r.statusCode, 404);

  r = h.res();
  await h.ctrl.receiptUrl(req(ME, 'none'), r);
  assert.deepEqual(r.body, { url: null });
});

test('deleting clears the key, saves the row and removes the object', async () => {
  const h = harness([{ _id: 't1', userId: ME, clientId: 'dev-1', receiptKey: 'k1' }]);
  const r = h.res();
  await h.ctrl.deleteReceipt(req(ME, 'dev-1'), r);
  assert.equal(h.txs[0].receiptKey, null);
  assert.equal(h.txs[0].saved, 1);
  assert.deepEqual(h.s3.deleted, ['k1']);
});
