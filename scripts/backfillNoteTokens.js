// Backfill for W1-28. Every transaction written before the blind index existed has an encrypted
// note and no `noteTokens`, so it is invisible to note search until this has run over it.
//
// Safe to run repeatedly: it only touches rows that have a note, and rewrites the tokens from the
// decrypted note each time. That also makes it the key-rotation tool — re-encrypt the notes under
// the new key, then run this to rebuild the index, since the token HMAC key is derived from
// FIELD_ENCRYPTION_KEY and every token changes with it.
//
//   node scripts/backfillNoteTokens.js            # write
//   node scripts/backfillNoteTokens.js --dry-run  # report only
//
// Notes that fail to decrypt (written under a different key) are counted and skipped rather than
// indexed as ciphertext, which would put the base64 blob's "words" into the index.

require("dotenv").config();
const mongoose = require("mongoose");
const Transaction = require("../models/Transaction");
const { decryptField, noteTokens, isEncryptionEnabled } = require("../utils/fieldCrypto");

const BATCH  = 500;
const dryRun = process.argv.includes("--dry-run");

async function main() {
  if (!isEncryptionEnabled()) {
    console.log("FIELD_ENCRYPTION_KEY is not set — notes are plaintext and searched with a regex.");
    console.log("There is no index to build. Nothing to do.");
    return;
  }
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is not set");

  await mongoose.connect(process.env.MONGO_URI);
  console.log(`connected${dryRun ? " (dry run — nothing will be written)" : ""}`);

  const filter = { note: { $exists: true, $nin: [null, ""] } };
  const total  = await Transaction.countDocuments(filter);
  console.log(`${total} transactions with a note`);

  let scanned = 0, updated = 0, undecryptable = 0;

  // `select("+noteTokens")` because the field is deselected by default in the schema.
  const cursor = Transaction.find(filter).select("note noteTokens").lean().cursor();

  let ops = [];
  for await (const tx of cursor) {
    scanned++;
    const plain = decryptField(tx.note);

    // decryptField returns the input unchanged when it cannot decrypt. A value still carrying the
    // ENC1: prefix therefore failed, and must not be tokenised.
    if (typeof plain === "string" && plain.startsWith("ENC1:")) {
      undecryptable++;
      continue;
    }

    const tokens = noteTokens(plain);
    if (!tokens.length) continue;

    updated++;
    if (!dryRun) {
      ops.push({ updateOne: { filter: { _id: tx._id }, update: { $set: { noteTokens: tokens } } } });
      if (ops.length >= BATCH) {
        await Transaction.bulkWrite(ops, { ordered: false });
        ops = [];
        console.log(`  ${scanned}/${total}…`);
      }
    }
  }
  if (ops.length) await Transaction.bulkWrite(ops, { ordered: false });

  console.log(`scanned ${scanned}, ${dryRun ? "would index" : "indexed"} ${updated}`);
  if (undecryptable) {
    console.warn(`${undecryptable} note(s) could not be decrypted — written under a different ` +
                 `FIELD_ENCRYPTION_KEY. They stay unsearchable; re-encrypting them is a separate job.`);
  }
}

main()
  .then(() => mongoose.disconnect())
  .catch(async (err) => {
    console.error(err);
    await mongoose.disconnect().catch(() => {});
    process.exitCode = 1;
  });
