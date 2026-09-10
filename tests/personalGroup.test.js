// Every account owns a personal group.
//
// Categories live on the Group, and signup used to leave `groupId` null — so a fresh account had
// nowhere to keep them: /group/details answered 404 "You are not in any group", every category
// screen came up empty, adding one 400'd, and add-transaction had nothing to offer. Giving each
// user a group of their own means categories, scoping and validation keep one code path.
//
// The hazard that comes with it, and the reason most of this file exists: `buildScope` scopes a
// user with no group by `userId` and a user with one by `groupId`. Handing someone a group without
// moving their existing `groupId: null` rows into it makes their entire history disappear from the
// app. `ensurePersonalGroup` does that adoption itself, which is what makes the lazy heal on login
// safe — the migration script is the same work done to everyone at once.

const test   = require('node:test');
const assert = require('node:assert/strict');
const { loadWithStubs, mockRes } = require('./helpers/stubs');

// Callers reach for these two both ways — `await Model.findById(id)` and
// `Model.findById(id).populate(...)` — so the fakes hand back something that does both.
function thenable(value) {
  const q = {
    populate: () => q,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return q;
}

// --- fakes -----------------------------------------------------------------------------------

function fakeGroups(rows = []) {
  let seq = 0;
  const match = (row, filter) => Object.entries(filter).every(([k, v]) => {
    if (k === '_id')     return String(row._id) === String(v);
    if (k === 'members') return (row.members || []).some(m => String(m) === String(v));
    if (k === 'owner')   return String(row.owner) === String(v);
    return row[k] === v;
  });
  const api = {
    rows,
    async create(doc) {
      const row = { _id: `g${++seq}`, categories: [{ name: 'Food', type: 'expense' }], pendingMembers: [], ...doc };
      row.save = async () => row;
      rows.push(row);
      return row;
    },
    async findOne(filter) { return rows.find(r => match(r, filter)) || null; },
    findById(id)          { return thenable(rows.find(r => String(r._id) === String(id)) || null); },
    async find(filter)    { return rows.filter(r => match(r, filter)); },
  };
  return api;
}

function fakeUsers(rows = []) {
  return {
    rows,
    // getGroupDetails calls this bare; approveJoinRequest calls .populate() on it.
    findById(id) { return thenable(rows.find(r => String(r._id) === String(id)) || null); },
    async findByIdAndUpdate(id, update) {
      const row = rows.find(r => String(r._id) === String(id));
      if (row) Object.assign(row, update);
      return row;
    },
  };
}

// Records what was re-pointed at the new group — the adoption is the whole point.
function fakeCollection(rows = []) {
  return {
    rows,
    async updateMany(filter, update) {
      let n = 0;
      for (const row of rows) {
        const hit = String(row.userId) === String(filter.userId) && row.groupId == null;
        if (hit) { Object.assign(row, update); n++; }
      }
      return { modifiedCount: n };
    },
    async countDocuments(filter) {
      return rows.filter(r => String(r.userId) === String(filter.userId) && r.groupId == null).length;
    },
  };
}

function loadPersonalGroup({ groups, users, transactions = fakeCollection(), goals = fakeCollection() }) {
  return loadWithStubs('utils/personalGroup.js', {
    '../models/Group':       groups,
    '../models/User':        users,
    '../models/Transaction': transactions,
    '../models/Goal':        goals,
  });
}

function loadGroupCtrl({ groups, users }) {
  // The controller delegates to utils/personalGroup, which needs the same models — `also` is what
  // reaches through to it, so the real helper runs rather than a paraphrase of it.
  return loadWithStubs('controllers/groupController.js', {
    '../models/Group':       groups,
    '../models/User':        users,
    '../models/Transaction': fakeCollection(),
    '../models/Goal':        fakeCollection(),
  }, { also: ['utils/personalGroup.js'] });
}

const req = (over = {}) => ({ user: { id: 'u1' }, params: {}, body: {}, app: { get: () => null }, ...over });

// --- utils/personalGroup.js ------------------------------------------------------------------

test('a user with no group gets one, and is switched into it', async () => {
  const users  = fakeUsers([{ _id: 'u1', groupId: null }]);
  const groups = fakeGroups();
  const pg     = loadPersonalGroup({ groups, users });

  const group = await pg.ensurePersonalGroup(users.rows[0]);

  assert.equal(group.isPersonal, true);
  assert.equal(group.owner, 'u1');
  assert.deepEqual(group.members, ['u1']);
  assert.equal(users.rows[0].groupId, group._id, 'the user is switched into it');
  assert.ok(group.categories.length, 'it starts with the default categories');
});

test('a personal group has no join code — it is not something anyone can join', async () => {
  const users  = fakeUsers([{ _id: 'u1', groupId: null }]);
  const groups = fakeGroups();
  const pg     = loadPersonalGroup({ groups, users });

  const group = await pg.ensurePersonalGroup(users.rows[0]);

  assert.equal(group.joinCode, null);
});

test('the existing history moves into the new group — without this it all disappears', async () => {
  const users  = fakeUsers([{ _id: 'u1', groupId: null }]);
  const groups = fakeGroups();
  const txs    = fakeCollection([
    { _id: 't1', userId: 'u1', groupId: null },
    { _id: 't2', userId: 'u1', groupId: null },
    { _id: 't3', userId: 'u2', groupId: null },       // someone else's — must not move
    { _id: 't4', userId: 'u1', groupId: 'shared1' },  // already grouped — must not move
  ]);
  const goals  = fakeCollection([{ _id: 'gl1', userId: 'u1', groupId: null }]);
  const pg     = loadPersonalGroup({ groups, users, transactions: txs, goals });

  const group = await pg.ensurePersonalGroup(users.rows[0]);

  assert.equal(txs.rows[0].groupId, group._id);
  assert.equal(txs.rows[1].groupId, group._id);
  assert.equal(txs.rows[2].groupId, null,      "another user's rows are untouched");
  assert.equal(txs.rows[3].groupId, 'shared1', 'a row already in a group stays there');
  assert.equal(goals.rows[0].groupId, group._id, 'goals move too — they carry a groupId as well');
});

test('called twice it creates one group and adopts nothing the second time', async () => {
  const users  = fakeUsers([{ _id: 'u1', groupId: null }]);
  const groups = fakeGroups();
  const txs    = fakeCollection([{ _id: 't1', userId: 'u1', groupId: null }]);
  const pg     = loadPersonalGroup({ groups, users, transactions: txs });

  const first  = await pg.ensurePersonalGroup(users.rows[0]);
  txs.rows.push({ _id: 't2', userId: 'u1', groupId: null });   // written later, into a shared group
  const second = await pg.ensurePersonalGroup(users.rows[0]);

  assert.equal(String(first._id), String(second._id));
  assert.equal(groups.rows.length, 1);
  assert.equal(txs.rows[1].groupId, null, 'a later row is not swept up by a second call');
});

test('someone already in a shared group keeps it', async () => {
  const users  = fakeUsers([{ _id: 'u1', groupId: 'shared1' }]);
  const groups = fakeGroups([{ _id: 'shared1', isPersonal: false, members: ['u1'], categories: [] }]);
  const pg     = loadPersonalGroup({ groups, users });

  await pg.ensurePersonalGroup(users.rows[0], { setActive: false });

  assert.equal(users.rows[0].groupId, 'shared1');
  assert.equal(groups.rows.length, 2, 'the personal group still exists, it is just not the active one');
});

test('a dangling groupId is healed rather than left to 500', async () => {
  const users  = fakeUsers([{ _id: 'u1', groupId: 'deleted-group' }]);
  const groups = fakeGroups();
  const pg     = loadPersonalGroup({ groups, users });

  const group = await pg.resolveActiveGroup(users.rows[0]);

  assert.equal(group.isPersonal, true);
});

// --- the endpoints that used to 404 ----------------------------------------------------------

test('getGroupDetails no longer answers "You are not in any group"', async () => {
  const users = fakeUsers([{ _id: 'u1', groupId: null }]);
  const ctrl  = loadGroupCtrl({ groups: fakeGroups(), users });
  const res   = mockRes();

  await ctrl.getGroupDetails(req(), res);

  assert.equal(res.statusCode, null);
  assert.equal(res.body.isPersonal, true);
  assert.ok(res.body.categories.length, 'the category screens have something to show');
});

test('a category can be added with no group of your own making', async () => {
  const users = fakeUsers([{ _id: 'u1', groupId: null }]);
  const ctrl  = loadGroupCtrl({ groups: fakeGroups(), users });
  const res   = mockRes();

  await ctrl.addCategory(req({ body: { name: 'Coffee', icon: 'cafe', emoji: '☕', type: 'expense' } }), res);

  assert.equal(res.statusCode, null);
  const added = res.body.find(c => c.name === 'Coffee');
  assert.ok(added, 'it landed in the personal group');
  assert.equal(added.emoji, '☕', 'the emoji the app sent is kept, not dropped');
});

test('a duplicate category name is refused — transactions reference categories by name', async () => {
  const users = fakeUsers([{ _id: 'u1', groupId: null }]);
  const ctrl  = loadGroupCtrl({ groups: fakeGroups(), users });
  const res   = mockRes();

  await ctrl.addCategory(req({ body: { name: '  food ', type: 'expense' } }), res);

  assert.equal(res.statusCode, 400);
});

// --- presets ---------------------------------------------------------------------------------

test('a preset adds its whole pack in one call', async () => {
  const users = fakeUsers([{ _id: 'u1', groupId: null }]);
  const ctrl  = loadGroupCtrl({ groups: fakeGroups(), users });
  const res   = mockRes();

  await ctrl.applyCategoryPreset(req({ params: { key: 'travel' } }), res);

  assert.ok(res.body.added > 5);
  assert.ok(res.body.categories.some(c => c.name === 'Flights'));
});

test('applying the same preset twice adds nothing the second time', async () => {
  const users = fakeUsers([{ _id: 'u1', groupId: null }]);
  const ctrl  = loadGroupCtrl({ groups: fakeGroups(), users });

  const first = mockRes();
  await ctrl.applyCategoryPreset(req({ params: { key: 'wedding' } }), first);
  const again = mockRes();
  await ctrl.applyCategoryPreset(req({ params: { key: 'wedding' } }), again);

  assert.ok(first.body.added > 0);
  assert.equal(again.body.added, 0);
  assert.equal(again.body.categories.length, first.body.categories.length);
});

test('a preset does not duplicate a category the group already has', async () => {
  const users = fakeUsers([{ _id: 'u1', groupId: null }]);
  const ctrl  = loadGroupCtrl({ groups: fakeGroups(), users });
  const res   = mockRes();

  // The default list already carries Food; the household pack carries Groceries but not Food.
  await ctrl.applyCategoryPreset(req({ params: { key: 'household' } }), res);

  const names = res.body.categories.map(c => c.name.toLowerCase());
  assert.equal(names.filter(n => n === 'food').length, 1);
});

test('an unknown preset key is a 404, not a silent no-op', async () => {
  const users = fakeUsers([{ _id: 'u1', groupId: null }]);
  const ctrl  = loadGroupCtrl({ groups: fakeGroups(), users });
  const res   = mockRes();

  await ctrl.applyCategoryPreset(req({ params: { key: 'nonsense' } }), res);

  assert.equal(res.statusCode, 404);
});

test('the old wedding-preset route still works', async () => {
  const users = fakeUsers([{ _id: 'u1', groupId: null }]);
  const ctrl  = loadGroupCtrl({ groups: fakeGroups(), users });
  const res   = mockRes();

  await ctrl.setupWeddingCategories(req(), res);

  assert.ok(res.body.categories.some(c => c.name === 'Catering (Jamvanu)'));
});

// --- joining a shared group ------------------------------------------------------------------

test('an approved member is moved out of their personal group into the shared one', async () => {
  // The old condition here was `!approvedUser.groupId`, which stopped being true the moment every
  // account had a personal group — the user would have been added to `members` and left behind.
  const users  = fakeUsers([
    { _id: 'owner1', groupId: 'shared1' },
    { _id: 'u2',     groupId: { _id: 'pg-u2', isPersonal: true } },
  ]);
  const groups = fakeGroups([
    { _id: 'shared1', isPersonal: false, owner: 'owner1', members: ['owner1'],
      pendingMembers: [{ userId: 'u2' }], categories: [], save: async () => {} },
  ]);
  const ctrl = loadGroupCtrl({ groups, users });
  const res  = mockRes();

  await ctrl.approveJoinRequest(
    req({ user: { id: 'owner1' }, params: { groupId: 'shared1', userId: 'u2' } }), res);

  assert.equal(res.statusCode, null);
  assert.equal(users.rows[1].groupId, 'shared1');
  assert.ok(groups.rows[0].members.includes('u2'));
});

test('an approved member already in another shared group is not yanked out of it', async () => {
  const users  = fakeUsers([
    { _id: 'owner1', groupId: 'shared1' },
    { _id: 'u2',     groupId: { _id: 'shared2', isPersonal: false } },
  ]);
  const groups = fakeGroups([
    { _id: 'shared1', isPersonal: false, owner: 'owner1', members: ['owner1'],
      pendingMembers: [{ userId: 'u2' }], categories: [], save: async () => {} },
  ]);
  const ctrl = loadGroupCtrl({ groups, users });
  const res  = mockRes();

  await ctrl.approveJoinRequest(
    req({ user: { id: 'owner1' }, params: { groupId: 'shared1', userId: 'u2' } }), res);

  assert.equal(users.rows[1].groupId._id, 'shared2', 'they switch by hand from the group list');
  assert.ok(groups.rows[0].members.includes('u2'), 'they are still a member of the new one');
});
