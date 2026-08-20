'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const createAnalyticsRouter = require('../routes/analytics');
const { AnalyticsNotReadyError } = require('../lib/analytics/aggregate');

function routeHandler(router, pathName) {
  const layer = router.stack.find(entry => entry.route?.path === pathName);
  return layer.route.stack[0].handle;
}

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    payload: null,
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    json(payload) { this.payload = payload; return this; }
  };
}

test('analytics routes pass validated params and prevent caching', async () => {
  let received;
  const router = createAnalyticsRouter({
    service: {
      overview: async params => { received = params; return { ok: true }; },
      attributions: async () => ({ items: [] })
    }
  });
  const res = responseRecorder();
  await routeHandler(router, '/overview')({ query: { period: 'custom', start: '2026-08-01', end: '2026-08-20' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store, private');
  assert.equal(received.period, 'custom');
  assert.equal(received.start, '2026-08-01');
  assert.equal(received.scope, 'attributed');
});

test('invalid requests fail closed before calling the analytics service', async () => {
  let calls = 0;
  const router = createAnalyticsRouter({ service: { overview: async () => { calls += 1; } } });
  const res = responseRecorder();
  await routeHandler(router, '/overview')({ query: { period: 'custom' } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.code, 'INVALID_ANALYTICS_REQUEST');
  assert.equal(calls, 0);
});

test('attribution drill-down defaults to Direct plus Strong and validates explicit scopes', async () => {
  let received;
  const router = createAnalyticsRouter({
    service: {
      overview: async () => ({}),
      attributions: async params => { received = params; return { items: [] }; }
    }
  });
  const handler = routeHandler(router, '/attributions');
  const defaultResponse = responseRecorder();
  await handler({ query: {} }, defaultResponse);
  assert.equal(received.scope, 'attributed');

  const badResponse = responseRecorder();
  await handler({ query: { scope: 'everything-that-looks-good' } }, badResponse);
  assert.equal(badResponse.statusCode, 400);
});

test('missing migration returns 503 rather than believable zero metrics', async () => {
  const router = createAnalyticsRouter({
    service: { overview: async () => { throw new AnalyticsNotReadyError(); } }
  });
  const res = responseRecorder();
  await routeHandler(router, '/overview')({ query: {} }, res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.payload, {
    error: 'Analytics is not available until its additive database migration is applied.',
    code: 'ANALYTICS_NOT_READY'
  });
});

test('upstream API failures do not leak provider or database error details', async () => {
  const router = createAnalyticsRouter({
    service: { overview: async () => { throw Object.assign(new Error('private database detail'), { code: 'XX000' }); } }
  });
  const res = responseRecorder();
  const originalError = console.error;
  console.error = () => {};
  try { await routeHandler(router, '/overview')({ query: {} }, res); }
  finally { console.error = originalError; }
  assert.equal(res.statusCode, 500);
  assert.equal(res.payload.code, 'ANALYTICS_LOAD_FAILED');
  assert.equal(JSON.stringify(res.payload).includes('private database detail'), false);
});

test('an internal TypeError is not misreported as a client request mistake', async () => {
  const router = createAnalyticsRouter({
    service: { overview: async () => { throw new TypeError('internal implementation detail'); } }
  });
  const res = responseRecorder();
  const originalError = console.error;
  console.error = () => {};
  try { await routeHandler(router, '/overview')({ query: {} }, res); }
  finally { console.error = originalError; }
  assert.equal(res.statusCode, 500);
  assert.equal(res.payload.code, 'ANALYTICS_LOAD_FAILED');
});

test('both analytics endpoints remain behind the existing session auth boundary', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /app\.use\('\/api\/analytics',\s+requireAuth,\s+require\('\.\/routes\/analytics'\)\(\)\)/);
});
