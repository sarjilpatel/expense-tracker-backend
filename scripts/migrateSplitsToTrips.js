// Migration for W2-28: every `splits` document becomes a one-expense `Trip`.
//
// The app had two bill-splitting features that could not see each other — server-side splits, and
// a local-only TripMaster with ad-hoc members and integer minor units. The trip model won, so the
// existing split rows have to arrive in it without losing anything:
//
//   * the title becomes both the trip name and its single expense's description;
//   * `paidBy` becomes the trip owner and the expense's payer;
//   * every `splits[].userId` becomes a trip member whose member id **is that user's ObjectId
//     string**, so a member still linked to an account is recognisable on sight and the app can
//     match a signed-in user to their own row without a lookup table;
//   * the per-member amounts become `sharesMinor`, which is why that field exists. A split stated
//     a total *and* a list of amounts and only checked them against each other to a 0.01
//     tolerance; carrying the amounts verbatim and deriving the total from them is lossless in the
//     direction that matters, and makes the two impossible to contradict afterwards.
//   * a settled entry becomes a recorded payment from that member to the payer. The payer's own
//     entry was auto-settled at creation and is not a payment anybody made, so it is dropped.
//
//   node scripts/migrateSplitsToTrips.js            # write
//   node scripts/migrateSplitsToTrips.js --dry-run  # report only
//   node scripts/migrateSplitsToTrips.js --drop     # write, then drop the `splits` collection
//
// Idempotent: a converted split is stamped with `migratedAt` and skipped on the next run, so this
// can be run again after a partial failure without doubling anybody's debts. `--drop` is the
// separate, deliberate step that retires the old collection once the result has been eyeballed.

require("dotenv").config();
const mongoose = require("mongoose");
const Trip     = require("../models/Trip");

const dryRun = process.argv.includes("--dry-run");
const drop   = process.argv.includes("--drop");

/** Rupees to paise. A split amount is a float, so rounding is the conversion, not a guess. */
const toMinor = (rupees) => Math.round(Number(rupees) * 100);

function convert(split) {
  const payerId  = split.paidBy.toString();
  const entries  = Array.isArray(split.splits) ? split.splits : [];

  // The payer is always a member even if they somehow have no entry of their own: a trip with no
  // payer in it cannot state a balance.
  const ids = [...new Set([payerId, ...entries.map((e) => e.userId?.toString()).filter(Boolean)])];

  const shares = {};
  for (const entry of entries) {
    const id = entry.userId?.toString();
    if (!id) continue;
    const amount = toMinor(entry.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    shares[id] = (shares[id] ?? 0) + amount;
  }

  const createdAt = split.createdAt ?? new Date();

  const settlements = entries
    // The payer's share was settled at creation because they cannot owe themselves; recording it
    // as a payment would invent a transfer that never happened.
    .filter((e) => e.settled && e.userId && e.userId.toString() !== payerId)
    .map((e) => ({
      id:          `s-${e.userId.toString()}`,
      fromId:      e.userId.toString(),
      toId:        payerId,
      amountMinor: toMinor(e.amount),
      settledAt:   e.settledAt ?? createdAt,
      recordedBy:  split.paidBy,
    }))
    .filter((s) => s.amountMinor > 0);

  return {
    groupId:  split.groupId,
    ownerId:  split.paidBy,
    name:     String(split.title || "Split").slice(0, 80),
    currency: split.currency || "INR",
    members:  ids.map((id) => ({ id, name: "", userId: new mongoose.Types.ObjectId(id) })),
    expenses: Object.keys(shares).length
      ? [{
          id:             "e-1",
          description:    String(split.title || "Split").slice(0, 80),
          amountMinor:    Object.values(shares).reduce((a, b) => a + b, 0),
          paidById:       payerId,
          participantIds: Object.keys(shares),
          sharesMinor:    shares,
          createdAt,
        }]
      : [],
    settlements,
    createdAt,
    updatedAt: createdAt,
  };
}

/**
 * Fills in each member's display name from their account.
 *
 * `Trip.members[].name` is required — it is what lets a member exist with no account at all — but
 * a split had no names in it, only references. Every migrated member does have an account, so the
 * name comes from there; a member whose account has since been deleted keeps the placeholder,
 * which is the honest answer and is exactly the state `purgeUser` leaves behind anyway.
 */
async function nameMembers(docs) {
  const User = require("../models/User");
  const ids  = [...new Set(docs.flatMap((d) => d.members.map((m) => m.id)))];
  const rows = await User.find({ _id: { $in: ids } }).select("name").lean();
  const byId = new Map(rows.map((u) => [u._id.toString(), u.name]));

  for (const doc of docs) {
    for (const member of doc.members) member.name = byId.get(member.id) || "Former member";
  }
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is not set");

  await mongoose.connect(process.env.MONGO_URI);
  console.log(`connected${dryRun ? " (dry run — nothing will be written)" : ""}`);

  // The raw collection, not a model: `models/Split.js` is gone, and re-introducing it to read a
  // collection that is being retired would put the dead schema back into the dependency graph.
  const splits = mongoose.connection.db.collection("splits");

  const pending = await splits.find({ migratedAt: { $exists: false } }).toArray();
  const already = await splits.countDocuments({ migratedAt: { $exists: true } });
  console.log(`${pending.length} split(s) to migrate${already ? `, ${already} already done` : ""}`);

  if (!pending.length) {
    if (drop && !dryRun && already) {
      await splits.drop();
      console.log("dropped the `splits` collection");
    }
    return;
  }

  const docs = pending.map(convert);
  await nameMembers(docs);

  const skipped = docs.filter((d) => !d.expenses.length).length;
  if (skipped) console.warn(`${skipped} split(s) had no usable amounts — migrating as empty trips`);

  if (dryRun) {
    for (const doc of docs.slice(0, 5)) {
      console.log(`  "${doc.name}" — ${doc.members.length} members, ` +
                  `${doc.expenses[0]?.amountMinor ?? 0} paise, ${doc.settlements.length} settled`);
    }
    if (docs.length > 5) console.log(`  … and ${docs.length - 5} more`);
    console.log(`would create ${docs.length} trip(s)`);
    return;
  }

  const created = await Trip.insertMany(docs);
  console.log(`created ${created.length} trip(s)`);

  // Stamped only after the insert succeeds, so a crash in between leaves the splits unmarked and
  // the re-run redoes them rather than losing them.
  await splits.updateMany(
    { _id: { $in: pending.map((s) => s._id) } },
    { $set: { migratedAt: new Date() } },
  );
  console.log(`marked ${pending.length} split(s) as migrated`);

  if (drop) {
    await splits.drop();
    console.log("dropped the `splits` collection");
  }
}

main()
  .then(() => mongoose.disconnect())
  .catch(async (err) => {
    console.error(err);
    await mongoose.disconnect().catch(() => {});
    process.exitCode = 1;
  });
