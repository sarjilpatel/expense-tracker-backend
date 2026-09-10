// Gives every existing account the personal group that signup now creates, and — the part that
// matters — adopts their orphaned rows into it.
//
//   node scripts/backfill-personal-groups.js            # write
//   node scripts/backfill-personal-groups.js --dry-run  # report only
//
// Categories live on a group, and signup used to leave `groupId` null, so a solo account had
// nowhere to keep them: /group/details answered 404 and every category screen came up empty.
// Every user owns a personal group now.
//
// The hazard this script exists to close: `buildScope` scopes a user with no group by `userId` and
// a user with one by `groupId`. Handing someone a group without moving their `groupId: null`
// transactions into it makes their whole history vanish from the app. `ensurePersonalGroup` does
// that adoption itself, so a user who logs in before this runs is repaired the same way — this is
// the same work done to everyone at once, and it is safe to run either way. Idempotent: a user who
// already owns a personal group is left alone.

require("dotenv").config();
const mongoose = require("mongoose");
const User        = require("../models/User");
const Group       = require("../models/Group");
const Transaction = require("../models/Transaction");
const Goal        = require("../models/Goal");
const { ensurePersonalGroup } = require("../utils/personalGroup");

const dryRun = process.argv.includes("--dry-run");

async function main() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is not set");

  await mongoose.connect(process.env.MONGO_URI);
  console.log(`connected${dryRun ? " (dry run — nothing will be written)" : ""}`);

  const users = await User.find({}, { _id: 1, email: 1, groupId: 1 });
  console.log(`${users.length} users`);

  let created = 0, activated = 0, adopted = 0, skipped = 0;

  for (const user of users) {
    const existing = await Group.findOne({ owner: user._id, isPersonal: true });
    if (existing) { skipped++; continue; }

    const orphanTx    = await Transaction.countDocuments({ userId: user._id, groupId: null });
    const orphanGoals = await Goal.countDocuments({ userId: user._id, groupId: null });

    if (dryRun) {
      created++;
      if (!user.groupId) activated++;
      adopted += orphanTx + orphanGoals;
      continue;
    }

    // setActive only when they have no group at all — someone already in a shared group keeps it.
    await ensurePersonalGroup(user, { setActive: !user.groupId });
    created++;
    if (!user.groupId) activated++;
    adopted += orphanTx + orphanGoals;
  }

  const verb = dryRun ? "would create" : "created";
  console.log(`${verb} ${created} personal groups (${skipped} users already had one)`);
  console.log(`${dryRun ? "would switch" : "switched"} ${activated} users into theirs`);
  console.log(`${dryRun ? "would adopt" : "adopted"} ${adopted} previously ungrouped transactions and goals`);
}

main()
  .then(() => mongoose.disconnect())
  .catch(async (err) => {
    console.error(err.message);
    await mongoose.disconnect().catch(() => {});
    process.exitCode = 1;
  });
