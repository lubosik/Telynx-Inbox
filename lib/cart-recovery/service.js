'use strict';
const crypto = require('node:crypto');
const { normalisePhone } = require('../phone');
const { signBody, seal, unseal } = require('./security');
const { evaluateSingleRecipient, campaignLiveSendEligibility } = require('../campaigns/eligibility');
const { findBy, stageCartRecoveryAttribution } = require('./attribution');
const TYPES = new Set(['consent.updated', 'cart.updated', 'cart.emptied', 'cart.clicked', 'order.created', 'order.paid']);
const DEFAULT_COPY = 'Vici Peptides: You left items in your cart. Resume checkout: {{recovery_url}} Reply STOP to opt out, HELP for help.';
const invalid = () => Object.assign(new Error('Invalid connector event.'), { code: 'INVALID_CART_EVENT', status: 400 });
function text(value, max = 256) { return typeof value === 'string' && value.length <= max ? value : ''; }
function iso(value) { const ms = Date.parse(value); if (!Number.isFinite(ms)) throw invalid(); return new Date(ms).toISOString(); }
function normalizeEvent(input, env, now = new Date()) {
  if (!input || !TYPES.has(input.event_type) || !/^[a-zA-Z0-9:_-]{8,160}$/.test(input.event_id || '')) throw invalid();
  const workspace = env.LUKO_WP_STORE_ID || 'vici';
  if (input.store !== workspace) throw invalid();
  const occurred = iso(input.occurred_at);
  if (Date.parse(occurred) > now.getTime() + 300000) throw invalid();
  const source = input.customer || {};
  const rawPhone = text(source.phone, 50);
  if (/[a-z]/i.test(rawPhone)) throw invalid();
  const phone = normalisePhone(rawPhone);
  if (phone && !/^\+[1-9][0-9]{7,14}$/.test(phone)) throw invalid();
  const consent = input.consent || {};
  const rawConsentPhone = text(consent.phone, 50);
  if (/[a-z]/i.test(rawConsentPhone)) throw invalid();
  const consentPhone = normalisePhone(rawConsentPhone);
  const consentGranted = consent.granted === true && consentPhone === phone && Boolean(phone)
    && Boolean(text(consent.disclosure, 3000)) && Boolean(text(consent.version, 100))
    && Boolean(text(consent.source, 1000)) && /^https:\/\//.test(consent.privacy_url || '') && /^https:\/\//.test(consent.terms_url || '');
  const result = { event_id: input.event_id, event_type: input.event_type, workspace_id: workspace,
    occurred_at: occurred, customer_id: String(source.wordpress_user_id || ''), phone,
    consent: { ...consent, granted: consentGranted, occurred_at: consent.occurred_at ? iso(consent.occurred_at) : occurred } };
  if (input.event_type === 'consent.updated') return result;
  const cart = input.cart || {};
  const externalID = String(cart.external_cart_id || input.order?.external_cart_id || '');
  if (!/^[a-zA-Z0-9:_-]{8,160}$/.test(externalID)) throw invalid();
  result.external_cart_id = externalID;
  result.version = Number(cart.version ?? cart.event_sequence ?? 0);
  if (!Number.isSafeInteger(result.version) || result.version < 0) throw invalid();
  result.items = Array.isArray(cart.items) ? cart.items : [];
  if (result.items.length > 100 || result.items.some(item => !item || !Number.isInteger(Number(item.quantity)) || Number(item.quantity) < 1 || Number(item.quantity) > 1000)) throw invalid();
  result.currency = /^[A-Z]{3}$/.test(cart.currency || input.order?.currency || '') ? (cart.currency || input.order.currency) : 'USD';
  result.total = Number(cart.total || input.order?.total || 0);
  if (!Number.isFinite(result.total) || result.total < 0 || result.total > 10000000) throw invalid();
  result.last_activity_at = iso(cart.last_activity_at || occurred);
  if (Date.parse(result.last_activity_at) > now.getTime() + 300000) throw invalid();
  result.expires_at = iso(cart.expires_at || cart.recovery_expires_at || new Date(Date.parse(occurred) + 7 * 86400000).toISOString());
  if (input.event_type === 'cart.updated') {
    if (!result.version || !phone || !result.items.length) throw invalid();
    let url, allowed;
    try { url = new URL(cart.recovery_url); allowed = new URL(env.LUKO_WP_URL); } catch { throw invalid(); }
    if (url.protocol !== 'https:' || url.origin !== allowed.origin || url.username || url.password || url.search || url.hash || !/^\/r\/[A-Za-z0-9_-]{43,128}\/?$/.test(url.pathname)) throw invalid();
    result.recovery_ciphertext = seal(url.href, env.LUKO_RECOVERY_ENCRYPTION_KEY || env.LUKO_WP_SIGNING_SECRET);
  }
  if (input.event_type.startsWith('order.')) {
    const order = input.order || {};
    if (!/^\d{1,24}$/.test(String(order.order_id || ''))) throw invalid();
    result.order = { order_id: String(order.order_id), status: text(order.status, 40), total: Number(order.total), currency: text(order.currency, 3),
      paid_at: order.paid_at ? iso(order.paid_at) : null, recovery_clicked_at: order.recovery_clicked_at ? iso(order.recovery_clicked_at) : null,
      attribution_valid: order.attribution_valid === true };
    if (!Number.isFinite(result.order.total) || result.order.total < 0 || result.order.total > 10000000 || !/^[A-Z]{3}$/.test(result.order.currency)) throw invalid();
    if (input.event_type === 'order.paid' && (!result.order.paid_at || !['processing', 'completed'].includes(result.order.status))) throw invalid();
  }
  return result;
}

function createCartRecoveryService({
  client,
  env = process.env,
  send,
  fetch: fetchImpl = global.fetch,
  now = () => new Date(),
  evaluateRecipient = evaluateSingleRecipient,
  liveEligibility = campaignLiveSendEligibility
} = {}) {
  if (!client) throw new Error('Database client required.');
  const workspace = env.LUKO_WP_STORE_ID || 'vici';
  const encryptionKey = () => env.LUKO_RECOVERY_ENCRYPTION_KEY || env.LUKO_WP_SIGNING_SECRET;
  async function rpc(name, args) {
    const { data, error } = await client.rpc(name, args);
    if (error) throw Object.assign(new Error('Recovery persistence operation failed.'), { code: error.code || 'CART_DATABASE_ERROR' });
    return data;
  }
  async function processEvent(input) {
    const normalized = normalizeEvent(input, env, now());
    // Digest originals before encryption: retry ciphertext is randomized.
    const digest = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const result = await rpc('apply_luko_cart_event', { p_event: normalized, p_digest: digest });
    if (normalized.event_type === 'order.paid') {
      try {
        const cart = await findBy(client, workspace, 'external_cart_id', normalized.external_cart_id);
        await stageCartRecoveryAttribution(client, cart);
      } catch (error) {
        console.error('[CART RECOVERY] Attribution reconciliation deferred:', error.code || error.message);
      }
    }
    return result;
  }
  async function preflight(cart) {
    const requestID = crypto.randomUUID();
    const body = JSON.stringify({ external_cart_id: cart.external_cart_id, request_id: requestID });
    const url = new URL('/wp-json/luko/v1/cart-status', env.LUKO_WP_URL);
    if (url.protocol !== 'https:') throw new Error('Unsafe connector URL.');
    const response = await fetchImpl(url.href, { method: 'POST', redirect: 'error',
      headers: signBody(body, env.LUKO_WP_SIGNING_SECRET, Math.floor(now().getTime() / 1000)),
      body, signal: AbortSignal.timeout(10000) });
    if (!response.ok) return false;
    const status = await response.json();
    const version = Number(cart.event_version ?? cart.version);
    return status.request_id === requestID && status.eligible === true && status.current_consent === true && !status.order_id
      && status.external_cart_id === cart.external_cart_id && Number(status.version ?? status.event_sequence) === version
      && Array.isArray(status.items) && status.items.length > 0;
  }
  async function runDue() {
    if (env.CART_RECOVERY_ENABLED !== 'true') {
      return { disabled: true, claimed: 0, dryRun: 0, sent: 0, deferred: 0, uncertain: 0 };
    }
    const dryRun = env.SMS_DRY_RUN !== 'false';
    const summary = { claimed: 0, dryRun: 0, sent: 0, deferred: 0, uncertain: 0 };
    const rows = await rpc('claim_luko_cart_recoveries', { p_workspace: workspace, p_limit: 20 });
    for (const cart of rows || []) {
      summary.claimed++;
      try {
        const recipient = await evaluateRecipient({ client, phone: cart.contact_phone, env, workspaceID: workspace });
        if (!recipient.eligible) {
          await rpc('defer_luko_cart_recovery', { p_id: cart.id, p_claim: cart.claim_token, p_reason: recipient.reason });
          summary.deferred++;
          continue;
        }
        let checked = false;
        try { checked = await preflight(cart); } catch { checked = false; }
        if (!checked) { await rpc('defer_luko_cart_recovery', { p_id: cart.id, p_claim: cart.claim_token, p_reason: 'wordpress_preflight_failed' }); summary.deferred++; continue; }
        const url = unseal(cart.recovery_ciphertext, encryptionKey());
        const copy = cart.message_template || DEFAULT_COPY;
        if (!copy.includes('{{recovery_url}}') || !/STOP/i.test(copy) || !/HELP/i.test(copy) || copy.length > 1200) throw new Error('Invalid recovery copy.');
        const message = copy.replaceAll('{{recovery_url}}', url);
        const campaignGate = await liveEligibility({ client, env, workspaceID: workspace });
        const liveAllowed = !dryRun && env.LUKO_CART_PROVIDER_APPROVED === 'true' && campaignGate.allowed
          && Boolean(env.TELNYX_API_KEY && env.TELNYX_PHONE_NUMBER && env.TELNYX_MESSAGING_PROFILE_ID && env.TELNYX_PUBLIC_KEY);
        const attempt = await rpc('begin_luko_cart_recovery', { p_id: cart.id, p_claim: cart.claim_token, p_version: cart.event_version ?? cart.version,
          p_dry_run: dryRun, p_live_allowed: liveAllowed, p_message_ciphertext: seal(message, encryptionKey()) });
        if (!attempt?.allowed) { summary.deferred++; continue; }
        if (attempt?.dry_run === true) { summary.dryRun++; continue; }
        let finalCheck = false;
        try { finalCheck = await preflight(cart); } catch { finalCheck = false; }
        if (!finalCheck) {
          await rpc('cancel_luko_cart_recovery_send', { p_id: cart.id, p_claim: cart.claim_token, p_reason: 'final_wordpress_preflight_failed' });
          summary.deferred++;
          continue;
        }
        // No retries after the provider boundary. Any uncertain result remains
        // sending until SQL marks reconciliation_required, never active again.
        let accepted;
        try { accepted = await (send || require('../../telnyx').sendSMS)(cart.contact_phone, message); } catch {
          await rpc('mark_luko_cart_send_uncertain', { p_id: cart.id, p_claim: cart.claim_token });
          summary.uncertain++;
          continue;
        }
        if (!accepted?.messageId) {
          await rpc('mark_luko_cart_send_uncertain', { p_id: cart.id, p_claim: cart.claim_token });
          summary.uncertain++;
          continue;
        }
        await rpc('finish_luko_cart_recovery', { p_id: cart.id, p_claim: cart.claim_token, p_message_id: accepted.messageId });
        try {
          const { error } = await client.from('sms_messages').insert({
            telnyx_message_id: accepted.messageId,
            contact_phone: cart.contact_phone,
            direction: 'outbound',
            body: message,
            status: 'sent',
            created_at: now().toISOString()
          });
          if (error) throw error;
          await client.from('sms_contacts').update({ last_seen: now().toISOString() }).eq('phone', cart.contact_phone);
        } catch (error) {
          console.error('[CART RECOVERY] Provider accepted message but inbox mirror failed:', error.code || error.message);
        }
        summary.sent++;
      } catch { summary.uncertain++; }
    }
    return summary;
  }
  async function metrics() { return rpc('luko_cart_recovery_metrics', { p_workspace: workspace }); }
  async function markDelivery({ messageId, status, occurredAt }) {
    if (!messageId || !['sent', 'delivered', 'failed'].includes(status)) return false;
    const result = await rpc('mark_luko_cart_delivery', {
      p_message_id: messageId,
      p_status: status,
      p_occurred_at: occurredAt || now().toISOString()
    });
    if (status === 'delivered') {
      try {
        const cart = await findBy(client, workspace, 'telnyx_message_id', messageId);
        await stageCartRecoveryAttribution(client, cart);
      } catch (error) {
        console.error('[CART RECOVERY] Attribution reconciliation deferred:', error.code || error.message);
      }
    }
    return result;
  }
  return { processEvent, runDue, metrics, preflight, markDelivery };
}
module.exports = { createCartRecoveryService, normalizeEvent, DEFAULT_COPY };
