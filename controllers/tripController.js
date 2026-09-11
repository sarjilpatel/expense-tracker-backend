// Trips: one bill-splitting model for the whole app (W2-28).
//
// This replaces `splitController`. A split was a single bill divided among real `User` rows in a
// group; a trip is a named container of many bills whose members are ad-hoc — a `name` is all a
// member needs — so the feature finally covers the case the local TripMaster screen existed for,
// and the same rows can be reached signed in or out. Money is integer minor units throughout.
//
// No handler wraps itself in try/catch, unlike `splitController`, which answered every throw with
// a blanket 500 `{ msg: 'Server Error' }`. Express 5 routes a rejected promise to
// `middleware/errorHandler`, which logs 5xx and classifies the rest — a malformed trip id, for
// one, becomes a 400 instead of a 500. Deliberate errors here use `message`, which is the key the
// app reads (`error.response?.data?.message`) and the key the error handler sends.

const crypto = require('crypto');
const Trip   = require('../models/Trip');
const User   = require('../models/User');

const populate = [
  { path: 'ownerId',        select: 'name profilePhoto' },
  { path: 'members.userId', select: 'name profilePhoto' },
];

const genId = () => crypto.randomUUID();

/**
 * Loads the caller's group and the trip in it, or answers and returns null.
 *
 * Every handler below starts with the same two lookups and the same two failure responses, and the
 * group scope is the security boundary — a trip is only ever reachable through the group the caller
 * currently belongs to, so a stale trip id from a group they have left resolves to a 404 rather
 * than to somebody else's data.
 */
async function loadTrip(req, res) {
  const user = await User.findById(req.user.id);
  if (!user?.groupId) { res.status(400).json({ message: 'User not in a group' }); return null; }

  const trip = await Trip.findOne({ _id: req.params.id, groupId: user.groupId });
  if (!trip) { res.status(404).json({ message: 'Trip not found' }); return null; }

  return { user, trip };
}

/**
 * Only the owner may change a trip.
 *
 * This is the rule W1-27 settled for splits, carried over intact: a split was the payer's record of
 * what they were owed and only they could settle or delete it, because group membership alone let
 * any member clear their own debt or destroy the evidence of it. A trip is that record with more
 * than one bill in it, so the authority is the same — with the single exception of confirming a
 * payment, which belongs to whoever received it (see `addSettlement`).
 */
function ownsTrip(trip, req) {
  return trip.ownerId.toString() === req.user.id.toString();
}

const emit = (req, trip, event, payload) => {
  const io = req.app.get('io');
  if (io) io.to(trip.groupId.toString()).emit(event, payload);
};

const saveAndReturn = async (req, res, trip, event = 'trip_updated') => {
  await trip.save();
  emit(req, trip, event, { _id: trip._id, groupId: trip.groupId });
  res.json(await trip.populate(populate));
};

/** Truncates to an integer and rejects anything that is not a usable amount of money. */
function toMinor(value) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/* ------------------------------------------------------------------ trips */

exports.getTrips = async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user?.groupId) return res.status(400).json({ message: 'User not in a group' });

  const trips = await Trip.find({ groupId: user.groupId })
    .populate(populate)
    .sort({ updatedAt: -1 });

  res.json(trips);
};

exports.getTrip = async (req, res) => {
  const loaded = await loadTrip(req, res);
  if (!loaded) return;
  res.json(await loaded.trip.populate(populate));
};

exports.createTrip = async (req, res) => {
  const { name, currency, members } = req.body;
  const user = await User.findById(req.user.id);
  if (!user?.groupId) return res.status(400).json({ message: 'User not in a group' });

  if (!name || !String(name).trim()) return res.status(400).json({ message: 'Trip name is required' });

  // The creator is always a member: the app states every balance relative to them, and a trip whose
  // owner is not in it can neither pay for anything nor be owed anything.
  const supplied = Array.isArray(members) ? members : [];
  const seed = [
    { id: genId(), name: user.name, userId: user._id },
    ...supplied
      .filter(m => m?.name && String(m.name).trim())
      .filter(m => !m.userId || m.userId.toString() !== user._id.toString())
      .map(m => ({ id: m.id || genId(), name: String(m.name).trim().slice(0, 60), userId: m.userId || null })),
  ];

  const trip = await Trip.create({
    groupId:  user.groupId,
    ownerId:  user._id,
    name:     String(name).trim().slice(0, 80),
    currency: currency || 'INR',
    members:  seed,
  });

  emit(req, trip, 'trip_created', { _id: trip._id, groupId: trip.groupId });
  res.status(201).json(await trip.populate(populate));
};

exports.updateTrip = async (req, res) => {
  const loaded = await loadTrip(req, res);
  if (!loaded) return;
  const { trip } = loaded;
  if (!ownsTrip(trip, req)) return res.status(403).json({ message: 'Only the trip owner can rename this trip' });

  const { name, currency } = req.body;
  if (name !== undefined) {
    if (!String(name).trim()) return res.status(400).json({ message: 'Trip name is required' });
    trip.name = String(name).trim().slice(0, 80);
  }
  if (currency !== undefined) trip.currency = currency;

  await saveAndReturn(req, res, trip);
};

exports.deleteTrip = async (req, res) => {
  const loaded = await loadTrip(req, res);
  if (!loaded) return;
  const { trip } = loaded;
  if (!ownsTrip(trip, req)) return res.status(403).json({ message: 'Only the trip owner can delete this trip' });

  await trip.deleteOne();
  emit(req, trip, 'trip_deleted', req.params.id);
  res.json({ message: 'Trip deleted' });
};

/* ---------------------------------------------------------------- members */

exports.addMember = async (req, res) => {
  const loaded = await loadTrip(req, res);
  if (!loaded) return;
  const { trip } = loaded;
  if (!ownsTrip(trip, req)) return res.status(403).json({ message: 'Only the trip owner can add members' });

  const { name, userId } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ message: 'Member name is required' });
  if (userId && trip.members.some(m => m.userId?.toString() === userId.toString())) {
    return res.status(400).json({ message: 'That person is already in this trip' });
  }

  trip.members.push({ id: genId(), name: String(name).trim().slice(0, 60), userId: userId || null });
  await saveAndReturn(req, res, trip);
};

exports.updateMember = async (req, res) => {
  const loaded = await loadTrip(req, res);
  if (!loaded) return;
  const { trip } = loaded;
  if (!ownsTrip(trip, req)) return res.status(403).json({ message: 'Only the trip owner can rename members' });

  const member = trip.members.find(m => m.id === req.params.memberId);
  if (!member) return res.status(404).json({ message: 'Member not in this trip' });

  const { name } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ message: 'Member name is required' });
  member.name = String(name).trim().slice(0, 60);

  await saveAndReturn(req, res, trip);
};

/**
 * Removing a member also removes what cannot survive them.
 *
 * An expense they paid for has no payer left, and one they merely shared has a participant fewer —
 * so the first is deleted outright and the second rewritten, along with any explicit share of
 * theirs and any payment they were a party to. This is the cascade the local trip service already
 * performs (`removeMember` in `src/services/local/tripMasterService.ts`); the two implementations
 * have to agree, or the same action produces different balances either side of a login.
 */
exports.removeMember = async (req, res) => {
  const loaded = await loadTrip(req, res);
  if (!loaded) return;
  const { trip } = loaded;
  if (!ownsTrip(trip, req)) return res.status(403).json({ message: 'Only the trip owner can remove members' });

  const id = req.params.memberId;
  if (!trip.members.some(m => m.id === id)) return res.status(404).json({ message: 'Member not in this trip' });
  if (trip.members.length === 1) return res.status(400).json({ message: 'A trip needs at least one member' });

  trip.members  = trip.members.filter(m => m.id !== id);
  trip.expenses = trip.expenses
    .filter(e => e.paidById !== id)
    .map(e => {
      e.participantIds = e.participantIds.filter(p => p !== id);
      if (e.sharesMinor) e.sharesMinor.delete(id);
      return e;
    })
    // An expense nobody is left to share is no longer a debt.
    .filter(e => (e.sharesMinor ? e.sharesMinor.size : e.participantIds.length) > 0);
  trip.settlements = trip.settlements.filter(s => s.fromId !== id && s.toId !== id);

  await saveAndReturn(req, res, trip);
};

/* --------------------------------------------------------------- expenses */

/**
 * Validates an expense against the trip's member list and normalises its money.
 *
 * `sharesMinor` is the whole truth when present — its keys are the participants and its values the
 * shares — which is exactly how the app's settlement engine reads it, so the stored `amountMinor`
 * is their sum rather than a second declaration of the same fact. The old split endpoint took a
 * total *and* a list of amounts and compared them with a 0.01 tolerance: it knew the two could
 * disagree and allowed it. Here they cannot, because only one of them is ever recorded.
 */
function readExpense(body, trip) {
  const known = new Set(trip.members.map(m => m.id));

  const description = String(body.description ?? '').trim();
  if (!description) return { err: 'Description is required' };

  if (!known.has(body.paidById)) return { err: 'The payer is not a member of this trip' };

  if (body.sharesMinor && typeof body.sharesMinor === 'object') {
    const entries = body.sharesMinor instanceof Map
      ? [...body.sharesMinor.entries()]
      : Object.entries(body.sharesMinor);
    const shares = {};
    let total = 0;
    for (const [pid, raw] of entries) {
      if (!known.has(pid)) return { err: 'A share names someone who is not in this trip' };
      const amount = toMinor(raw);
      if (amount === null) return { err: 'Share amounts must be whole numbers of minor units' };
      if (amount === 0) continue;
      shares[pid] = amount;
      total += amount;
    }
    if (total === 0) return { err: 'An expense needs at least one non-zero share' };
    return {
      value: {
        description:    description.slice(0, 80),
        amountMinor:    total,
        paidById:       body.paidById,
        participantIds: Object.keys(shares),
        sharesMinor:    shares,
      },
    };
  }

  const amountMinor = toMinor(body.amountMinor);
  if (amountMinor === null || amountMinor === 0) {
    return { err: 'Amount must be a positive whole number of minor units' };
  }

  const participantIds = [...new Set(Array.isArray(body.participantIds) ? body.participantIds : [])];
  if (!participantIds.length) return { err: 'An expense needs at least one participant' };
  if (participantIds.some(p => !known.has(p))) return { err: 'A participant is not a member of this trip' };

  return {
    value: {
      description: description.slice(0, 80),
      amountMinor,
      paidById: body.paidById,
      participantIds,
      sharesMinor: undefined,
    },
  };
}

exports.addExpense = async (req, res) => {
  const loaded = await loadTrip(req, res);
  if (!loaded) return;
  const { trip } = loaded;
  if (!ownsTrip(trip, req)) return res.status(403).json({ message: 'Only the trip owner can add expenses' });

  const { err, value } = readExpense(req.body, trip);
  if (err) return res.status(400).json({ message: err });

  trip.expenses.push({ id: genId(), ...value, createdAt: new Date() });
  await saveAndReturn(req, res, trip);
};

exports.updateExpense = async (req, res) => {
  const loaded = await loadTrip(req, res);
  if (!loaded) return;
  const { trip } = loaded;
  if (!ownsTrip(trip, req)) return res.status(403).json({ message: 'Only the trip owner can edit expenses' });

  const expense = trip.expenses.find(e => e.id === req.params.expenseId);
  if (!expense) return res.status(404).json({ message: 'Expense not found' });

  // A PATCH states only what changed, so the unchanged fields come from the stored expense — and
  // then the merged result is validated whole, because a new payer can invalidate old participants.
  const merged = { ...expense.toObject(), ...req.body };
  // `sharesMinor: null` is how a caller says "divide this evenly again"; without that, dropping the
  // key would leave the old shares in the merge and the expense would keep dividing itself by them.
  if (req.body.sharesMinor === null) merged.sharesMinor = undefined;

  const { err, value } = readExpense(merged, trip);
  if (err) return res.status(400).json({ message: err });

  Object.assign(expense, value);
  if (!value.sharesMinor) expense.sharesMinor = undefined;

  await saveAndReturn(req, res, trip);
};

exports.deleteExpense = async (req, res) => {
  const loaded = await loadTrip(req, res);
  if (!loaded) return;
  const { trip } = loaded;
  if (!ownsTrip(trip, req)) return res.status(403).json({ message: 'Only the trip owner can delete expenses' });

  const before = trip.expenses.length;
  trip.expenses = trip.expenses.filter(e => e.id !== req.params.expenseId);
  if (trip.expenses.length === before) return res.status(404).json({ message: 'Expense not found' });

  await saveAndReturn(req, res, trip);
};

/* ------------------------------------------------------------ settlements */

/**
 * Records a payment one member actually made to another.
 *
 * Who may do this is the one place the trip rules differ from owner-only, and it is W1-27's
 * principle rather than a departure from it: only the person who is owed can confirm they were paid
 * back. On a split that was always the payer, because a split had exactly one creditor; a trip has
 * as many creditors as it has payers, so the authority follows `toId` — the member receiving the
 * money — and falls back to the owner when that member has no account and so has no way to confirm
 * anything themselves.
 */
exports.addSettlement = async (req, res) => {
  const loaded = await loadTrip(req, res);
  if (!loaded) return;
  const { trip } = loaded;

  const { fromId, toId } = req.body;
  const from = trip.members.find(m => m.id === fromId);
  const to   = trip.members.find(m => m.id === toId);
  if (!from || !to)    return res.status(404).json({ message: 'Member not in this trip' });
  if (fromId === toId) return res.status(400).json({ message: 'A payment needs two different members' });

  const amountMinor = toMinor(req.body.amountMinor);
  if (amountMinor === null || amountMinor === 0) {
    return res.status(400).json({ message: 'Amount must be a positive whole number of minor units' });
  }

  const isRecipient = to.userId && to.userId.toString() === req.user.id.toString();
  if (!isRecipient && !ownsTrip(trip, req)) {
    return res.status(403).json({ message: 'Only the person who was paid can confirm this' });
  }

  trip.settlements.push({ id: genId(), fromId, toId, amountMinor, settledAt: new Date(), recordedBy: req.user.id });
  await saveAndReturn(req, res, trip);
};

/**
 * Un-recording a payment is deleting its record, not writing a second kind of flag (W1-29).
 *
 * Confirming a payment was one-way on splits, so a mis-tap could only be undone by deleting the
 * whole split and re-entering it, losing everyone else's state with it. Whoever was entitled to
 * record the payment is entitled to take it back.
 */
exports.deleteSettlement = async (req, res) => {
  const loaded = await loadTrip(req, res);
  if (!loaded) return;
  const { trip } = loaded;

  const entry = trip.settlements.find(s => s.id === req.params.settlementId);
  if (!entry) return res.status(404).json({ message: 'Payment not found' });

  const to = trip.members.find(m => m.id === entry.toId);
  const isRecipient = to?.userId && to.userId.toString() === req.user.id.toString();
  if (!isRecipient && !ownsTrip(trip, req)) {
    return res.status(403).json({ message: 'Only the person who was paid can undo this' });
  }

  trip.settlements = trip.settlements.filter(s => s.id !== req.params.settlementId);
  await saveAndReturn(req, res, trip);
};
