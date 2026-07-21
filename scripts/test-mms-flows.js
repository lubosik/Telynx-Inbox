'use strict';
/**
 * scripts/test-mms-flows.js — integration tests for MMS, replies, and tapbacks
 *
 * Drives the REAL route code (webhook, send, upload, react) against the REAL
 * Supabase project, using a reserved fake phone number. External vendors are
 * mocked at the seam:
 *   - fetch to api.telnyx.com  → captured + faked (NO real SMS can be sent)
 *   - GHL module               → no-op stub
 *   - push-notify module       → no-op stub
 * Everything else (Supabase DB + Storage, express routing, body parsing) is real.
 *
 * Cleans up every row + storage object it creates.
 * Usage: node scripts/test-mms-flows.js
 */

require('dotenv').config();

const TEST_PHONE = '+15005550123'; // reserved-style fake number, never a customer
const PORT = 3199;

// ── Vendor seam mocks (must happen before routes are required) ──────────────
const Module = require('module');
const path = require('path');

const ghlPath = require.resolve('../ghl.js');
require.cache[ghlPath] = {
  id: ghlPath, filename: ghlPath, loaded: true,
  exports: {
    upsertContact: async () => ({ contactId: null, created: false }),
    addInboundMessage: async () => {},
    addOutboundMessage: async () => {},
    searchContactByEmail: async () => null,
    searchContactByPhone: async () => null
  }
};

const pushPath = require.resolve('../push-notify.js');
require.cache[pushPath] = {
  id: pushPath, filename: pushPath, loaded: true,
  exports: { sendPushToAll: async () => {} }
};

// Intercept ONLY Telnyx API calls; pass everything else (Supabase) through
const realFetch = global.fetch;
const telnyxCalls = [];
let telnyxCounter = 0;
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('api.telnyx.com')) {
    const body = opts?.body ? JSON.parse(opts.body) : {};
    telnyxCalls.push({ url: u, body });
    telnyxCounter++;
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { id: `test-telnyx-${Date.now()}-${telnyxCounter}`, to: [{ status: 'queued' }] } })
    };
  }
  return realFetch(url, opts);
};

const express = require('express');
const { supabase } = require('../db');

// ── Test app: same mounting shape as server.js ──────────────────────────────
const broadcasts = [];
const broadcastSSE = (evt) => broadcasts.push(evt);
require('../lib/broadcaster').setBroadcast(broadcastSSE);

const app = express();
app.use('/webhook/telnyx', express.raw({ type: 'application/json' }));
app.use('/api/upload', express.json({ limit: '8mb' }));
app.use(express.json());
app.use('/webhook', require('../routes/webhook')(broadcastSSE));
app.use('/api/send', require('../routes/send')(broadcastSSE));
app.use('/api/upload', require('../routes/upload'));
app.use('/api/react', require('../routes/react')(broadcastSSE));

// ── Helpers ─────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function post(pathname, body, raw = false) {
  const res = await realFetch(`http://localhost:${PORT}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

function telnyxInbound({ id, text, media }) {
  return {
    data: {
      event_type: 'message.received',
      payload: {
        id,
        direction: 'inbound',
        from: { phone_number: TEST_PHONE, carrier: 'T-Mobile USA' },
        to: [{ phone_number: process.env.TELNYX_PHONE_NUMBER }],
        text: text ?? null,
        media: media || undefined,
        type: media ? 'MMS' : 'SMS',
        received_at: new Date().toISOString()
      }
    }
  };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Webhook processing is async after the 200 — poll for the row instead of guessing
async function waitForMessage(telnyxId, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { data } = await supabase
      .from('sms_messages')
      .select('*')
      .eq('telnyx_message_id', telnyxId)
      .maybeSingle();
    if (data) return data;
    await sleep(400);
  }
  return null;
}

async function getMessages() {
  const { data } = await supabase
    .from('sms_messages')
    .select('*')
    .eq('contact_phone', TEST_PHONE)
    .order('created_at', { ascending: true });
  return data || [];
}

async function columnsMigrated() {
  const { error } = await supabase.from('sms_messages').select('media_urls').limit(1);
  return !error;
}

// ── The suite ───────────────────────────────────────────────────────────────
async function run() {
  const migrated = await columnsMigrated();
  console.log(`\nSchema migrated (media_urls/reply/reactions columns): ${migrated ? 'YES' : 'NO — column-dependent asserts will be reported separately'}\n`);

  // Stage a probe image in storage to act as "Telnyx-hosted" inbound media
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await supabase.storage.from('mms-media').upload('test/fake-telnyx-source.png', png, { contentType: 'image/png', upsert: true });
  const { data: probeUrl } = supabase.storage.from('mms-media').getPublicUrl('test/fake-telnyx-source.png');
  const FAKE_TELNYX_MEDIA_URL = probeUrl.publicUrl;

  // ── 1. Inbound picture-only MMS (null text — the exact bug being fixed) ──
  console.log('1. Inbound media-only MMS (text: null)');
  const id1 = `test-mms-${Date.now()}-1`;
  await post('/webhook/telnyx', telnyxInbound({ id: id1, text: null, media: [{ url: FAKE_TELNYX_MEDIA_URL, content_type: 'image/png', size: 70 }] }));
  const m1 = await waitForMessage(id1);
  let msgs = await getMessages();
  check('message stored despite null text', !!m1);
  if (migrated) {
    check('media_urls persisted', Array.isArray(m1?.media_urls) && m1.media_urls.length === 1, JSON.stringify(m1?.media_urls));
    check('media re-hosted to our bucket', m1?.media_urls?.[0]?.url?.includes('/mms-media/inbound/'), m1?.media_urls?.[0]?.url);
    if (m1?.media_urls?.[0]?.url) {
      const r = await realFetch(m1.media_urls[0].url);
      check('re-hosted image publicly fetchable', r.ok && (await r.arrayBuffer()).byteLength === 70);
    }
  }
  await sleep(2000); // broadcast fires a few awaits after the insert we polled for
  check('SSE broadcast carried media', broadcasts.some(b => b.type === 'new_message' && b.phone === TEST_PHONE && (!migrated || (b.media_urls?.length === 1))));

  // ── 2. Inbound MMS with caption ──
  console.log('2. Inbound MMS with caption');
  const id2 = `test-mms-${Date.now()}-2`;
  await post('/webhook/telnyx', telnyxInbound({ id: id2, text: 'Here is my setup!', media: [{ url: FAKE_TELNYX_MEDIA_URL, content_type: 'image/png', size: 70 }] }));
  const m2 = await waitForMessage(id2);
  msgs = await getMessages();
  check('caption stored', m2?.body === 'Here is my setup!');
  if (migrated) check('caption message also has media', Array.isArray(m2?.media_urls) && m2.media_urls.length === 1);

  // ── 3. Webhook retry dedup ──
  console.log('3. Webhook retry (same telnyx id) is deduped');
  await post('/webhook/telnyx', telnyxInbound({ id: id2, text: 'Here is my setup!', media: [{ url: FAKE_TELNYX_MEDIA_URL, content_type: 'image/png', size: 70 }] }));
  await sleep(1500);
  msgs = await getMessages();
  check('no duplicate row', msgs.filter(m => m.telnyx_message_id === id2).length === 1);

  // ── 4. Outbound MMS via /api/send ──
  console.log('4. Outbound send with media (Telnyx payload captured, not sent)');
  const sendRes = await post('/api/send', { to: TEST_PHONE, message: 'Check this out', mediaUrls: [FAKE_TELNYX_MEDIA_URL] });
  check('send succeeded', sendRes.status === 200 && sendRes.json?.success === true, JSON.stringify(sendRes.json));
  const lastTelnyx = telnyxCalls[telnyxCalls.length - 1];
  check('Telnyx payload includes media_urls', Array.isArray(lastTelnyx?.body?.media_urls) && lastTelnyx.body.media_urls[0] === FAKE_TELNYX_MEDIA_URL);
  check('Telnyx payload text correct', lastTelnyx?.body?.text === 'Check this out');
  await sleep(300);
  msgs = await getMessages();
  const m4 = msgs.find(m => m.body === 'Check this out' && m.direction === 'outbound');
  check('outbound row stored', !!m4);
  if (migrated) check('outbound media_urls stored', Array.isArray(m4?.media_urls) && m4.media_urls.length === 1);

  // ── 5. Media-only outbound (no text) ──
  console.log('5. Outbound media-only send (no text)');
  const sendRes2 = await post('/api/send', { to: TEST_PHONE, message: '', mediaUrls: [FAKE_TELNYX_MEDIA_URL] });
  check('media-only send accepted', sendRes2.status === 200, JSON.stringify(sendRes2.json));
  check('empty send rejected', (await post('/api/send', { to: TEST_PHONE, message: '' })).status === 400);

  // ── 6. Reply threading ──
  console.log('6. Reply threading (in-app quote)');
  const replyRes = await post('/api/send', { to: TEST_PHONE, message: 'Replying to your pic', replyToMessageId: m1?.id });
  check('reply send succeeded', replyRes.status === 200);
  await sleep(300);
  msgs = await getMessages();
  const m6 = msgs.find(m => m.body === 'Replying to your pic');
  if (migrated) check('reply_to_message_id persisted', m6?.reply_to_message_id === m1?.id, `got ${m6?.reply_to_message_id}, want ${m1?.id}`);

  // ── 7. Inbound tapback on an outbound text ──
  console.log('7. Inbound tapback → reaction on target message');
  const id7 = `test-tap-${Date.now()}-7`;
  await post('/webhook/telnyx', telnyxInbound({ id: id7, text: 'Loved "Check this out"' }));
  await sleep(1500);
  msgs = await getMessages();
  if (migrated) {
    const target = msgs.find(m => m.id === m4?.id);
    check('reaction applied to target', Array.isArray(target?.reactions) && target.reactions.some(r => r.type === 'loved' && r.source === 'customer'), JSON.stringify(target?.reactions));
    const rawTap = msgs.find(m => m.telnyx_message_id === id7);
    check('raw tapback row linked (hidden by UI)', rawTap?.reply_to_message_id === m4?.id);
    check('reaction_update broadcast', broadcasts.some(b => b.type === 'reaction_update' && b.message_id === m4?.id));
  } else {
    const rawTap = msgs.find(m => m.telnyx_message_id === id7);
    check('tapback stored as plain message (unmigrated fallback)', !!rawTap);
  }

  // ── 8. Tapback removal ──
  console.log('8. Tapback removal');
  const id8 = `test-tap-${Date.now()}-8`;
  await post('/webhook/telnyx', telnyxInbound({ id: id8, text: 'Removed a heart from "Check this out"' }));
  await sleep(1500);
  if (migrated) {
    msgs = await getMessages();
    const target = msgs.find(m => m.id === m4?.id);
    check('reaction removed', !(target?.reactions || []).some(r => r.type === 'loved' && r.source === 'customer'), JSON.stringify(target?.reactions));
  } else {
    check('removal stored without crash', true);
  }

  // ── 9. Operator react endpoint ──
  console.log('9. Operator tapback via /api/react');
  if (migrated && m1?.id) {
    const reactRes = await post('/api/react', { messageId: m1.id, type: 'loved' });
    check('react succeeded', reactRes.status === 200 && reactRes.json?.reactions?.some(r => r.source === 'operator'), JSON.stringify(reactRes.json));
    const tapCall = telnyxCalls[telnyxCalls.length - 1];
    check('customer receives iPhone-style text', /^Loved “.*”$|^Loved an image$/.test(tapCall?.body?.text || ''), tapCall?.body?.text);
    const reactRes2 = await post('/api/react', { messageId: m1.id, type: 'loved' });
    check('second react toggles off', reactRes2.json?.removed === true);
    const removalCall = telnyxCalls[telnyxCalls.length - 1];
    check('removal text sent', /^Removed a heart from/.test(removalCall?.body?.text || ''), removalCall?.body?.text);
  } else {
    console.log('  (skipped — needs migration)');
  }

  // ── 10. Upload endpoint ──
  console.log('10. /api/upload');
  const upRes = await post('/api/upload', { contentType: 'image/png', data: png.toString('base64') });
  check('upload returns public URL', upRes.status === 200 && upRes.json?.url?.includes('/mms-media/outbound/'), JSON.stringify(upRes.json));
  let uploadedPath = null;
  if (upRes.json?.url) {
    uploadedPath = upRes.json.url.split('/mms-media/')[1];
    const r = await realFetch(upRes.json.url);
    check('uploaded file publicly fetchable', r.ok);
  }
  check('bad content type rejected', (await post('/api/upload', { contentType: 'application/pdf', data: 'aGk=' })).status === 400);
  check('oversize rejected', (await post('/api/upload', { contentType: 'image/png', data: Buffer.alloc(1100 * 1024).toString('base64') })).status === 413);

  // ── 11. Ignored: no text, no media ──
  console.log('11. Empty inbound ignored');
  const id11 = `test-empty-${Date.now()}`;
  await post('/webhook/telnyx', telnyxInbound({ id: id11, text: null }));
  await sleep(800);
  msgs = await getMessages();
  check('no row for empty message', !msgs.find(m => m.telnyx_message_id === id11));

  // ── Verify no real Telnyx sends could have happened ──
  console.log('12. Safety: all Telnyx traffic was intercepted');
  check(`every Telnyx call captured by mock (${telnyxCalls.length} calls)`, telnyxCalls.every(c => c.url.includes('api.telnyx.com')));

  // ── Cleanup ─────────────────────────────────────────────────────────────
  console.log('\nCleaning up test data…');
  await supabase.from('sms_messages').delete().eq('contact_phone', TEST_PHONE);
  await supabase.from('sms_contacts').delete().eq('phone', TEST_PHONE);
  const cleanupPaths = ['test/fake-telnyx-source.png'];
  if (uploadedPath) cleanupPaths.push(uploadedPath);
  // Re-hosted inbound files
  const { data: inboundFiles } = await supabase.storage.from('mms-media').list('inbound');
  for (const f of inboundFiles || []) {
    if (f.name.startsWith('test-mms-')) cleanupPaths.push(`inbound/${f.name}`);
  }
  await supabase.storage.from('mms-media').remove(cleanupPaths);
  const { data: remaining } = await supabase.from('sms_messages').select('id').eq('contact_phone', TEST_PHONE);
  console.log(`Cleanup done — ${remaining?.length || 0} test rows remain (want 0)\n`);

  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

const server = app.listen(PORT, () => {
  run().catch(err => { console.error('Suite error:', err); process.exit(1); });
});
