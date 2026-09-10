// Test helpers.
//
// There is no database in CI and no intention of adding one — these tests pin logic, not Mongo.
// Controllers are loaded for real and their model requires are swapped for stubs, so what is under
// test is the shipped code path rather than a paraphrase of it.

const Module = require('module');
const path   = require('path');

const ROOT = path.join(__dirname, '..', '..');

/**
 * Loads `modulePath` (relative to the repo root) with the given requires replaced.
 *
 * `stubs` is keyed by the request string exactly as the module under test writes it, e.g.
 * `'../models/Transaction'`. Only requires made *by that file* are intercepted, so its own
 * dependencies still load normally.
 *
 * `also` extends that to a few named collaborators — files the module under test delegates to,
 * which need the same models stubbed. It exists for `utils/purgeUser.js`: the deletion logic moved
 * out of `server.js` and `authController.js` into one helper (W1-27), and a test of either caller
 * still has to reach the real deletes. Note that a collaborator writes its requires from its own
 * directory, so the stub map needs that spelling too (`'../models/User'`, not `'./models/User'`).
 */
function loadWithStubs(modulePath, stubs, { also = [] } = {}) {
  const target      = require.resolve(path.join(ROOT, modulePath));
  const collaborate = also.map((p) => require.resolve(path.join(ROOT, p)));
  const intercepted = new Set([target, ...collaborate]);

  for (const file of intercepted) delete require.cache[file];

  const origLoad = Module._load;
  Module._load = function (request, parent) {
    if (parent && intercepted.has(parent.filename) && Object.hasOwn(stubs, request)) {
      return stubs[request];
    }
    return origLoad.apply(this, arguments);
  };
  try {
    return require(target);
  } finally {
    Module._load = origLoad;
    for (const file of intercepted) delete require.cache[file];
  }
}

/** Minimal Express `res` that records what the handler did with it. */
function mockRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    send(payload) { this.body = payload; return this; },
  };
  return res;
}

/** Mongoose-ish query stub: `.lean()`, `.sort()`, `.select()` all chain and resolve to `rows`. */
function chain(rows) {
  const q = {
    lean:   () => q,
    sort:   () => q,
    select: () => q,
    limit:  () => q,
    skip:   () => q,
    populate: () => q,
    then:   (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
  };
  return q;
}

/**
 * Freezes `Date` (both `new Date()` and `Date.now()`) at `iso` for the duration of `fn`.
 * Returns whatever `fn` returns; always restores.
 */
async function atTime(iso, fn) {
  const RealDate = Date;
  const t = new RealDate(iso).getTime();
  global.Date = class extends RealDate {
    constructor(...a) { if (a.length === 0) super(t); else super(...a); }
    static now() { return t; }
  };
  try {
    return await fn(RealDate);
  } finally {
    global.Date = RealDate;
  }
}

module.exports = { loadWithStubs, mockRes, chain, atTime, ROOT };
