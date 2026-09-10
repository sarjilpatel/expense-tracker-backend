/**
 * One-off migration for the Joi-validation fix (work plan W1-10).
 *
 * `middleware/validate.js` used to throw away Joi's converted value, so `.lowercase()` on the
 * email schemas was a no-op and addresses were stored with whatever case the user typed. Now that
 * the converted value is used, every lookup goes out lowercased — which would make an existing
 * user whose stored address has any uppercase in it unable to log in. This lowercases them.
 *
 * Collisions (two accounts differing only in case) are NOT merged: merging would have to decide
 * which transactions, group and settings survive. They are reported and skipped so a human can
 * deal with them.
 *
 * Dry run by default. Pass --apply to write.
 *
 *   node scripts/normalize-user-emails.js
 *   node scripts/normalize-user-emails.js --apply
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

const APPLY = process.argv.includes('--apply');

const migrate = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log(`Connected to MongoDB. Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);

        const users = await User.find({}, { email: 1, createdAt: 1 }).lean();
        const needsChange = users.filter(u => u.email && u.email !== u.email.trim().toLowerCase());

        console.log(`Users total:            ${users.length}`);
        console.log(`Needing normalisation:  ${needsChange.length}`);

        if (needsChange.length === 0) {
            console.log('Nothing to do.');
            process.exit(0);
        }

        // Group by the target address so we can spot two accounts collapsing into one.
        const byTarget = new Map();
        for (const u of users) {
            if (!u.email) continue;
            const key = u.email.trim().toLowerCase();
            if (!byTarget.has(key)) byTarget.set(key, []);
            byTarget.get(key).push(u);
        }

        const collisions = [...byTarget.entries()].filter(([, list]) => list.length > 1);
        const blocked = new Set();
        if (collisions.length > 0) {
            console.log(`\n!! ${collisions.length} collision(s) — these are SKIPPED, resolve by hand:`);
            for (const [target, list] of collisions) {
                console.log(`   ${target}`);
                for (const u of list) {
                    console.log(`     - ${u._id}  ${u.email}  created ${u.createdAt || 'unknown'}`);
                    blocked.add(u._id.toString());
                }
            }
        }

        const safe = needsChange.filter(u => !blocked.has(u._id.toString()));
        console.log(`\nSafe to normalise:      ${safe.length}`);
        for (const u of safe.slice(0, 20)) {
            console.log(`   ${u.email}  ->  ${u.email.trim().toLowerCase()}`);
        }
        if (safe.length > 20) console.log(`   ... and ${safe.length - 20} more`);

        if (!APPLY) {
            console.log('\nDry run — no changes written. Re-run with --apply to commit.');
            process.exit(0);
        }

        let updated = 0;
        for (const u of safe) {
            // updateOne with an explicit value: schema setters do not run on query filters, and
            // we want the write to be exactly what we printed above.
            await User.updateOne({ _id: u._id }, { $set: { email: u.email.trim().toLowerCase() } });
            updated++;
        }

        console.log(`\nNormalised ${updated} email(s).`);
        if (collisions.length > 0) {
            console.log(`${collisions.length} collision(s) left untouched — see the list above.`);
        }
        process.exit(0);
    } catch (error) {
        console.error('Migration failed:', error);
        process.exit(1);
    }
};

migrate();
