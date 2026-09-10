// Everything one user owns, removed everywhere, in one place.
//
// This exists because there are two callers — the immediate "Full Reset" endpoint
// (`authController.deleteAllData`) and the nightly grace-period purge cron in `server.js` — and
// while they were two copies of the same list they drifted twice:
//
//   * the budget scope (W1-07): the cron deleted budgets by `groupId`, which wiped every budget
//     belonging to the departing member's group, and for a solo user (`groupId: null`) matched
//     every solo user's budgets in the database;
//   * split ownership (W1-27): `deleteAllData` deleted every split the user merely *participated*
//     in, destroying records that belong to whoever paid and that the rest of the group still
//     needs to settle against.
//
// Both were the same class of bug — a delete scoped to the wrong owner — and both were only ever
// wrong in one of the two copies. A third caller is plausible (an admin tool, a GDPR request), so
// the order and the scoping live here now.

const Transaction = require("../models/Transaction");
const User        = require("../models/User");
const Goal        = require("../models/Goal");
const Split       = require("../models/Split");
const Budget      = require("../models/Budget");
const Group       = require("../models/Group");
const Account     = require("../models/Account");

/**
 * Deletes a user and every record that belongs to them alone.
 *
 * Splits are the one collection where "belongs to" is not simply `userId`: a split is owned by the
 * member who paid, and everyone else in it is a participant on someone else's record. So the user
 * is *pulled out of* splits others own, and only splits they paid for are deleted.
 *
 * @param {object} user A loaded User document (needs `_id` and `groupId`).
 */
async function purgeUser(user) {
  const userId = user._id;

  await Transaction.deleteMany({ userId });
  await Goal.deleteMany({ userId });
  await Account.deleteMany({ userId });
  // Scope by userId, never groupId — see the W1-07 note above.
  await Budget.deleteMany({ userId });

  // Two steps, and the order does not matter: a split the user both paid for and appears in is
  // deleted outright by the second call regardless of the first having emptied their entry.
  await Split.updateMany({ "splits.userId": userId }, { $pull: { splits: { userId } } });
  await Split.deleteMany({ paidBy: userId });

  if (user.groupId) {
    await Group.updateOne({ _id: user.groupId }, { $pull: { members: userId } });
  }

  await User.findByIdAndDelete(userId);
}

module.exports = { purgeUser };
