// Extracted from transactionController so it can be tested directly. This filter is the whole of
// the app's read-privacy model — six call sites depend on it, and W1-08 was a bug where one of
// them replaced it rather than extending it — so it is worth pinning in isolation.

/**
 * A Mongoose filter limited to what `user` is allowed to see.
 *
 * Group members see everything in the group except other members' private rows; a solo user sees
 * only their own. Soft-deleted rows are excluded either way — `deleteTransaction` sets `deletedAt`
 * rather than removing the document.
 *
 * Anything narrowing this further must **spread** it, never replace it.
 */
function buildScope(user) {
  if (user.groupId) {
    return {
      groupId: user.groupId,
      deletedAt: null,
      $or: [{ isPrivate: { $ne: true } }, { userId: user._id }],
    };
  }
  return { userId: user._id, deletedAt: null };
}

module.exports = { buildScope };
