// Runs scripts/backup.sh from inside the app process.
//
// The script has always existed but nothing ever invoked it: it expected an operator to add a
// host crontab entry, which was documented nowhere, and a host cron job would not have seen
// MONGO_URI or the AWS keys anyway — those live in .env, which only this process loads. So the
// nightly backup CONTEXT.md promised has never actually run anywhere.
//
// Spawning it from here fixes both halves: the schedule lives with the two crons already in
// server.js, and the child inherits this process's environment, .env included.

const { spawn } = require("child_process");
const path      = require("path");

const SCRIPT_PATH  = path.join(__dirname, "..", "scripts", "backup.sh");
const TIMEOUT_MS   = 30 * 60 * 1000;

// A hung mongodump must not let the next night's run stack on top of it — two concurrent dumps
// would compete for the same /tmp space and the same Atlas connection budget.
let inFlight = false;

/**
 * Runs one backup. Resolves with the script's stdout; rejects if it is already running, exits
 * non-zero, or overruns TIMEOUT_MS.
 */
function runBackup() {
    if (inFlight) return Promise.reject(new Error("A backup is already running"));
    inFlight = true;

    return new Promise((resolve, reject) => {
        // `bash` explicitly rather than executing the file: the repo is developed on Windows, so
        // the executable bit does not reliably survive a clone.
        const child = spawn("bash", [SCRIPT_PATH], { env: process.env });

        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => { stdout += d.toString(); });
        child.stderr.on("data", (d) => { stderr += d.toString(); });

        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            // The temp archive is left behind on purpose — /tmp is cleared on reboot, and a
            // half-written file is evidence worth having if this ever fires.
            reject(new Error(`Backup timed out after ${TIMEOUT_MS / 60000} minutes`));
        }, TIMEOUT_MS);

        const finish = (fn, arg) => {
            clearTimeout(timer);
            inFlight = false;
            fn(arg);
        };

        child.on("error", (err) => {
            // Almost always "bash not found" — the script needs bash, mongodump and the aws CLI
            // on the host, none of which npm installs.
            finish(reject, new Error(`Could not run backup script: ${err.message}`));
        });

        child.on("close", (code) => {
            if (code === 0) finish(resolve, stdout);
            else finish(reject, new Error(`Backup script exited ${code}: ${stderr.trim() || stdout.trim()}`));
        });
    });
}

/** True when the deployment is configured for backups at all. Without a bucket there is nowhere
 *  to put them, so the cron is simply not scheduled. */
function isBackupConfigured() {
    return Boolean(process.env.BACKUP_S3_BUCKET);
}

module.exports = { runBackup, isBackupConfigured };

// `npm run backup` — run one on demand, with .env loaded, without waiting for 02:00.
if (require.main === module) {
    require("dotenv").config();
    if (!isBackupConfigured()) {
        console.error("BACKUP_S3_BUCKET is not set — nothing to back up to.");
        process.exit(1);
    }
    runBackup()
        .then((out) => { console.log(out.trim()); process.exit(0); })
        .catch((err) => { console.error(err.message); process.exit(1); });
}
