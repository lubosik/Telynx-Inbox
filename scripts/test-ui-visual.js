'use strict';
/**
 * scripts/test-ui-visual.js — Playwright visual verification of the MMS /
 * reply / reaction UI against a fixture stub server (no real backend, no
 * real sends). Screenshots land in the scratch dir passed as argv[2].
 *
 * Verifies (desktop 1920px + iPhone 390px):
 *  - image bubbles render, media-only sidebar preview shows "📷 Picture"
 *  - reaction badge on a bubble; raw tapback row hidden
 *  - reply quote block inside a bubble
 *  - right-click opens the action sheet; Reply shows the reply bar
 *  - attach button stages a thumbnail; lightbox opens on image click
 */

const path = require('path');
const express = require('express');

const OUT = process.argv[2] || '/tmp/ui-shots';
const PORT = 3198;
const PHONE = '+13055551234';

const now = Date.now();
const iso = (min) => new Date(now - min * 60000).toISOString();

const MESSAGES = [
  { id: 1, contact_phone: PHONE, direction: 'inbound',  body: 'Hey, is my order shipped yet?', status: 'delivered', created_at: iso(60) },
  { id: 2, contact_phone: PHONE, direction: 'outbound', body: 'Yes! It went out this morning.', status: 'delivered', created_at: iso(55),
    reactions: [{ type: 'loved', source: 'customer', at: iso(50) }] },
  { id: 3, contact_phone: PHONE, direction: 'inbound',  body: '', status: 'delivered', created_at: iso(40),
    media_urls: [{ url: '/icons/icon-512.png', content_type: 'image/png' }] },
  { id: 4, contact_phone: PHONE, direction: 'outbound', body: 'Nice! That arrived fast. Enjoy!', status: 'sent', created_at: iso(30),
    reply_to_message_id: 3 },
  // Raw tapback row — must be HIDDEN by the UI (rendered as badge on msg 2)
  { id: 5, contact_phone: PHONE, direction: 'inbound',  body: 'Loved "Yes! It went out this morning."', status: 'delivered',
    created_at: iso(50), reply_to_message_id: 2 }
];

const CONVERSATIONS = [{
  phone: PHONE, name: 'Dominik Test', unread_count: 0, last_seen: iso(30),
  lastMessage: { body: '', direction: 'inbound', created_at: iso(40), media_urls: [{ url: '/icons/icon-512.png', content_type: 'image/png' }] },
  latest_order_status: 'processing', latest_order_date: iso(1000), latest_order_id: '9999'
}];

const app = express();
app.use(express.json({ limit: '8mb' }));
app.get('/auth/check', (req, res) => res.json({ authenticated: true }));
app.get('/api/conversations', (req, res) => res.json(CONVERSATIONS));
app.get('/api/conversations/:phone', (req, res) => res.json(MESSAGES));
app.get('/api/voice/logs', (req, res) => res.json([]));
app.get('/api/voice/token', (req, res) => res.status(500).json({ error: 'stub' }));
app.get('/api/push/vapid-key', (req, res) => res.json({ publicKey: null }));
app.post('/api/send', (req, res) => res.json({ success: true, messageId: 'stub', id: 99 }));
app.post('/api/upload', (req, res) => res.json({ url: 'http://localhost:' + PORT + '/icons/icon-192.png', content_type: 'image/png', size: 1000 }));
app.post('/api/react', (req, res) => res.json({ success: true, reactions: [{ type: req.body.type, source: 'operator', at: new Date().toISOString() }] }));
app.get('/api/sse', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.flushHeaders();
  res.write('data: {"type":"connected"}\n\n');
});
app.use(express.static(path.join(__dirname, '..', 'public')));

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

async function run() {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();

  for (const [label, viewport, isMobile] of [
    ['desktop', { width: 1920, height: 1080 }, false],
    ['iphone',  { width: 390,  height: 844 },  true]
  ]) {
    console.log(`\n── ${label} (${viewport.width}px) ──`);
    const ctx = await browser.newContext({ viewport, hasTouch: isMobile, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForTimeout(1500);

    // Go to Messages tab and open the thread (bottom nav on mobile, header tabs on desktop)
    await page.click(isMobile ? '.bnav-btn:has-text("Messages")' : '.header-tab:has-text("MESSAGES")');
    await page.waitForTimeout(400);
    await page.click(`text=Dominik Test`);
    await page.waitForTimeout(800);

    // Sidebar preview (visible on desktop only; on mobile we're now in the thread)
    if (!isMobile) {
      const preview = await page.locator('.conv-preview').first().textContent();
      check('sidebar preview shows picture icon', preview.includes('📷'), preview);
    }

    // Bubbles
    check('image bubble rendered', await page.locator('.msg-img').count() >= 1);
    check('reply quote rendered', await page.locator('.msg-reply-quote').count() === 1);
    const quoteText = await page.locator('.msg-reply-quote').textContent();
    check('reply quote references the picture', quoteText.includes('📷'), quoteText);
    check('reaction badge rendered', await page.locator('.msg-reactions').count() === 1);
    const badge = await page.locator('.msg-reactions').textContent();
    check('reaction badge is a heart', badge.includes('❤️'), badge);
    const bubbles = await page.locator('.msg-bubble').count();
    check('raw tapback row hidden (4 bubbles, not 5)', bubbles === 4, `got ${bubbles}`);

    await page.screenshot({ path: `${OUT}/${label}-1-thread.png`, fullPage: false });

    // Lightbox
    await page.locator('.msg-img').first().click();
    await page.waitForTimeout(300);
    check('lightbox opens', await page.locator('.lightbox').count() === 1);
    await page.screenshot({ path: `${OUT}/${label}-2-lightbox.png` });
    await page.locator('.lightbox').click();
    await page.waitForTimeout(200);

    // Action sheet via right-click (desktop) / long-press (mobile)
    const inboundBubble = page.locator('.msg-bubble.inbound').first();
    if (isMobile) {
      const box = await inboundBubble.boundingBox();
      await page.touchscreen.tap(box.x + 10, box.y + 10); // focus
      // simulate long-press: touchstart, wait, touchend via dispatch
      await inboundBubble.dispatchEvent('touchstart');
      await page.waitForTimeout(700);
      await inboundBubble.dispatchEvent('touchend');
    } else {
      await inboundBubble.click({ button: 'right' });
    }
    await page.waitForTimeout(400);
    check('action sheet opens', await page.locator('.msg-action-sheet').count() === 1);
    check('tapback row shown for inbound msg', await page.locator('.tapback-btn').count() === 6);
    await page.screenshot({ path: `${OUT}/${label}-3-action-sheet.png` });

    // Reply flow
    await page.click('text=Reply');
    await page.waitForTimeout(300);
    check('reply bar appears', await page.locator('.reply-bar').count() === 1);

    // Attach flow — feed a real png through the file input
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: 'test.png', mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
    });
    await page.waitForTimeout(1200);
    check('attachment thumbnail staged', await page.locator('.attach-thumb img').count() === 1);
    const footer = await page.locator('.compose-footer').textContent();
    check('footer shows MMS mode', footer.includes('MMS'), footer);
    await page.screenshot({ path: `${OUT}/${label}-4-compose-reply-attach.png` });

    check('no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  await browser.close();
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  console.log(`Screenshots: ${OUT}`);
  process.exit(failed > 0 ? 1 : 0);
}

const server = app.listen(PORT, () => {
  run().catch(err => { console.error('UI suite error:', err); process.exit(1); });
});
