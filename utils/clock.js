let last = 0;

/**
 * `Date.now()` that never repeats within this process (W3-08). `syncedAt` is the changes feed's
 * cursor, and two rows stamped in the same millisecond would let a page cut between them —
 * `cutPage` guards that too, but a strictly increasing stamp makes it a guard rather than the
 * mechanism. Across processes a collision is possible and harmless: the row is sent twice, and
 * applying it twice is a no-op.
 */
function monotonicNow() {
  const now = Date.now();
  last = now > last ? now : last + 1;
  return new Date(last);
}

module.exports = { monotonicNow };
