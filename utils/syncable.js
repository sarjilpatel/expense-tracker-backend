/**
 * The three fields every synced collection carries (W3-05/06), as a Mongoose plugin:
 *
 *   clientId   the id the device made the row under; a push upserts by it, so a retried batch
 *              cannot duplicate a row. Older rows have none — `toClientId` in utils/sync.js falls
 *              back to `_id`, and a push may address a row by its `_id` for the same reason.
 *   updatedAt  the *client's* time of the last edit — the last-writer-wins clock. A server-side
 *              edit sets it to now; a push keeps the value the device sent.
 *   syncedAt   the *server's* time the row last changed — what the changes feed pages on. Two
 *              clocks on purpose: a device with a slow clock pushes a row whose `updatedAt` is in
 *              the past, and if the feed paged on that, every other device would skip it.
 *   deletedAt  the tombstone. Nothing is ever removed until every device has heard it is gone
 *              (the 00:05 cron hard-deletes tombstones older than 30 days).
 *
 * `ownerKey` names the field that scopes uniqueness of `clientId` — `userId` for most, `ownerId`
 * for trips.
 */
function syncable(schema, { ownerKey = 'userId' } = {}) {
  schema.add({
    clientId:  { type: String, default: undefined, trim: true, maxlength: 64 },
    updatedAt: { type: Date, default: Date.now },
    syncedAt:  { type: Date, default: Date.now },
  });
  if (!schema.path('deletedAt')) schema.add({ deletedAt: { type: Date, default: null } });

  schema.index({ [ownerKey]: 1, clientId: 1 }, { unique: true, partialFilterExpression: { clientId: { $type: 'string' } } });
  schema.index({ syncedAt: 1 });

  schema.pre('save', async function () {
    const now = new Date();
    if (this.isNew || this.isModified()) {
      if (!this.isModified('updatedAt')) this.updatedAt = now;
      this.syncedAt = now;
    }
  });

  // Update queries: bump both clocks unless the caller set `updatedAt` itself (a push does —
  // that is the device's edit time and must survive).
  schema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne'], async function () {
    const update = this.getUpdate() || {};
    const set = update.$set || (update.$set = {});
    const now = new Date();
    const touchesUpdatedAt = 'updatedAt' in set || 'updatedAt' in update;
    if (!touchesUpdatedAt) set.updatedAt = now;
    set.syncedAt = now;
    this.setUpdate(update);
  });
}

module.exports = { syncable };
