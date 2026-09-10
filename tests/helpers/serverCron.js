// Loads the real `server.js` with its models, routes, socket server and HTTP listener stubbed,
// and hands back the cron jobs it registered so they can be invoked directly.
//
// The crons are the least-observed code in the backend — they run unattended at 00:05, hourly and
// at 02:00, and three of the Phase 1 bugs lived in them. Testing the shipped file rather than a
// copy of the loop is the whole point.

const express = require('express');
const { loadWithStubs } = require('./stubs');

/**
 * @param {object} models  overrides keyed by request string, e.g. `'./models/Transaction'`
 * @returns {{ jobs: Array<{expr: string, fn: Function}>, emitted: Array, log: object }}
 */
function loadServerCrons(models = {}, { backup } = {}) {
  // dotenv is stubbed below, so the developer's own .env never reaches these tests — the env is
  // whatever the test sets and nothing else, on every machine.
  process.env.JWT_SECRET           = 'a'.repeat(32);
  process.env.REFRESH_TOKEN_SECRET = 'b'.repeat(32);
  process.env.MONGO_URI            = 'mongodb://stub/db';
  delete process.env.BACKUP_S3_BUCKET;

  const jobs    = [];
  const emitted = [];
  let   app     = null;

  const noop = {
    find: async () => [], deleteMany: async () => {},
    updateMany: async () => {}, updateOne: async () => {},
    findByIdAndDelete: async () => {},
  };

  const stubs = {
    dotenv: { config: () => ({ parsed: {} }) },
    './config/db': () => {},
    './models/Transaction': noop, './models/User': noop, './models/Goal': noop,
    './models/Split': noop, './models/Budget': noop, './models/Group': noop,
    './models/Account': noop,
    './routes/authRoutes': express.Router(),   './routes/groupRoutes': express.Router(),
    './routes/transactionRoutes': express.Router(), './routes/budgetRoutes': express.Router(),
    './routes/goalRoutes': express.Router(),   './routes/splitRoutes': express.Router(),
    './routes/userRoutes': express.Router(),   './routes/accountRoutes': express.Router(),
    'node-cron': { schedule: (expr, fn) => { jobs.push({ expr, fn }); return { stop() {} }; } },
    'socket.io': {
      Server: class {
        use() {}
        on() {}
        to(room) { return { emit: (ev, payload) => emitted.push({ room, ev, payload }) }; }
      },
    },
    // Capture the real express app on its way past. Nothing listens here, but a test that wants a
    // live server can hand it to the real http.createServer itself.
    'http': { createServer: (a) => { app = a; return { listen: () => {} }; } },
    ...models,
  };
  if (backup) stubs['./utils/backup'] = backup;

  // `utils/purgeUser.js` holds the deletion the purge cron performs, and writes its model requires
  // relative to `utils/`. Mirror every `./models/X` key to `../models/X` so a test's own model
  // overrides reach it unchanged.
  for (const [request, stub] of Object.entries(stubs)) {
    if (request.startsWith('./models/')) stubs[`../models/${request.slice('./models/'.length)}`] = stub;
  }

  loadWithStubs('server.js', stubs, { also: ['utils/purgeUser.js'] });
  return { jobs, emitted, app };
}

/** The job registered for a cron expression, or undefined if none was. */
function jobFor(jobs, expr) {
  const found = jobs.find((j) => j.expr === expr);
  return found && found.fn;
}

module.exports = { loadServerCrons, jobFor };
