// W1-21: the API had no security headers and no terminal error handler, so an unhandled error fell
// through to Express's default — which outside NODE_ENV=production replies with an HTML page
// carrying the full stack trace. The app parses JSON, so it showed a generic failure while the
// response body was busy listing absolute file paths to anyone who asked.
//
// These tests run the real `server.js`, listening on an ephemeral port, and make real requests
// through it. What is stubbed is the database and the routers, not the middleware chain.

const test   = require('node:test');
const assert = require('node:assert/strict');
const http   = require('node:http');
const express = require('express');
const { loadServerCrons } = require('./helpers/serverCron');

/**
 * Boots the shipped app on a random port with `routes` swapped in, and hands back a `fetch` bound
 * to it. Quiets the error handler's own logging so a deliberate 500 does not litter the output.
 */
async function withServer(routes, fn) {
  const { app } = loadServerCrons(routes);
  assert.ok(app, 'server.js must hand its express app to http.createServer');

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const logs = [];
  const realError = console.error;
  const realWarn  = console.warn;
  console.error = (...a) => logs.push(a.join(' '));
  console.warn  = (...a) => logs.push(a.join(' '));

  try {
    return await fn((path, init) => fetch(base + path, init), logs);
  } finally {
    console.error = realError;
    console.warn  = realWarn;
    await new Promise((resolve) => server.close(resolve));
  }
}

/** A router mounted where authRoutes normally goes, so the request reaches it through the real app. */
function router(build) {
  const r = express.Router();
  build(r);
  return r;
}

test('helmet sets security headers on a normal response', async () => {
  await withServer({}, async (get) => {
    const res = await get('/');

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.ok(res.headers.get('strict-transport-security'), 'HSTS must be set');
  });
});

test('express no longer advertises itself', async () => {
  // `X-Powered-By: Express` tells a scanner exactly which CVE list to work through.
  await withServer({}, async (get) => {
    const res = await get('/');
    assert.equal(res.headers.get('x-powered-by'), null);
  });
});

test('an unmatched route answers with JSON, not an HTML page', async () => {
  // The app parses every response as JSON. An HTML 404 surfaces as an unhelpful parse error.
  await withServer({}, async (get) => {
    const res = await get('/api/nope');

    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.match((await res.json()).message, /Cannot GET \/api\/nope/);
  });
});

test('a thrown error returns a generic 500 with no stack trace', async () => {
  const routes = {
    './routes/authRoutes': router((r) => {
      r.get('/boom', () => { throw new Error('connect ECONNREFUSED 10.0.0.4:27017 admin:hunter2'); });
    }),
  };

  await withServer(routes, async (get) => {
    const res  = await get('/api/auth/boom');
    const body = await res.text();

    assert.equal(res.status, 500);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.deepEqual(JSON.parse(body), { message: 'Something went wrong' });
    assert.equal(body.includes('hunter2'), false, 'the error message must not reach the client');
    assert.equal(body.includes('server.js'), false, 'no file paths');
  });
});

test('a rejected promise in an async handler is caught too', async () => {
  // Express 5 forwards these on its own; on Express 4 this would have crashed the process. Pinned
  // because it is the shape almost every controller in this repo has.
  const routes = {
    './routes/authRoutes': router((r) => {
      r.get('/boom', async () => { throw new Error('mongo timed out'); });
    }),
  };

  await withServer(routes, async (get) => {
    const res = await get('/api/auth/boom');
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { message: 'Something went wrong' });
  });
});

test('a 500 is logged server-side even though the client is told nothing', async () => {
  // A generic body plus no log is an error that never happened.
  const routes = {
    './routes/authRoutes': router((r) => {
      r.get('/boom', () => { throw new Error('the real cause'); });
    }),
  };

  await withServer(routes, async (get, logs) => {
    await get('/api/auth/boom');
    assert.ok(logs.some((l) => l.includes('/api/auth/boom') && l.includes('500')),
      `expected the failure in the log, got: ${JSON.stringify(logs)}`);
  });
});

test('an error carrying a status keeps it and its message', async () => {
  // Controllers throw these deliberately; swallowing them into a 500 would break real responses.
  const routes = {
    './routes/authRoutes': router((r) => {
      r.get('/nope', () => {
        const err = new Error('You are not a member of this group');
        err.status = 403;
        throw err;
      });
    }),
  };

  await withServer(routes, async (get) => {
    const res = await get('/api/auth/nope');
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { message: 'You are not a member of this group' });
  });
});

test('a malformed JSON body is a 400, not a 500', async () => {
  await withServer({}, async (get) => {
    const res = await get('/api/auth/anything', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"email": ',
    });

    assert.equal(res.status, 400);
    assert.match((await res.json()).message, /Malformed JSON/);
  });
});

test('a mongoose CastError names the bad field without leaking the query', async () => {
  const routes = {
    './routes/authRoutes': router((r) => {
      r.get('/cast', () => {
        const err = new Error('Cast to ObjectId failed for value "abc" at path "_id"');
        err.name = 'CastError';
        err.path = 'accountId';
        throw err;
      });
    }),
  };

  await withServer(routes, async (get) => {
    const res = await get('/api/auth/cast');
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { message: 'Invalid accountId' });
  });
});

test('a duplicate key is a 409, not a 500', async () => {
  const routes = {
    './routes/authRoutes': router((r) => {
      r.get('/dup', () => {
        const err = new Error('E11000 duplicate key error collection: app.users index: email_1');
        err.code = 11000;
        throw err;
      });
    }),
  };

  await withServer(routes, async (get) => {
    const res  = await get('/api/auth/dup');
    const body = await res.text();

    assert.equal(res.status, 409);
    assert.equal(body.includes('E11000'), false, 'the index name is not the client\'s business');
  });
});

test('a mongoose ValidationError reports the fields the client got wrong', async () => {
  const routes = {
    './routes/authRoutes': router((r) => {
      r.get('/invalid', () => {
        const err = new Error('validation failed');
        err.name = 'ValidationError';
        err.errors = { amount: { message: 'Path `amount` is required.' } };
        throw err;
      });
    }),
  };

  await withServer(routes, async (get) => {
    const res = await get('/api/auth/invalid');
    assert.equal(res.status, 400);
    assert.match((await res.json()).message, /amount/);
  });
});

test('an error raised after the response started does not double-send', async () => {
  // `res.headersSent` — writing a second set of headers throws inside the handler itself, which is
  // how a clean 500 turns into a hung socket.
  const routes = {
    './routes/authRoutes': router((r) => {
      r.get('/late', (req, res) => {
        res.status(200).json({ ok: true });
        throw new Error('too late');
      });
    }),
  };

  await withServer(routes, async (get) => {
    const res = await get('/api/auth/late');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});
