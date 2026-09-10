/**
 * One-off cleanup for the runaway-recurring bug (work plan W1-02).
 *
 * Before the fix, the hourly cron created each generated occurrence with `isRecurring: true` and
 * its own `nextDueDate`, so every occurrence became a template in its own right and the count
 * doubled each period. This retires the duplicates.
 *
 * Heuristic: within a (userId, amount, type, category, recurrenceFrequency) group, the OLDEST row
 * is the template the user actually created; every newer recurring row in that group is a
 * cron-generated occurrence that should never have been marked recurring. Those get
 * `isRecurring: false, recurrenceFrequency: null, nextDueDate: null`. The transactions themselves
 * are left in place — they are real spending the user has seen; only their template status is
 * cleared.
 *
 * Dry run by default. Pass --apply to write.
 *
 *   node scripts/fix-runaway-recurring.js
 *   node scripts/fix-runaway-recurring.js --apply
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');

const APPLY = process.argv.includes('--apply');

const migrate = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log(`Connected to MongoDB. Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);

        const recurring = await Transaction.find({ isRecurring: true })
            .sort({ date: 1, createdAt: 1 })
            .lean();

        console.log(`Found ${recurring.length} rows marked isRecurring.`);

        const seen = new Map();
        const toRetire = [];

        for (const tx of recurring) {
            const key = [
                tx.userId,
                tx.amount,
                tx.type,
                tx.category,
                tx.recurrenceFrequency,
            ].join('|');

            if (seen.has(key)) {
                toRetire.push(tx._id);
            } else {
                seen.set(key, tx._id);
            }
        }

        console.log(`Templates to keep:    ${seen.size}`);
        console.log(`Occurrences to retire: ${toRetire.length}`);

        if (toRetire.length === 0) {
            console.log('Nothing to do.');
            process.exit(0);
        }

        if (!APPLY) {
            console.log('\nDry run — no changes written. Re-run with --apply to commit.');
            process.exit(0);
        }

        const result = await Transaction.updateMany(
            { _id: { $in: toRetire } },
            { $set: { isRecurring: false, recurrenceFrequency: null, nextDueDate: null } }
        );

        console.log(`Retired ${result.modifiedCount} runaway occurrences.`);
        process.exit(0);
    } catch (error) {
        console.error('Migration failed:', error);
        process.exit(1);
    }
};

migrate();
