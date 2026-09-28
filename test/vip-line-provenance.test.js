'use strict';

// All behavior below uses injected stand-ins, never a database or provider.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');

function loadDatabase(responses) {
  const calls = [];
  const client = {
    from(table) {
      assert.equal(table, 'sms_messages');
      return {
        insert(row) {
          calls.push({ ...row });
          return { select() { return { maybeSingle: async () => responses.shift() }; } };
        }
      };
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8'), {
    module, exports: module.exports,
    require(name) {
      if (name === '@supabase/supabase-js') return { createClient: () => client };
      if (name === 'ws') return {};
      if (name === './lib/sms-history') return require('../lib/sms-history');
      throw new Error(`Unexpected dependency: ${name}`);
    },
    process: { env: {} }, console: { warn() {} }
  }, { filename: 'db.js' });
  return { insert: module.exports.insertSmsMessage, calls };
}

function absent(column) {
  return { data: null, error: { code: 'PGRST204', message: `Could not find the '${column}' column of 'sms_messages' in the schema cache` } };
}

test('stores actual business line without changing the customer phone or input row', async () => {
  const { insert, calls } = loadDatabase([{ data: { id: 12 }, error: null }]);
  const row = { contact_phone: '+15555550123', business_phone: '+19177254009', body: 'Hello' };
  assert.equal((await insert(row)).id, 12);
  assert.equal(calls[0].business_phone, '+19177254009');
  assert.equal(calls[0].contact_phone, '+15555550123');
  assert.equal(row.business_phone, '+19177254009');
});

test('before migration safely retries history insert without provenance', async () => {
  const { insert, calls } = loadDatabase([absent('business_phone'), { data: { id: 13 }, error: null }]);
  await insert({ business_phone: '+19177254009', body: 'Hello', media_urls: [] });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].business_phone, undefined);
  assert.deepEqual(calls[1].media_urls, []);
});

test('several missing additive columns degrade safely without discarding available fields', async () => {
  const { insert, calls } = loadDatabase([
    absent('business_phone'), absent('sender_user_id'), absent('media_urls'),
    { data: { id: 14 }, error: null }
  ]);
  await insert({ business_phone: '+19177254009', sender_user_id: 2, media_urls: [], body: 'Hello', reply_to_message_id: 7 });
  assert.equal(calls.length, 4);
  assert.equal(calls[3].body, 'Hello');
  assert.equal(calls[3].reply_to_message_id, 7);
});

test('never retries uncertain outcomes or unknown required columns', async () => {
  for (const error of [
    { code: '23505', message: 'duplicate message' },
    { code: 'NETWORK_ERROR', message: 'unknown outcome' },
    absent('body').error
  ]) {
    const { insert, calls } = loadDatabase([{ data: null, error }]);
    await assert.rejects(insert({ business_phone: '+19177254009', body: 'Hello' }));
    assert.equal(calls.length, 1);
  }
});

test('legacy unknown business line remains null and is not inferred from current VIP status', async () => {
  const { insert, calls } = loadDatabase([{ data: { id: 15 }, error: null }]);
  await insert({ business_phone: null, contact_phone: '+15555550123', body: 'Hello' });
  assert.equal(calls[0].business_phone, null);
});

test('migration is additive, nullable and performs no historical backfill', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'scripts/vip-inbox-line-provenance-migration.sql'), 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS business_phone text/);
  assert.doesNotMatch(sql, /\bUPDATE\b|\bDELETE\b|\bDROP\b|NOT NULL/i);
});

test('all additional runtime message categories retain accepted actual line without guessing', () => {
  const sources = [
    ['lib/cart-recovery/service.js', /business_phone: accepted\.from \|\| null/g, 2],
    ['lib/campaigns/delivery-worker.js', /business_phone: providerFrom/g, 1],
    ['lib/campaigns/check-in-reply.js', /business_phone:\s+result\?\.from \|\| null/g, 1],
    ['routes/webhook-send.js', /business_phone: acceptedFrom \|\| null/g, 1],
    ['routes/intelligence.js', /business_phone: acceptedFrom \|\| null/g, 1],
    ['routes/catchup.js', /business_phone: acceptedFrom \|\| null/g, 2]
  ];
  for (const [file, expression, count] of sources) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.equal((source.match(expression) || []).length, count, file);
  }
});

test('manual reply and tapback store accepted sender rather than recomputing historical routing', () => {
  for (const file of ['routes/send.js', 'routes/react.js']) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(source, /from: acceptedFrom/);
    assert.match(source, /business_phone: acceptedFrom \|\| null/);
  }
});

test('all inbound history branches persist recipient line after suppression handling', () => {
  const source = fs.readFileSync(path.join(ROOT, 'routes/webhook.js'), 'utf8');
  assert.equal((source.match(/business_phone: inboundBusinessPhone/g) || []).length, 3);
  const suppression = source.indexOf('await markOptedOut(fromPhone)');
  const firstWrite = source.indexOf('business_phone: inboundBusinessPhone');
  assert.ok(suppression >= 0 && suppression < firstWrite);
  assert.match(source, /typeof inboundToPhone === 'string'/);
});

test('transactional history metadata failure does not turn accepted delivery into a failed job', async () => {
  let sends = 0;
  let written;
  const builder = {
    select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: null, error: null }),
    insert: async () => ({ error: null }),
    update() { return this; }, then(resolve) { return Promise.resolve({ error: null }).then(resolve); }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'flows/utils.js'), 'utf8'), {
    module, exports: module.exports,
    require(name) {
      if (name === '../db') return {
        supabase: { from: () => builder },
        insertSmsMessage: async row => { written = row; throw new Error('metadata unavailable'); }
      };
      if (name === '../telnyx') return { sendSMS: async () => { sends++; return { messageId: 'fake', status: 'sent', from: '+19177254009' }; } };
      if (name === '../lib/message-status') return { normaliseTelnyxStatus: value => value };
      return new Proxy({}, { get: () => () => {} });
    }, console: { log() {}, error() {} }, setTimeout
  }, { filename: 'flows/utils.js' });
  assert.equal(await module.exports.sendAndLog('+15555550123', 'Hello', '1', 'processing'), true);
  assert.equal(sends, 1);
  assert.equal(written.business_phone, '+19177254009');
});
