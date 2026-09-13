/**
 * The pure part of the sync protocol (W3-07/08): what a push item must look like, which fields a
 * device may write per collection, the last-writer-wins rule, and how a page of the changes feed
 * is cut. No Mongo in here — `controllers/syncController.js` is the thin layer that applies these
 * against the models, and `tests/sync.test.js` pins this file directly.
 */

const MAX_BATCH = 500;
const MAX_PAGE  = 1000;
const CLIENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Per collection: the fields a device is allowed to send. Ownership and scope (`userId`,
 * `groupId`, `ownerId`) are never taken from the payload — the server sets them from the caller,
 * which is what stops a push from filing a row under someone else.
 */
const COLLECTIONS = {
  transactions: {
    fields: ['amount', 'type', 'category', 'note', 'date', 'currency', 'isRecurring',
             'recurrenceFrequency', 'nextDueDate', 'isPrivate', 'accountId', 'createdAt'],
    // Update validators only check the paths in the update, so an insert has to be checked here.
    required: ['amount', 'type', 'category'],
    ownerKey: 'userId',
  },
  budgets:  { fields: ['amount', 'month', 'year', 'category', 'createdAt'], required: ['amount', 'month', 'year'], ownerKey: 'userId' },
  accounts: { fields: ['name', 'type', 'openingBalance', 'color', 'icon', 'createdAt'], required: ['name'], ownerKey: 'userId' },
  goals:    { fields: ['name', 'targetAmount', 'savedAmount', 'deadline', 'icon', 'color', 'createdAt'], required: ['name', 'targetAmount'], ownerKey: 'userId' },
  trips:    { fields: ['name', 'currency', 'members', 'expenses', 'settlements', 'createdAt'], required: ['name'], ownerKey: 'ownerId' },
  categories: { fields: ['name', 'icon', 'emoji', 'type'], required: ['name'], ownerKey: null },
};

// Categories before the rows that reference them; the rest in an order that never matters.
const PUSH_ORDER = ['categories', 'accounts', 'budgets', 'goals', 'transactions', 'trips'];

class SyncError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function isValidDate(v) {
  const d = v instanceof Date ? v : new Date(v);
  return !Number.isNaN(d.getTime());
}

/** Validate and normalise a push body; throws a 400 `SyncError` on anything malformed. */
function validateBatch(body) {
  const items = body && body.items;
  if (!Array.isArray(items)) throw new SyncError(400, 'items must be an array');
  if (items.length === 0) throw new SyncError(400, 'items is empty');
  if (items.length > MAX_BATCH) throw new SyncError(400, `at most ${MAX_BATCH} items per push`);

  const out = items.map((it, i) => {
    if (!it || typeof it !== 'object') throw new SyncError(400, `items[${i}] is not an object`);
    if (!COLLECTIONS[it.collection]) throw new SyncError(400, `items[${i}].collection is unknown`);
    if (it.op !== 'upsert' && it.op !== 'delete') throw new SyncError(400, `items[${i}].op must be upsert or delete`);
    if (typeof it.clientId !== 'string' || !CLIENT_ID.test(it.clientId)) throw new SyncError(400, `items[${i}].clientId is invalid`);
    if (!isValidDate(it.updatedAt)) throw new SyncError(400, `items[${i}].updatedAt is not a date`);
    if (it.op === 'upsert' && (!it.payload || typeof it.payload !== 'object')) throw new SyncError(400, `items[${i}].payload is required for upsert`);
    return {
      index: i,
      collection: it.collection,
      op: it.op,
      clientId: it.clientId,
      updatedAt: new Date(it.updatedAt),
      groupId: typeof it.groupId === 'string' ? it.groupId : null,
      payload: pickFields(it.collection, it.payload || {}),
    };
  });

  const rank = (c) => PUSH_ORDER.indexOf(c);
  return out.sort((a, b) => rank(a.collection) - rank(b.collection) || a.index - b.index);
}

/** The fields an insert cannot do without; throws a 400 `SyncError` naming the first missing one. */
function requireForInsert(collection, payload) {
  for (const k of COLLECTIONS[collection].required || []) {
    if (payload[k] === undefined || payload[k] === null || payload[k] === '') throw new SyncError(400, `${k} is required`);
  }
  if (collection === 'transactions' && !(Number(payload.amount) > 0)) throw new SyncError(400, 'amount must be greater than 0');
}

/** Only the fields the collection allows, and only when present. */
function pickFields(collection, payload) {
  const allowed = COLLECTIONS[collection].fields;
  const out = {};
  for (const k of allowed) if (payload[k] !== undefined) out[k] = payload[k];
  return out;
}

/**
 * Last writer wins, per row. `null` existing means "nothing to lose". Equal clocks apply — a
 * retried batch re-applies the same row, which is the point of idempotency.
 */
function lww(existingUpdatedAt, incomingUpdatedAt) {
  if (!existingUpdatedAt) return 'apply';
  return new Date(existingUpdatedAt).getTime() > new Date(incomingUpdatedAt).getTime() ? 'superseded' : 'apply';
}

/** A row's id as the device knows it: its `clientId`, or its `_id` for rows that predate sync. */
function toClientId(row) {
  return row.clientId || String(row._id);
}

/**
 * Cut one page of the changes feed from rows gathered across collections.
 *
 * Sorted by `syncedAt`, then by collection and id so the order is total. The page is cut at
 * `limit` and then *extended* to include every further row that shares the last `syncedAt`:
 * the cursor is that timestamp and the next request asks for `> cursor`, so a row with the
 * same stamp left on the far side of the cut would never be seen. `hasMore` is true when rows
 * remain beyond the extended page.
 */
function cutPage(rows, limit) {
  const max = Math.max(1, Math.min(MAX_PAGE, limit || MAX_PAGE));
  const sorted = [...rows].sort((a, b) =>
    (new Date(a.syncedAt).getTime() - new Date(b.syncedAt).getTime())
    || (a.collection < b.collection ? -1 : a.collection > b.collection ? 1 : 0)
    || (a.clientId < b.clientId ? -1 : a.clientId > b.clientId ? 1 : 0));

  if (sorted.length <= max) {
    const last = sorted[sorted.length - 1];
    return { changes: sorted, cursor: last ? new Date(last.syncedAt).toISOString() : null, hasMore: false };
  }

  let end = max;
  const stamp = new Date(sorted[max - 1].syncedAt).getTime();
  while (end < sorted.length && new Date(sorted[end].syncedAt).getTime() === stamp) end++;
  const page = sorted.slice(0, end);
  return { changes: page, cursor: new Date(page[page.length - 1].syncedAt).toISOString(), hasMore: end < sorted.length };
}

/** Parse the `since` query: absent means "everything", anything else must be a date. */
function parseSince(value) {
  if (value === undefined || value === null || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new SyncError(400, 'since must be an ISO date');
  return d;
}

module.exports = { COLLECTIONS, PUSH_ORDER, MAX_BATCH, MAX_PAGE, SyncError, validateBatch, pickFields, requireForInsert, lww, toClientId, cutPage, parseSince };
