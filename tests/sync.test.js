// The sync protocol (W3-07/08/11): push idempotency, last-writer-wins, tombstones round-tripping
// through the changes feed, a cursor that never skips a row, and group scoping.
//
// `utils/sync.js` is pinned directly; `controllers/syncController.js` runs for real against
// in-memory stand-ins for the five models and Group, so what is under test is the shipped code.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { loadWithStubs } = require('./helpers/stubs');
const { validateBatch, lww, cutPage, toClientId, requireForInsert } = require('../utils/sync');

// ── utils/sync.js ────────────────────────────────────────────────────────────

test('a batch is validated item by item and sorted categories-first', () => {
  const items = validateBatch({ items: [
    { collection: 'transactions', op: 'upsert', clientId: 't1', updatedAt: '2026-09-13T10:00:00Z', payload: { amount: 5, type: 'expense', category: 'Food', userId: 'evil' } },
    { collection: 'categories',   op: 'upsert', clientId: 'c1', updatedAt: '2026-09-13T10:00:00Z', payload: { name: 'Food' } },
  ] });
  assert.deepEqual(items.map((i) => i.collection), ['categories', 'transactions']);
  assert.equal(items[1].payload.userId, undefined, 'ownership never comes from the payload');
  assert.ok(items[1].updatedAt instanceof Date);
});

test('a malformed batch is a 400 naming the item', () => {
  for (const [body, msg] of [
    [{}, /items must be an array/],
    [{ items: [] }, /empty/],
    [{ items: [{ collection: 'nope', op: 'upsert', clientId: 'a', updatedAt: 'x' }] }, /items\[0\]\.collection/],
    [{ items: [{ collection: 'budgets', op: 'merge', clientId: 'a', updatedAt: '2026-01-01' }] }, /op must be/],
    [{ items: [{ collection: 'budgets', op: 'upsert', clientId: 'has space', updatedAt: '2026-01-01', payload: {} }] }, /clientId/],
    [{ items: [{ collection: 'budgets', op: 'upsert', clientId: 'a', updatedAt: 'yesterday', payload: {} }] }, /updatedAt/],
    [{ items: [{ collection: 'budgets', op: 'upsert', clientId: 'a', updatedAt: '2026-01-01' }] }, /payload/],
  ]) {
    assert.throws(() => validateBatch(body), (e) => e.status === 400 && msg.test(e.message), String(msg));
  }
  assert.throws(() => validateBatch({ items: new Array(501).fill({}) }), /at most 500/);
});

test('an insert must carry the fields the schema requires', () => {
  assert.throws(() => requireForInsert('transactions', { type: 'expense', category: 'Food' }), /amount is required/);
  assert.throws(() => requireForInsert('transactions', { amount: 0, type: 'expense', category: 'Food' }), /greater than 0/);
  assert.doesNotThrow(() => requireForInsert('accounts', { name: 'Cash' }));
});

test('last writer wins by updatedAt; equal clocks apply; a row with no clock is nothing to lose', () => {
  assert.equal(lww('2026-09-13T10:00:00Z', '2026-09-13T09:00:00Z'), 'superseded');
  assert.equal(lww('2026-09-13T09:00:00Z', '2026-09-13T10:00:00Z'), 'apply');
  assert.equal(lww('2026-09-13T10:00:00Z', '2026-09-13T10:00:00Z'), 'apply');
  assert.equal(lww(undefined, '2000-01-01T00:00:00Z'), 'apply');
});

test('a page is cut at the limit and extended over rows that share the last stamp', () => {
  const t = (s) => new Date(`2026-09-13T10:00:0${s}Z`);
  const rows = [
    { collection: 'b', clientId: '1', syncedAt: t(1) },
    { collection: 'a', clientId: '2', syncedAt: t(2) },
    { collection: 'a', clientId: '3', syncedAt: t(2) },
    { collection: 'b', clientId: '4', syncedAt: t(2) },
    { collection: 'a', clientId: '5', syncedAt: t(3) },
  ];
  const page = cutPage(rows, 2);
  assert.deepEqual(page.changes.map((r) => r.clientId), ['1', '2', '3', '4'],
    'cutting at 2 would leave two rows with the cursor\'s stamp on the far side, and `> cursor` would never return them');
  assert.equal(page.cursor, t(2).toISOString());
  assert.equal(page.hasMore, true);

  const rest = cutPage(rows.filter((r) => r.syncedAt > t(2)), 2);
  assert.deepEqual(rest.changes.map((r) => r.clientId), ['5']);
  assert.equal(rest.hasMore, false);
  assert.deepEqual(cutPage([], 10), { changes: [], cursor: null, hasMore: false });
});

test('a row that predates sync is addressed by its _id', () => {
  assert.equal(toClientId({ _id: 'abc', clientId: undefined }), 'abc');
  assert.equal(toClientId({ _id: 'abc', clientId: 'dev-1' }), 'dev-1');
});

// ── controllers/syncController.js against in-memory models ──────────────────

const ME    = 'u-me';
const OTHER = 'u-other';
const HOME  = 'g-home';    // shared, both members
const MINE  = 'g-mine';    // my personal group

const match = (row, filter) => Object.entries(filter).every(([k, v]) => {
  if (k === '$or') return v.some((f) => match(row, f));
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('$in' in v)  return v.$in.map(String).includes(String(row[k]));
    if ('$ne' in v)  return row[k] !== v.$ne;
    if ('$gt' in v)  return row[k] != null && new Date(row[k]) > new Date(v.$gt);
    if ('$lt' in v)  return row[k] != null && new Date(row[k]) < new Date(v.$lt);
  }
  if (v === null) return row[k] == null;
  return String(row[k]) === String(v);
});

/** A model stand-in with the five calls the controller makes, and the syncable hooks' effect. */
function fakeModel(name) {
  const rows = [];
  let seq = 0;
  const now = () => new Date(clock.now);
  const doc = (row) => Object.assign(row, {
    set(fields) { Object.assign(this, fields); },
    async save() { if (!('updatedAt' in this) || this.__touch) this.updatedAt = now(); this.syncedAt = now(); delete this.__touch; },
    toObject() { const { set, save, toObject, ...plain } = this; return plain; },
  });
  const api = {
    rows,
    async findOne(filter) { return rows.find((r) => match(r, filter)) || null; },
    async findOneAndUpdate(filter, update, opts = {}) {
      let row = rows.find((r) => match(r, filter));
      if (!row) {
        if (!opts.upsert) return null;
        row = doc({ _id: `${name}-${++seq}`, createdAt: now(), ...Object.fromEntries(Object.entries(filter).filter(([, v]) => typeof v !== 'object')) });
        rows.push(row);
      }
      Object.assign(row, update.$set || {});
      for (const k of Object.keys(update.$unset || {})) delete row[k];
      row.syncedAt = now();                      // the plugin's pre-update hook
      if (!(update.$set && 'updatedAt' in update.$set)) row.updatedAt = now();
      return row;
    },
    find(filter) {
      const found = rows.filter((r) => match(r, filter)).sort((a, b) => new Date(a.syncedAt || 0) - new Date(b.syncedAt || 0));
      const lean = async () => found.map((r) => ({ ...r }));
      const q = { sort: () => q, limit: (n) => ({ lean: async () => found.slice(0, n).map((r) => ({ ...r })) }), lean };
      return q;
    },
    seed(row) { const d = doc({ _id: `${name}-${++seq}`, ...row }); rows.push(d); return d; },
  };
  return api;
}

const clock = { now: Date.parse('2026-09-13T12:00:00Z') };

function harness({ activeGroup = HOME } = {}) {
  const models = {
    transactions: fakeModel('tx'), budgets: fakeModel('bud'), accounts: fakeModel('acc'),
    goals: fakeModel('goal'), trips: fakeModel('trip'),
  };
  const groups = [
    { _id: HOME, members: [ME, OTHER], categories: [], async save() { for (const c of this.categories) { if (!c.syncedAt || c.__touch) { c.syncedAt = new Date(clock.now); delete c.__touch; } } } },
    { _id: MINE, members: [ME],        categories: [], async save() { for (const c of this.categories) { if (!c.syncedAt || c.__touch) { c.syncedAt = new Date(clock.now); delete c.__touch; } } } },
  ];
  // Category subdocs get `set` and `toObject` like the real ones.
  const subdoc = (c) => Object.assign(c, {
    _id: c._id || `cat-${Math.random().toString(36).slice(2, 8)}`,
    set(fields) { Object.assign(this, fields); this.__touch = true; },
    toObject() { const { set, toObject, __touch, ...plain } = this; return plain; },
  });
  for (const g of groups) {
    const push = g.categories.push.bind(g.categories);
    g.categories.push = (...cs) => push(...cs.map((c) => subdoc({ ...c, __touch: true })));
  }

  const ctrl = loadWithStubs('controllers/syncController.js', {
    '../models/Transaction': models.transactions, '../models/Budget': models.budgets,
    '../models/Account': models.accounts, '../models/Goal': models.goals, '../models/Trip': models.trips,
    '../models/Group': { find: async (f) => groups.filter((g) => g.members.includes(f.members)) },
    '../models/User':  { findById: async (id) => ({ _id: id, groupId: activeGroup }) },
  });

  const res = () => {
    const r = { statusCode: null, body: null };
    r.status = (c) => { r.statusCode = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    return r;
  };
  const emitted = [];
  const app = { get: (k) => (k === 'io' ? { to: (room) => ({ emit: (ev, payload) => emitted.push({ room, ev, payload }) }) } : undefined) };
  const push    = async (items, user = ME) => { const r = res(); await ctrl.push({ user: { id: user }, body: { items }, app }, r); return r; };
  const changes = async (query = {}, user = ME) => { const r = res(); await ctrl.changes({ user: { id: user }, query }, r); return r; };
  return { models, groups, push, changes, emitted, seedCategory: (g, c) => { g.categories.push(c); } };
}

const at = (iso) => iso;
const tx = (clientId, updatedAt, payload = {}) => ({
  collection: 'transactions', op: 'upsert', clientId, updatedAt,
  payload: { amount: 120, type: 'expense', category: 'Food', note: 'lunch', ...payload },
});

test('push upserts by clientId and is idempotent — the same batch twice makes one row', async () => {
  const h = harness();
  const first  = await h.push([tx('dev-1', at('2026-09-13T11:00:00Z'))]);
  const second = await h.push([tx('dev-1', at('2026-09-13T11:00:00Z'))]);
  assert.equal(first.body.results[0].status, 'applied');
  assert.equal(second.body.results[0].status, 'applied');
  assert.equal(h.models.transactions.rows.length, 1);
  const row = h.models.transactions.rows[0];
  assert.equal(String(row.userId), ME, 'filed under the caller');
  assert.equal(String(row.groupId), HOME, 'and the active group');
  assert.equal(row.clientId, 'dev-1');
  assert.equal(first.body.results[0].serverId, second.body.results[0].serverId);
  assert.deepEqual(row.updatedAt, new Date('2026-09-13T11:00:00Z'), 'the device\'s edit clock is kept');
});

test('a note is encrypted and indexed on push, and comes back in clear', async () => {
  const h = harness();
  const r = await h.push([tx('dev-1', at('2026-09-13T11:00:00Z'), { note: 'Morning coffee' })]);
  const row = h.models.transactions.rows[0];
  assert.ok(Array.isArray(row.noteTokens), 'the blind index is written alongside');
  assert.equal(r.body.results[0].row.note, 'Morning coffee', 'the response carries the clear note');
  assert.equal(r.body.results[0].row.noteTokens, undefined, 'and never the index');
});

test('an older edit is superseded and the server row handed back', async () => {
  const h = harness();
  await h.push([tx('dev-1', at('2026-09-13T11:00:00Z'), { amount: 200 })]);
  const stale = await h.push([tx('dev-1', at('2026-09-13T10:00:00Z'), { amount: 50 })]);
  assert.equal(stale.body.results[0].status, 'superseded');
  assert.equal(stale.body.results[0].row.amount, 200, 'the device is told what won');
  assert.equal(h.models.transactions.rows[0].amount, 200);
});

test('a delete is a tombstone that the changes feed reports', async () => {
  const h = harness();
  await h.push([tx('dev-1', at('2026-09-13T11:00:00Z'))]);
  clock.now += 1000;
  const del = await h.push([{ collection: 'transactions', op: 'delete', clientId: 'dev-1', updatedAt: at('2026-09-13T11:30:00Z') }]);
  assert.equal(del.body.results[0].status, 'applied');
  assert.ok(h.models.transactions.rows[0].deletedAt, 'not removed');

  const feed = await h.changes({ since: '2026-09-13T11:59:00Z' });
  const change = feed.body.changes.find((c) => c.clientId === 'dev-1');
  assert.equal(change.deleted, true);

  // A full pull (no cursor) has no use for it.
  const full = await h.changes({});
  assert.equal(full.body.changes.find((c) => c.clientId === 'dev-1'), undefined);
});

test('deleting a row the server never saw is a no-op, not a phantom tombstone', async () => {
  const h = harness();
  const r = await h.push([{ collection: 'accounts', op: 'delete', clientId: 'never', updatedAt: at('2026-09-13T11:00:00Z') }]);
  assert.equal(r.body.results[0].status, 'applied');
  assert.equal(r.body.results[0].serverId, null);
  assert.equal(h.models.accounts.rows.length, 0);
});

test('one rejected row does not sink the batch', async () => {
  const h = harness();
  const r = await h.push([
    tx('ok', at('2026-09-13T11:00:00Z')),
    { collection: 'accounts', op: 'upsert', clientId: 'bad', updatedAt: at('2026-09-13T11:00:00Z'), payload: { type: 'cash' } },
  ]);
  const by = Object.fromEntries(r.body.results.map((x) => [x.clientId, x]));
  assert.equal(by.ok.status, 'applied');
  assert.equal(by.bad.status, 'rejected');
  assert.match(by.bad.error, /name is required/);
});

test('a row that predates sync is addressed by its _id and gains a clientId', async () => {
  const h = harness();
  const legacy = h.models.accounts.seed({ _id: new mongoose.Types.ObjectId().toString(), userId: ME, name: 'Old wallet', createdAt: new Date('2026-01-01') });
  const r = await h.push([{ collection: 'accounts', op: 'upsert', clientId: legacy._id, updatedAt: at('2026-09-13T11:00:00Z'), payload: { name: 'Renamed' } }]);
  assert.equal(r.body.results[0].status, 'applied', 'no updatedAt on the row means nothing to lose');
  assert.equal(h.models.accounts.rows.length, 1);
  assert.equal(legacy.name, 'Renamed');
  assert.equal(legacy.clientId, legacy._id);
});

test('the feed pages on syncedAt with a cursor that never skips a row', async () => {
  const h = harness();
  // Three rows land on the same server tick, one on the next.
  await h.push([tx('a', at('2026-09-13T11:00:00Z')), tx('b', at('2026-09-13T11:00:00Z')), tx('c', at('2026-09-13T11:00:00Z'))]);
  clock.now += 1000;
  await h.push([tx('d', at('2026-09-13T11:00:00Z'))]);

  const p1 = await h.changes({ limit: '2' });
  assert.deepEqual(p1.body.changes.map((c) => c.clientId).sort(), ['a', 'b', 'c'], 'the page grows to cover the shared stamp');
  assert.equal(p1.body.hasMore, true);
  const p2 = await h.changes({ since: p1.body.cursor, limit: '2' });
  assert.deepEqual(p2.body.changes.map((c) => c.clientId), ['d']);
  assert.equal(p2.body.hasMore, false);
  assert.equal(p2.body.changes[0].row.note, 'lunch', 'notes come back in clear');
});

test('the feed is scoped: own rows, the group\'s non-private rows, never another member\'s private row', async () => {
  const h = harness();
  await h.push([tx('mine-private', at('2026-09-13T11:00:00Z'), { isPrivate: true })], ME);
  await h.push([tx('theirs', at('2026-09-13T11:00:00Z')), tx('theirs-private', at('2026-09-13T11:00:00Z'), { isPrivate: true })], OTHER);
  h.models.transactions.seed({ userId: 'u-stranger', groupId: 'g-elsewhere', amount: 1, type: 'expense', category: 'x', syncedAt: new Date(clock.now) });

  const feed = await h.changes({}, ME);
  assert.deepEqual(feed.body.changes.map((c) => c.clientId).sort(), ['mine-private', 'theirs']);
});

test('a push cannot file a row under another user or a group the caller is not in', async () => {
  const h = harness();
  const r = await h.push([{ ...tx('t', at('2026-09-13T11:00:00Z')), groupId: 'g-elsewhere', payload: { amount: 1, type: 'expense', category: 'x', userId: OTHER, groupId: 'g-elsewhere' } }]);
  assert.equal(r.body.results[0].status, 'applied');
  const row = h.models.transactions.rows[0];
  assert.equal(String(row.userId), ME);
  assert.equal(String(row.groupId), HOME, 'an unknown group falls back to the active one');
});

test('categories: pushed onto the group, deduped by name, tombstoned on delete, in the feed', async () => {
  const h = harness();
  const home = h.groups[0];
  h.seedCategory(home, { name: 'Food', clientId: 'srv-food', updatedAt: new Date('2026-09-01'), syncedAt: new Date('2026-09-01') });

  const r = await h.push([
    { collection: 'categories', op: 'upsert', clientId: 'dev-travel', updatedAt: at('2026-09-13T11:00:00Z'), payload: { name: 'Travel', icon: 'airplane' } },
    { collection: 'categories', op: 'upsert', clientId: 'dev-food',   updatedAt: at('2026-09-13T11:00:00Z'), payload: { name: 'food' } },
  ]);
  const by = Object.fromEntries(r.body.results.map((x) => [x.clientId, x]));
  assert.equal(by['dev-travel'].status, 'applied');
  assert.equal(by['dev-food'].status, 'superseded', 'same name, case-insensitively, is the same category');
  assert.equal(by['dev-food'].row.clientId, 'srv-food');
  assert.equal(home.categories.length, 2);

  await h.push([{ collection: 'categories', op: 'delete', clientId: 'dev-travel', updatedAt: at('2026-09-13T11:10:00Z') }]);
  assert.ok(home.categories.find((c) => c.clientId === 'dev-travel').deletedAt);

  const feed = await h.changes({ since: '2026-09-10T00:00:00Z' });
  const travel = feed.body.changes.find((c) => c.collection === 'categories' && c.clientId === 'dev-travel');
  assert.equal(travel.deleted, true);
  assert.equal(travel.row.groupId, HOME);
});

test('a bad cursor is a 400', async () => {
  const h = harness();
  const r = await h.changes({ since: 'last tuesday' });
  assert.equal(r.statusCode, 400);
});

test("a transaction's accountId travels as the account's clientId in both directions", async () => {
  const h = harness();
  const r = await h.push([
    { collection: 'accounts', op: 'upsert', clientId: 'acc-wallet', updatedAt: at('2026-09-13T11:00:00Z'), payload: { name: 'Wallet' } },
    tx('t1', at('2026-09-13T11:00:00Z'), { accountId: 'acc-wallet' }),
  ]);
  const by = Object.fromEntries(r.body.results.map((x) => [x.clientId, x]));
  const serverAccountId = by['acc-wallet'].serverId;
  assert.equal(String(h.models.transactions.rows[0].accountId), serverAccountId, 'stored as the server id');
  assert.equal(by.t1.row.accountId, 'acc-wallet', 'returned as the clientId');

  const feed = await h.changes({});
  assert.equal(feed.body.changes.find((c) => c.clientId === 't1').row.accountId, 'acc-wallet');

  const unknown = await h.push([tx('t2', at('2026-09-13T11:00:00Z'), { accountId: 'no-such-account' })]);
  assert.equal(unknown.body.results[0].row.accountId, null, 'an account the server does not know is unassigned, not an error');
});

test('a device-made trip links its self member and unattributed settlements to the caller', async () => {
  const h = harness();
  const r = await h.push([{ collection: 'trips', op: 'upsert', clientId: 'trip-goa', updatedAt: at('2026-09-13T11:00:00Z'), payload: {
    name: 'Goa', currency: 'INR',
    members: [{ id: 'm1', name: 'You', userId: null, isSelf: true }, { id: 'm2', name: 'Priya', userId: null }],
    expenses: [], settlements: [{ id: 's1', fromId: 'm2', toId: 'm1', amountMinor: 500, settledAt: '2026-09-13T10:00:00Z', recordedBy: null }],
  } }]);
  assert.equal(r.body.results[0].status, 'applied');
  const trip = h.models.trips.rows[0];
  assert.equal(String(trip.ownerId), ME);
  assert.equal(String(trip.members[0].userId), ME, 'the self member is the caller');
  assert.equal(trip.members[0].isSelf, undefined, 'the marker does not reach the schema');
  assert.equal(trip.members[1].userId, null);
  assert.equal(String(trip.settlements[0].recordedBy), ME);
});

test('a push signals the groups it touched, never for accounts or budgets, and the feed names the shared groups', async () => {
  const h = harness();
  await h.push([
    tx('t1', at('2026-09-13T11:00:00Z')),
    { collection: 'accounts', op: 'upsert', clientId: 'a1', updatedAt: at('2026-09-13T11:00:00Z'), payload: { name: 'Cash' } },
  ]);
  assert.deepEqual(h.emitted.map((e) => [e.room, e.ev]), [[HOME, 'group_changed']]);
  assert.equal(h.emitted[0].payload.by, ME);

  h.groups[1].isPersonal = true;
  const feed = await h.changes({});
  assert.deepEqual(feed.body.groups.map((g) => [g.id, g.isPersonal]), [[HOME, false], [MINE, true]]);
});
