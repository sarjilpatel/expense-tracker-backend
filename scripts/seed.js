// Seed data for manual testing. Not used by `npm test` — the node:test suites build their own
// fixtures through tests/helpers/stubs.js — this one fills a real database so the app can be
// driven by hand against it.
//
//   npm run seed                    # rebuild the seed accounts
//   npm run seed -- --months=12     # more history (default 6)
//   npm run seed -- --wipe --yes    # empty every app collection first, then seed
//
// Every account it creates is @seed.local, and a run deletes what the previous run left before it
// inserts, so re-running lands on the same known state rather than piling up duplicates. Nothing
// outside that domain is touched unless --wipe is passed, which is why --wipe also demands --yes.
//
// Amounts and dates come from a fixed PRNG seed: two runs produce identical data, so a bug that
// only shows on one row is still there after a re-seed.

require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt   = require("bcryptjs");

const User        = require("../models/User");
const Group       = require("../models/Group");
const Account     = require("../models/Account");
const Transaction = require("../models/Transaction");
const Budget      = require("../models/Budget");
const Goal        = require("../models/Goal");
const Trip        = require("../models/Trip");
const Otp         = require("../models/Otp");
const RateLimit   = require("../models/RateLimit");

const { encryptField, noteTokens, isEncryptionEnabled } = require("../utils/fieldCrypto");
const { computeNextDueDate, localDayOfMonth }           = require("../utils/recurrence");
const { ensurePersonalGroup }                           = require("../utils/personalGroup");

// Not a .local / .test address: Joi validates the login body with `.email()`, which checks the
// TLD against the IANA list, so an account on a made-up TLD cannot log in through the app at
// all. example.com is reserved by RFC 2606 and has a real TLD, so it passes and goes nowhere.
const DOMAIN   = "seed.example.com";
const PASSWORD = "Test@1234";
const TIMEZONE = "Asia/Kolkata";
const JOINCODE = "5EED01";        // same shape as generateUniqueJoinCode's output: 6 hex chars

const DOMAIN_RE     = DOMAIN.replace(/\./g, "\\.");
const SEED_EMAIL_RE = new RegExp("@" + DOMAIN_RE + "$");

const args   = process.argv.slice(2);
const wipe   = args.includes("--wipe");
const yes    = args.includes("--yes");
const months = Number((args.find(a => a.startsWith("--months=")) || "").split("=")[1]) || 6;

// ── deterministic randomness ────────────────────────────────────────────────
// mulberry32. Math.random would make every run a different dataset, and "re-seed and try again"
// has to reproduce what you were looking at.
let prng = 0x9e3779b9;
function rnd() {
  prng |= 0; prng = (prng + 0x6D2B79F5) | 0;
  let t = Math.imul(prng ^ (prng >>> 15), 1 | prng);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick  = (arr)      => arr[Math.floor(rnd() * arr.length)];
const money = (min, max) => Math.round((min + rnd() * (max - min)) * 100) / 100;
const int   = (min, max) => min + Math.floor(rnd() * (max - min + 1));

// ── content pools ───────────────────────────────────────────────────────────
// Notes are worth caring about: they are the only thing the blind index (W1-28) can be tested
// against, and it matches whole words only. The words that repeat below — coffee, uber, grocery —
// are the search terms to try in the app.
const EXPENSE_NOTES = {
  Food:          ["morning coffee run", "team lunch", "pizza night", "coffee and croissant", "dinner with friends"],
  Groceries:     ["weekly grocery run", "grocery top up", "vegetables and fruit", "grocery and household"],
  Transport:     ["uber to airport", "uber home", "monthly metro pass", "petrol top up", "auto fare"],
  Shopping:      ["running shoes", "winter jacket", "phone case", "headphones"],
  Rent:          ["monthly rent", "rent and maintenance"],
  Entertainment: ["cinema tickets", "concert tickets", "streaming subscription", "board game night"],
  Other:         ["misc expense", "pharmacy", "haircut", "gift for mom"],
};
const INCOME_NOTES = {
  Salary:     ["monthly salary", "salary credit"],
  Freelance:  ["freelance invoice paid", "design work invoice"],
  Business:   ["client payment", "consulting fee"],
  Investment: ["dividend payout", "interest credit"],
  Gift:       ["birthday gift", "festival gift"],
};
const EXPENSE_CATEGORIES = Object.keys(EXPENSE_NOTES);

// Added on top of the Group model's own defaults. A group member's rows are validated against the
// group's category names in addTransaction, so the pools above must stay a subset of the two lists.
const EXTRA_CATEGORIES = [
  { name: "Groceries", icon: "basket", type: "expense" },
  { name: "Freelance", icon: "laptop", type: "income"  },
];

// ── helpers ─────────────────────────────────────────────────────────────────
// Notes go through the same encrypt + index pair every write site in the controller uses; a row
// inserted with a note and no tokens is invisible to search, which is exactly the bug W1-28 fixed.
function tx(fields) {
  const noteRaw = fields.note;
  return {
    ...fields,
    note:       noteRaw ? encryptField(noteRaw) : undefined,
    noteTokens: noteTokens(noteRaw),
  };
}

function monthStart(offset) {
  const d = new Date();
  d.setMonth(d.getMonth() - offset, 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

function dayIn(base, day, hour) {
  const d = new Date(base);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  d.setHours(hour, int(0, 59), 0, 0);
  return d;
}

// ── teardown ────────────────────────────────────────────────────────────────
async function clearSeed() {
  const users   = await User.find({ email: SEED_EMAIL_RE }).lean();
  const userIds = users.map(u => u._id);
  const owned   = await Group.find({ $or: [{ owner: { $in: userIds } }, { joinCode: JOINCODE }] }).lean();
  const groupIds = [...new Set([
    ...users.map(u => u.groupId).filter(Boolean).map(String),
    ...owned.map(g => String(g._id)),
  ])].map(id => new mongoose.Types.ObjectId(id));

  if (!userIds.length && !groupIds.length) return { users: 0 };

  const [txs, budgets, goals, trips, accounts] = await Promise.all([
    Transaction.deleteMany({ userId: { $in: userIds } }),
    Budget.deleteMany({ userId: { $in: userIds } }),
    Goal.deleteMany({ userId: { $in: userIds } }),
    Trip.deleteMany({ groupId: { $in: groupIds } }),
    Account.deleteMany({ userId: { $in: userIds } }),
  ]);
  await Group.deleteMany({ _id: { $in: groupIds } });
  // Codes and send counters keyed to the seed addresses too, so a re-seed does not leave the
  // signup screen sitting on a one-per-60s resend cooldown left over from the last run.
  await Otp.deleteMany({ email: SEED_EMAIL_RE });
  await RateLimit.deleteMany({ key: new RegExp(DOMAIN_RE) });
  await User.deleteMany({ _id: { $in: userIds } });

  return {
    users: userIds.length, groups: groupIds.length,
    transactions: txs.deletedCount, budgets: budgets.deletedCount,
    goals: goals.deletedCount, trips: trips.deletedCount, accounts: accounts.deletedCount,
  };
}

async function wipeEverything() {
  for (const M of [Transaction, Budget, Goal, Trip, Account, Group, User, Otp, RateLimit]) {
    await M.deleteMany({});
  }
}

// ── build ───────────────────────────────────────────────────────────────────
async function seed() {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const base = { password: hash, isEmailVerified: true, timezone: TIMEZONE, aiConsentGiven: true };

  // isEmailVerified is set directly: signup writes nothing until the emailed code is entered
  // (W1-32), so there is no unverified row to seed and no mail to intercept.
  const [alice, bob, carol, dave] = await User.create([
    { ...base, name: "Alice Seed", email: "alice@" + DOMAIN },
    { ...base, name: "Bob Seed",   email: "bob@"   + DOMAIN },
    { ...base, name: "Carol Seed", email: "carol@" + DOMAIN },
    { ...base, name: "Dave Seed",  email: "dave@"  + DOMAIN },
  ]);

  // Every account owns a personal group — it is where categories live when you are not sharing
  // with anyone. Alice and Bob get one too; theirs just is not the group they are active in.
  const personal = {};
  for (const u of [alice, bob, carol, dave]) personal[u.email] = await ensurePersonalGroup(u);

  // Created without `categories` so the Group model's defaults apply — spelling them out here
  // would be a second copy of that list to keep in sync.
  const group = await Group.create({
    name:           "Seed Household",
    joinCode:       JOINCODE,
    owner:          alice._id,
    members:        [alice._id, bob._id],
    pendingMembers: [{ userId: dave._id }],   // Dave is the approve/reject case on manage-group
  });
  group.categories.push(...EXTRA_CATEGORIES);
  await group.save();

  // Alice and Bob are active in the shared group; Carol and Dave stay in their personal one.
  await User.updateMany({ _id: { $in: [alice._id, bob._id] } }, { groupId: group._id });
  alice.groupId = group._id;
  bob.groupId   = group._id;

  const accounts = await Account.create([
    { userId: alice._id, name: "Cash",         type: "cash",        openingBalance:   5000, icon: "wallet-outline",         color: "#10B981" },
    { userId: alice._id, name: "HDFC Bank",    type: "bank",        openingBalance:  82000, icon: "business-outline",       color: "#3B82F6" },
    { userId: alice._id, name: "ICICI Credit", type: "credit_card", openingBalance: -12400, icon: "card-outline",           color: "#EF4444" },
    { userId: bob._id,   name: "Cash",         type: "cash",        openingBalance:   2500, icon: "wallet-outline",         color: "#10B981" },
    { userId: bob._id,   name: "SBI Savings",  type: "savings",     openingBalance:  46000, icon: "business-outline",       color: "#6366F1" },
    { userId: carol._id, name: "Cash",         type: "cash",        openingBalance:   1800, icon: "wallet-outline",         color: "#10B981" },
    { userId: carol._id, name: "Paytm Wallet", type: "wallet",      openingBalance:   3200, icon: "phone-portrait-outline", color: "#F59E0B" },
  ]);
  const accountsFor = (user) => accounts.filter(a => String(a.userId) === String(user._id));

  // ── transactions ──────────────────────────────────────────────────────────
  const rows   = [];
  const people = [
    { user: alice, salary: 95000, spend: [10, 16] },
    { user: bob,   salary: 62000, spend: [7, 12]  },
    { user: carol, salary: 48000, spend: [5, 9]   },   // solo — no group, no shared rows
  ];

  for (const { user, salary, spend } of people) {
    const own = accountsFor(user);
    for (let m = months - 1; m >= 0; m--) {
      const start = monthStart(m);

      rows.push(tx({
        amount: salary, type: "income", category: "Salary", note: pick(INCOME_NOTES.Salary),
        userId: user._id, groupId: user.groupId,
        date: dayIn(start, 1, 10), accountId: (own[1] || own[0])._id, currency: "INR",
      }));

      // A second income stream every third month, so the income breakdown is not one flat bar.
      if (m % 3 === 0) {
        const category = String(user.groupId) === String(group._id) ? "Freelance" : "Business";
        rows.push(tx({
          amount: money(8000, 24000), type: "income", category, note: pick(INCOME_NOTES[category]),
          userId: user._id, groupId: user.groupId,
          date: dayIn(start, int(8, 22), 15), accountId: (own[1] || own[0])._id, currency: "INR",
        }));
      }

      const count = int(spend[0], spend[1]);
      for (let i = 0; i < count; i++) {
        // Groceries is a custom category on the shared group only — a personal group has just the
        // model defaults, and addTransaction validates a row against its own group's list.
        const inShared = String(user.groupId) === String(group._id);
        const category = pick(EXPENSE_CATEGORIES.filter(c => inShared || c !== "Groceries"));
        const amount   = category === "Rent" ? money(18000, 22000) : money(120, 4200);
        rows.push(tx({
          amount, type: "expense", category, note: pick(EXPENSE_NOTES[category]),
          userId: user._id, groupId: user.groupId,
          date: dayIn(start, int(1, 28), int(8, 21)),
          accountId: pick(own)._id,
          // A private row only means something in a shared group — it is what buildScope hides
          // from the other members — so nobody in a personal group gets one.
          isPrivate: inShared && rnd() < 0.12,
          currency:  rnd() < 0.05 ? "USD" : "INR",
        }));
      }

      // Two soft-deleted rows per user. They have to stay out of every list, every total and the
      // recurring cron, and nothing exercises that if none are ever seeded.
      if (m === 0 || m === 1) {
        rows.push(tx({
          amount: money(300, 1500), type: "expense", category: "Other", note: "deleted test row",
          userId: user._id, groupId: user.groupId,
          date: dayIn(start, int(2, 20), 12), accountId: own[0]._id,
          deletedAt: new Date(),
        }));
      }
    }
  }

  // ── recurring templates ───────────────────────────────────────────────────
  // nextDueDate is computed the way addTransaction does it, in the owner's zone. The first is
  // backdated so the hourly cron picks it up on its very next tick — otherwise testing recurrence
  // means waiting for a real month to pass.
  const recurring = [
    { user: alice, amount: 21000, category: "Rent",          note: "monthly rent",           frequency: "monthly", dueAt: new Date(Date.now() - 5 * 60 * 1000) },
    { user: alice, amount:   649, category: "Entertainment", note: "streaming subscription", frequency: "monthly", from: monthStart(0) },
    { user: bob,   amount:  2400, category: "Groceries",     note: "weekly grocery run",     frequency: "weekly"  },
    { user: carol, amount:   180, category: "Food",          note: "morning coffee run",     frequency: "daily"   },
  ];
  for (const r of recurring) {
    const from        = r.from || new Date();
    const nextDueDate = r.dueAt || computeNextDueDate(from, r.frequency, {
      timeZone:  TIMEZONE,
      anchorDay: localDayOfMonth(from, TIMEZONE),
    });
    rows.push(tx({
      amount: r.amount, type: "expense", category: r.category, note: r.note,
      userId: r.user._id, groupId: r.user.groupId,
      date: from, accountId: accountsFor(r.user)[0]._id, currency: "INR",
      isRecurring: true, recurrenceFrequency: r.frequency, nextDueDate,
    }));
  }

  await Transaction.insertMany(rows);

  // ── budgets ───────────────────────────────────────────────────────────────
  // Per-user, never group-scoped: getBudgets filters on userId alone, and W1-07 was a purge that
  // assumed otherwise.
  const now       = new Date();
  const prev      = monthStart(1);
  const thisMonth = { month: now.getMonth()  + 1, year: now.getFullYear()  };
  const lastMonth = { month: prev.getMonth() + 1, year: prev.getFullYear() };

  await Budget.create([
    { userId: alice._id, amount: 60000, ...thisMonth, category: null },
    { userId: alice._id, amount: 12000, ...thisMonth, category: "Food" },
    { userId: alice._id, amount:  6000, ...thisMonth, category: "Transport" },
    { userId: alice._id, amount:   900, ...thisMonth, category: "Entertainment" }, // deliberately blown
    { userId: alice._id, amount: 58000, ...lastMonth, category: null },
    { userId: bob._id,   amount: 35000, ...thisMonth, category: null },
    { userId: bob._id,   amount:  9000, ...thisMonth, category: "Groceries" },
    { userId: carol._id, amount: 28000, ...thisMonth, category: null },
  ]);

  // ── goals ─────────────────────────────────────────────────────────────────
  // Group-scoped server-side, which is why they have no guest implementation and dataService
  // refuses them with GuestUnsupportedError.
  await Goal.create([
    { userId: alice._id, groupId: group._id, name: "Japan trip",     targetAmount: 250000, savedAmount:  92000, deadline: new Date(now.getFullYear() + 1, 2, 1),               icon: "airplane-outline", color: "#6366F1" },
    { userId: alice._id, groupId: group._id, name: "Emergency fund", targetAmount: 300000, savedAmount: 285000, deadline: null,                                                icon: "shield-outline",   color: "#10B981" },
    { userId: bob._id,   groupId: group._id, name: "New laptop",     targetAmount: 120000, savedAmount: 120000, deadline: new Date(now.getFullYear(), now.getMonth() + 2, 15), icon: "laptop-outline",   color: "#F59E0B" },
    { userId: carol._id, groupId: personal[carol.email]._id, name: "Camera", targetAmount: 85000, savedAmount: 15000, deadline: null,                          icon: "camera-outline",   color: "#EC4899" },
  ]);

  // ── trips ─────────────────────────────────────────────────────────────────
  // One trip covering every shape the settlement screen has to render: an even split across
  // everyone, one across a subset, an uneven one carrying explicit `sharesMinor`, and a payment
  // already recorded so a cleared balance is on screen too. Priya has no account — the ad-hoc
  // member is the whole reason this model replaced splits, so the seed has to exercise it.
  //
  // Ids are fixed strings rather than UUIDs: re-seeding reproduces the same rows, which is the
  // point of the fixed PRNG seed everywhere else in this script.
  await Trip.create({
    groupId: group._id, ownerId: alice._id, name: "Goa weekend", currency: "INR",
    members: [
      { id: "m-alice", name: "Alice", userId: alice._id },
      { id: "m-bob",   name: "Bob",   userId: bob._id },
      { id: "m-priya", name: "Priya", userId: null },
    ],
    expenses: [
      { id: "e-dinner", description: "Dinner at Toit", amountMinor: 360000, paidById: "m-alice",
        participantIds: ["m-alice", "m-bob", "m-priya"], createdAt: dayIn(monthStart(0), 4, 20) },
      { id: "e-grocery", description: "Weekend groceries", amountMinor: 520000, paidById: "m-bob",
        participantIds: ["m-alice", "m-bob"], createdAt: dayIn(monthStart(0), 9, 11) },
      // Uneven: Priya took the long leg on her own, so the shares are stated rather than derived.
      { id: "e-cab", description: "Airport cab", amountMinor: 140000, paidById: "m-alice",
        participantIds: ["m-alice", "m-bob", "m-priya"],
        sharesMinor: { "m-alice": 40000, "m-bob": 40000, "m-priya": 60000 },
        createdAt: dayIn(monthStart(1), 18, 6) },
    ],
    settlements: [
      { id: "s-bob-alice", fromId: "m-bob", toId: "m-alice", amountMinor: 100000,
        settledAt: dayIn(monthStart(0), 12, 9), recordedBy: alice._id },
    ],
    createdAt: dayIn(monthStart(1), 18, 5),
  });

  return { group, transactions: rows.length, accounts: accounts.length, dave };
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is not set");
  if (wipe && !yes) {
    throw new Error("--wipe deletes every document in every collection. Re-run with: --wipe --yes");
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log(`connected to ${mongoose.connection.name} on ${mongoose.connection.host}`);

  if (!isEncryptionEnabled()) {
    console.warn("FIELD_ENCRYPTION_KEY is not set — notes are seeded in plaintext and note search " +
                 "runs through the regex path, not the blind index.");
  }

  if (wipe) {
    await wipeEverything();
    console.log("wiped every app collection");
  } else {
    const gone = await clearSeed();
    if (gone.users) {
      console.log(`removed previous seed: ${gone.users} users, ${gone.transactions} transactions, ` +
                  `${gone.accounts} accounts, ${gone.budgets} budgets, ${gone.goals} goals, ` +
                  `${gone.trips} trips`);
    }
  }

  const out = await seed();

  console.log("");
  console.log(`seeded ${months} months — ${out.transactions} transactions, ${out.accounts} accounts`);
  console.log("");
  console.log(`  password for every account: ${PASSWORD}`);
  console.log(`  alice@${DOMAIN}   owner of "${out.group.name}" — join code ${JOINCODE}`);
  console.log(`  bob@${DOMAIN}     group member`);
  console.log(`  carol@${DOMAIN}   personal group only — no shared rows, no trips`);
  console.log(`  dave@${DOMAIN}    join request pending Alice's approval`);
  console.log("");
  console.log("  note search terms: coffee, uber, grocery, rent, salary");
  console.log("  one recurring template is already due — the hourly cron generates it next tick");
}

main()
  .then(() => mongoose.disconnect())
  .catch(async (err) => {
    console.error(err.message);
    await mongoose.disconnect().catch(() => {});
    process.exitCode = 1;
  });
