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
//     needs to settle against. Splits became trips in W2-28 and the same rule carries over — see
//     the note on the trip deletes below.
//
// Both were the same class of bug — a delete scoped to the wrong owner — and both were only ever
// wrong in one of the two copies. A third caller is plausible (an admin tool, a GDPR request), so
// the order and the scoping live here now.

const Transaction = require("../models/Transaction");
const User        = require("../models/User");
const Goal        = require("../models/Goal");
const Trip        = require("../models/Trip");
const Budget      = require("../models/Budget");
const Group       = require("../models/Group");
const Account     = require("../models/Account");

/**
 * Deletes a user and every record that belongs to them alone.
 *
 * Trips are the one collection where "belongs to" is not simply `userId`: a trip is owned by the
 * member who created it, and everyone else in it is a member of someone else's record. So the user
 * is *detached from* trips others own, and only trips they own are deleted.
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

  // Two steps, and the order does not matter: a trip the user both owns and appears in is deleted
  // outright by the second call regardless of the first having unlinked their membership.
  //
  // The first is an unlink, not a removal. A trip member carries a `name` of their own and can
  // exist with no account at all, so dropping the account only costs the link — the person stays in
  // the trip under their name, and every expense they paid for or shared keeps its payer and its
  // participants. Pulling the member out instead would silently rewrite everyone else's balances.
  await Trip.updateMany({ "members.userId": userId }, { $set: { "members.$[m].userId": null } },
                        { arrayFilters: [{ "m.userId": userId }] });
  await Trip.deleteMany({ ownerId: userId });

  if (user.groupId) {
    await Group.updateOne({ _id: user.groupId }, { $pull: { members: userId } });
  }

  await User.findByIdAndDelete(userId);
}

module.exports = { purgeUser };
