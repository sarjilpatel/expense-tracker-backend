const mongoose    = require('mongoose');
const Transaction = require('../models/Transaction');
const Budget      = require('../models/Budget');
const Account     = require('../models/Account');
const Goal        = require('../models/Goal');
const Trip        = require('../models/Trip');
const Group       = require('../models/Group');
const User        = require('../models/User');
const { encryptField, decryptField, noteTokens } = require('../utils/fieldCrypto');
const { activeCategories } = require('../utils/categories');
const {
  COLLECTIONS, SyncError, validateBatch, requireForInsert, lww, toClientId, cutPage, parseSince,
} = require('../utils/sync');

/**
 * The sync API (W3-07/08). Two endpoints, both idempotent:
 *
 *   POST /api/sync/push     a batch of device writes, upserted by clientId, last writer wins
 *   GET  /api/sync/changes  every row that changed on the server since a cursor, tombstones included
 *
 * Scope is the caller's: their own rows, plus the non-private rows of every group they belong to.
 * Ownership never comes from the payload (see `COLLECTIONS` in utils/sync.js).
 */

const MODELS = { transactions: Transaction, budgets: Budget, accounts: Account, goals: Goal, trips: Trip };

const isObjectId = (v) => typeof v === 'string' && mongoose.isValidObjectId(v);

/** The device-facing shape of a row: the note in clear, the blind index never. */
function serialize(collection, row) {
  const plain = typeof row.toObject === 'function' ? row.toObject() : { ...row };
  delete plain.noteTokens;
  delete plain.__v;
  if (collection === 'transactions' && plain.note) plain.note = decryptField(plain.note);
  return plain;
}

/** Fields the server derives for a transaction from its clear-text note. */
function noteFields(payload) {
  if (payload.note === undefined) return {};
  const raw = payload.note ? String(payload.note).trim().slice(0, 200) : '';
  return raw
    ? { note: encryptField(raw), noteTokens: noteTokens(raw) }
    : { note: undefined, noteTokens: [] };
}

/** The groups the caller belongs to, as id strings, and the active one. */
async function callerScope(userId) {
  const [user, groups] = await Promise.all([
    User.findById(userId),
    Group.find({ members: userId }),
  ]);
  if (!user) throw new SyncError(401, 'Unauthorized');
  const groupIds = groups.map((g) => String(g._id));
  const activeGroupId = user.groupId ? String(user.groupId) : (groupIds[0] || null);
  return { user, groups, groupIds, activeGroupId };
}

/** The group a pushed row is filed under: the one it names if the caller is a member, else the active one. */
function resolveGroupId(item, scope) {
  if (item.groupId && scope.groupIds.includes(item.groupId)) return item.groupId;
  return scope.activeGroupId;
}

/** Find a row by clientId, or by _id for rows that predate sync. */
async function findExisting(Model, ownerFilter, clientId) {
  const byClient = await Model.findOne({ ...ownerFilter, clientId });
  if (byClient) return byClient;
  if (isObjectId(clientId)) return Model.findOne({ ...ownerFilter, _id: clientId });
  return null;
}

async function applyRow(item, scope) {
  const Model    = MODELS[item.collection];
  const ownerKey = COLLECTIONS[item.collection].ownerKey;
  const userId   = scope.user._id;

  // Trips are shared: any member of the trip's group may address it, and a new one is owned by
  // whoever pushed it. Everything else is the caller's own.
  const ownerFilter = item.collection === 'trips'
    ? { groupId: { $in: scope.groupIds } }
    : { [ownerKey]: userId };

  const existing = await findExisting(Model, ownerFilter, item.clientId);
  if (existing && lww(existing.updatedAt, item.updatedAt) === 'superseded') {
    return { status: 'superseded', serverId: String(existing._id), row: serialize(item.collection, existing) };
  }

  if (item.op === 'delete') {
    // Nothing to tombstone if the server never saw it — the create and the delete cancelled out.
    if (!existing) return { status: 'applied', serverId: null };
    existing.set({ deletedAt: item.updatedAt, updatedAt: item.updatedAt });
    await existing.save();
    return { status: 'applied', serverId: String(existing._id), row: serialize(item.collection, existing) };
  }

  if (!existing) requireForInsert(item.collection, item.payload);
  const fields = { ...item.payload };
  if (item.collection === 'transactions') Object.assign(fields, noteFields(item.payload));
  if (item.collection === 'trips') delete fields.createdAt;

  const scoped = { [ownerKey]: existing ? existing[ownerKey] : userId };
  if (item.collection === 'transactions' || item.collection === 'goals' || item.collection === 'trips') {
    scoped.groupId = existing ? existing.groupId : resolveGroupId(item, scope);
  }
  if (item.collection === 'budgets') scoped.groupId = existing ? existing.groupId : (scope.user.groupId || null);

  // A cleared note is unset, not set to undefined — Mongoose drops undefined from $set.
  const update = { $set: { ...fields, ...scoped, clientId: item.clientId, updatedAt: item.updatedAt, deletedAt: null } };
  if ('note' in fields && fields.note === undefined) { delete update.$set.note; update.$unset = { note: 1 }; }

  const filter = existing ? { _id: existing._id } : { ...ownerFilter, clientId: item.clientId };
  const row = await Model.findOneAndUpdate(
    filter, update,
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
  );
  return { status: 'applied', serverId: String(row._id), row: serialize(item.collection, row) };
}

/** Categories live on the group document, so they are upserted in place and the group saved. */
async function applyCategory(item, scope) {
  const groupId = resolveGroupId(item, scope);
  const group   = scope.groups.find((g) => String(g._id) === groupId);
  if (!group) throw new SyncError(400, 'You are not in any group');

  let cat = group.categories.find((c) => c.clientId === item.clientId)
         || (isObjectId(item.clientId) ? group.categories.find((c) => String(c._id) === item.clientId) : null);

  if (cat && lww(cat.updatedAt, item.updatedAt) === 'superseded') {
    return { status: 'superseded', serverId: String(cat._id), row: cat.toObject ? cat.toObject() : { ...cat } };
  }

  if (item.op === 'delete') {
    if (!cat) return { status: 'applied', serverId: null };
    cat.set({ deletedAt: item.updatedAt, updatedAt: item.updatedAt });
    await group.save();
    return { status: 'applied', serverId: String(cat._id) };
  }

  // Names are what transactions reference: a second active category with the same name would
  // make every lookup ambiguous, so it is treated as the one that already exists.
  const name = String(item.payload.name || '').trim().slice(0, 30);
  if (!name) throw new SyncError(400, 'Category name is required');
  const clash = activeCategories(group).find((c) => c !== cat && c.name.trim().toLowerCase() === name.toLowerCase());
  if (clash) {
    return { status: 'superseded', serverId: String(clash._id), row: clash.toObject ? clash.toObject() : { ...clash } };
  }

  const fields = { name, icon: item.payload.icon, emoji: item.payload.emoji || '', type: item.payload.type || 'expense' };
  if (cat) {
    cat.set({ ...fields, updatedAt: item.updatedAt, deletedAt: null });
  } else {
    group.categories.push({ ...fields, clientId: item.clientId, updatedAt: item.updatedAt });
    cat = group.categories[group.categories.length - 1];
  }
  await group.save();
  return { status: 'applied', serverId: String(cat._id), row: cat.toObject ? cat.toObject() : { ...cat } };
}

exports.push = async (req, res) => {
  let items;
  try { items = validateBatch(req.body); }
  catch (e) { return res.status(e.status || 400).json({ message: e.message }); }

  const scope = await callerScope(req.user.id);
  const results = [];
  for (const item of items) {
    try {
      const r = item.collection === 'categories' ? await applyCategory(item, scope) : await applyRow(item, scope);
      results.push({ clientId: item.clientId, collection: item.collection, ...r });
    } catch (e) {
      // One bad row must not sink the batch: the device keeps that row in its outbox and the
      // rest land. A validation failure is the device's fault (400-shaped); anything else is ours.
      const rejected = e instanceof SyncError || e.name === 'ValidationError' || e.name === 'CastError';
      results.push({ clientId: item.clientId, collection: item.collection, status: 'rejected', error: rejected ? e.message : 'Server error' });
      if (!rejected) console.error('[sync] push failed for', item.collection, item.clientId, e);
    }
  }

  // Sorting the batch is a server concern; the device matches results by clientId, not position.
  res.json({ results, serverTime: new Date().toISOString() });
};

exports.changes = async (req, res) => {
  let since;
  try { since = parseSince(req.query.since); }
  catch (e) { return res.status(e.status).json({ message: e.message }); }
  const limit = parseInt(req.query.limit || '500', 10);
  const scope = await callerScope(req.user.id);
  const userId = scope.user._id;
  const groupIds = scope.groupIds;

  // Without a cursor this is a full pull, and a tombstone has nothing to tell a device that has
  // never seen the row.
  const stamp = since ? { syncedAt: { $gt: since } } : { deletedAt: null };
  const scopes = {
    transactions: { ...stamp, $or: [{ userId }, { groupId: { $in: groupIds }, isPrivate: { $ne: true } }] },
    budgets:      { ...stamp, userId },
    accounts:     { ...stamp, userId },
    goals:        { ...stamp, $or: [{ userId }, { groupId: { $in: groupIds } }] },
    trips:        { ...stamp, groupId: { $in: groupIds } },
  };

  // One more than the page from every collection: enough to know whether there is a next page
  // even if a single collection fills this one.
  const fetch = Math.max(1, Math.min(1000, limit)) + 1;
  const rows = [];
  let truncated = false;
  for (const [collection, filter] of Object.entries(scopes)) {
    const found = await MODELS[collection].find(filter).sort({ syncedAt: 1 }).limit(fetch).lean();
    // A collection that filled its quota may have more beyond it — `syncedAt` is strictly
    // increasing per process (utils/clock.js), so whatever was left has a later stamp than the
    // cursor this page ends on and the next request picks it up.
    if (found.length >= fetch) truncated = true;
    for (const row of found) {
      rows.push({
        collection, clientId: toClientId(row), serverId: String(row._id),
        syncedAt: row.syncedAt || row.updatedAt || row.createdAt || new Date(0),
        updatedAt: row.updatedAt || row.createdAt || new Date(0),
        deleted: !!row.deletedAt,
        row: serialize(collection, row),
      });
    }
  }
  for (const group of scope.groups) {
    for (const c of group.categories) {
      const syncedAt = c.syncedAt || new Date(0);
      if (since ? syncedAt <= since : c.deletedAt) continue;
      const plain = typeof c.toObject === 'function' ? c.toObject() : { ...c };
      rows.push({
        collection: 'categories', clientId: toClientId(c), serverId: String(c._id),
        syncedAt, updatedAt: c.updatedAt || syncedAt, deleted: !!c.deletedAt,
        row: { ...plain, groupId: String(group._id) },
      });
    }
  }

  const page = cutPage(rows, limit);
  res.json({
    ...page,
    hasMore: page.hasMore || truncated,
    cursor: page.cursor || (since ? since.toISOString() : null),
    serverTime: new Date().toISOString(),
  });
};
