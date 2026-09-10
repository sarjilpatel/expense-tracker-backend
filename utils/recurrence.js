// Single source of truth for recurrence scheduling. The same "when is this next due" maths was
// previously written out in both server.js (the hourly cron) and transactionController.addTransaction,
// and the two copies had already drifted — the cron's version returned the base date unchanged for
// an unrecognised frequency, which made the transaction regenerate every hour forever.
//
// The arithmetic runs in the *user's* calendar, not the server's. `User.timezone` is captured at
// signup from the device and was stored and never read; this is what it is for. It matters because
// "monthly" means "the same day next month where the user lives", and doing that in server-local
// time both slips the day across a timezone boundary and overflows short months — a monthly
// transaction on Jan 31 used to land on Mar 3, skipping February entirely, and then stay on the 3rd
// forever.

const VALID_FREQUENCIES = new Set(['daily', 'weekly', 'monthly']);

// Both caches are keyed by timezone string and are effectively bounded by the number of distinct
// IANA zones. Constructing an Intl.DateTimeFormat is expensive and the cron would otherwise build
// one per due transaction.
const formatterCache = new Map();
const zoneValidCache = new Map();

/** Users can store anything in `timezone` (Joi only bounds its length), and an unknown zone makes
 *  Intl throw. Anything unrecognised falls back to UTC — the previous behaviour. */
function resolveZone(timeZone) {
    if (!timeZone) return 'UTC';
    if (zoneValidCache.has(timeZone)) return zoneValidCache.get(timeZone) ? timeZone : 'UTC';
    let ok = true;
    try { new Intl.DateTimeFormat('en-US', { timeZone }); } catch { ok = false; }
    zoneValidCache.set(timeZone, ok);
    return ok ? timeZone : 'UTC';
}

function formatterFor(timeZone) {
    let fmt = formatterCache.get(timeZone);
    if (!fmt) {
        fmt = new Intl.DateTimeFormat('en-US', {
            timeZone, hour12: false,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
        });
        formatterCache.set(timeZone, fmt);
    }
    return fmt;
}

/** The wall-clock the user would read off a clock in `timeZone` at instant `date`. */
function partsIn(date, timeZone) {
    const out = {};
    for (const p of formatterFor(timeZone).formatToParts(date)) {
        if (p.type !== 'literal') out[p.type] = Number(p.value);
    }
    // Some ICU builds render midnight as hour 24 rather than 0.
    if (out.hour === 24) out.hour = 0;
    return out;
}

/** Offset of `timeZone` from UTC, in ms, at instant `date`. */
function offsetMsAt(date, timeZone) {
    const p = partsIn(date, timeZone);
    const asIfUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    // The formatter drops milliseconds, so compare against a truncated instant.
    return asIfUTC - (date.getTime() - date.getMilliseconds());
}

/**
 * The instant at which `timeZone` reads the given wall-clock.
 *
 * Two DST edge cases have to be handled, and they pull in opposite directions:
 *  - **Gap** (spring forward): the wall-clock does not exist. 02:30 on the US spring-forward day
 *    is simply skipped. The convention — and what a user means by "same time tomorrow" — is to
 *    shift forward past the gap, giving 03:30.
 *  - **Fold** (fall back): the wall-clock happens twice. Take the first one.
 */
function instantFromParts(p, timeZone) {
    const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);

    // First guess reads the offset in force at the wall-clock interpreted as a UTC instant.
    const first  = wall - offsetMsAt(new Date(wall), timeZone);
    // Second pass re-reads the offset at that guess, which corrects the ordinary case where a
    // transition falls between the two. In a fold it converges on the earlier occurrence.
    const second = wall - offsetMsAt(new Date(first), timeZone);

    // If the second pass round-trips back to the wall-clock we asked for, it is right. If it does
    // not, no instant maps to that wall-clock — we are in a gap, and the first guess is the one
    // that lands just after it.
    const check = partsIn(new Date(second), timeZone);
    const roundTrips = check.year === p.year && check.month === p.month && check.day === p.day
        && check.hour === p.hour && check.minute === p.minute && check.second === p.second;

    return new Date(roundTrips ? second : first);
}

/** Days in a 1-indexed month. */
function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Next due date after `from` for the given frequency.
 * Returns null for an unrecognised or missing frequency — callers must treat that as
 * "not recurring" rather than scheduling it for now.
 *
 * @param {Date|string|number} from
 * @param {string} frequency  daily | weekly | monthly
 * @param {object} [opts]
 * @param {string} [opts.timeZone]  IANA zone, e.g. the owner's `User.timezone`. Defaults to UTC.
 * @param {number} [opts.anchorDay] Day-of-month the series is really pinned to, for `monthly`.
 *   Without it a series on the 31st degrades permanently the first time it clamps to a short
 *   month: Jan 31 -> Feb 28 -> Mar 28. Pass the template's own start day and it recovers to the
 *   31st in every month long enough to have one.
 */
function computeNextDueDate(from, frequency, opts = {}) {
    if (!VALID_FREQUENCIES.has(frequency)) return null;

    const zone  = resolveZone(opts.timeZone);
    const base  = new Date(from);
    if (isNaN(base.getTime())) return null;
    const p     = partsIn(base, zone);

    if (frequency === 'monthly') {
        let year  = p.year;
        let month = p.month + 1;
        if (month > 12) { month = 1; year += 1; }
        const wanted = opts.anchorDay > 0 ? Math.min(opts.anchorDay, 31) : p.day;
        return instantFromParts(
            { ...p, year, month, day: Math.min(wanted, daysInMonth(year, month)) },
            zone
        );
    }

    // Advance whole days in the user's calendar rather than adding a fixed 24h: across a DST
    // change it is the local time-of-day the user expects to stay put.
    const step    = frequency === 'daily' ? 1 : 7;
    const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day + step));
    return instantFromParts({
        year:   shifted.getUTCFullYear(),
        month:  shifted.getUTCMonth() + 1,
        day:    shifted.getUTCDate(),
        hour:   p.hour,
        minute: p.minute,
        second: p.second,
    }, zone);
}

/** Day-of-month `date` falls on in `timeZone` — the anchor for a monthly series. */
function localDayOfMonth(date, timeZone) {
    return partsIn(new Date(date), resolveZone(timeZone)).day;
}

/**
 * Whether the string names a zone this runtime knows. Exported because `User.timezone` is written
 * from the device (W1-30) and everything downstream silently falls back to UTC on a bad value —
 * which is the right behaviour when reading, and the wrong one when storing: it would leave a
 * user's recurring transactions firing in the wrong day forever with nothing to show why.
 */
function isValidTimeZone(timeZone) {
    return typeof timeZone === 'string' && timeZone.length > 0 && resolveZone(timeZone) === timeZone;
}

module.exports = { computeNextDueDate, localDayOfMonth, isValidTimeZone, VALID_FREQUENCIES };
