/** The categories a group still has — a removed one stays in the array as a tombstone (W3-05). */
function activeCategories(group) {
  return (group?.categories || []).filter((c) => !c.deletedAt);
}

module.exports = { activeCategories };
