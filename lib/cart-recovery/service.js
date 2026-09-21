'use strict';
const crypto = require('node:crypto');
const { normalisePhone } = require('../phone');
const { signBody, seal, unseal } = require('./security');
const { evaluateSingleRecipient, campaignLiveSendEligibility } = require('../campaigns/eligibility');
const { findBy, stageCartRecoveryAttribution, reconcileCartRecoveryFinancials,
  METHODOLOGY_VERSION } = require('./attribution');
const { LOCKED_SMS_TEMPLATE, renderSMSTemplate, validateSMSTemplate } = require('./copy');
const { classifyRecoveryReply } = require('./reply');
const { composePush, DISCOUNT_CODE } = require('./push');
const { findCouponByCode } = require('../woocommerce-coupons');
const {
  HUMAN_TEMPLATE, VOICEMAIL_TEMPLATE, HUMAN_TEMPLATE_VERSION, VOICEMAIL_TEMPLATE_VERSION,
  applyCurrentVoiceConsent, insideCallingWindow, renderVoiceScripts, voiceConfiguration
} = require('./voice');
const { createOutboundCall, hangupCall } = require('../telnyx-api');
const { MAX_CHARACTERS, listAccountVoices, speak } = require('../assistant/voice');
const { curatedRecoveryVoices } = require('./recovery-voices');
const TYPES = new Set(['consent.updated', 'cart.updated', 'cart.emptied', 'cart.clicked', 'order.created', 'order.paid', 'order.updated']);
const DEFAULT_COPY = LOCKED_SMS_TEMPLATE;
const RECOVERY_VOICE_PREVIEW_TEXT = 'Hi, this is Vin from Vici. I am calling about the items you left in your cart. I can help you complete your order.';
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
  const voiceConsentExplicit = consent.voice_marketing_consent === true && consent.ai_voice_consent === true;
  const voiceConsentGranted = consentGranted && voiceConsentExplicit
    && text(consent.version, 100) === 'vici_marketing_sms_voice_v1';
  const result = { event_id: input.event_id, event_type: input.event_type, workspace_id: workspace,
    occurred_at: occurred, customer_id: String(source.wordpress_user_id || ''), phone,
    customer_first_name: text(source.first_name, 80), customer_email: text(source.email, 320),
    phone_available: source.phone_available === true || Boolean(phone),
    push_permission: source.push_permission === true,
    customer_market: 'US',
    consent: { ...consent, granted: consentGranted,
      sms_consent: consentGranted,
      voice_marketing_consent: voiceConsentGranted,
      ai_voice_consent: voiceConsentGranted,
      occurred_at: consent.occurred_at ? iso(consent.occurred_at) : occurred } };
  if (!/^\d{1,24}$/.test(result.customer_id)) throw invalid();
  if (input.event_type === 'consent.updated') return result;
  const cart = input.cart || {};
  const externalID = String(cart.external_cart_id || input.order?.external_cart_id || '');
  if (!/^[a-zA-Z0-9:_-]{8,160}$/.test(externalID)) throw invalid();
  result.external_cart_id = externalID;
  result.version = Number(cart.version ?? cart.event_sequence ?? 0);
  if (!Number.isSafeInteger(result.version) || result.version < 0) throw invalid();
  const rawItems = Array.isArray(cart.items) ? cart.items : [];
  if (rawItems.length > 100 || rawItems.some(item => !item || !Number.isInteger(Number(item.quantity)) || Number(item.quantity) < 1 || Number(item.quantity) > 1000)) throw invalid();
  result.items = rawItems.map(item => {
    const productURL = text(item.product_url, 1000);
    if (productURL) {
      let parsed, allowed;
      try { parsed = new URL(productURL); allowed = new URL(env.LUKO_WP_URL); } catch { throw invalid(); }
      if (parsed.protocol !== 'https:' || parsed.origin !== allowed.origin || parsed.username || parsed.password) throw invalid();
    }
    const categoryIDs = Array.isArray(item.category_ids)
      ? item.category_ids.map(Number).filter(value => Number.isSafeInteger(value) && value > 0).slice(0, 100)
      : [];
    const stockQuantity = item.stock_managed === true && Number.isFinite(Number(item.stock_quantity))
      ? Number(item.stock_quantity) : null;
    return {
      product_id: Number(item.product_id) || 0,
      variation_id: Number(item.variation_id) || 0,
      quantity: Number(item.quantity),
      variation: item.variation && typeof item.variation === 'object' ? item.variation : {},
      product_name: text(item.product_name, 200),
      sku: text(item.sku, 100),
      product_url: productURL,
      category_ids: categoryIDs,
      on_sale: item.on_sale === true,
      stock_managed: item.stock_managed === true,
      stock_quantity: stockQuantity,
      stock_status: text(item.stock_status, 40)
    };
  });
  result.applied_coupons = Array.isArray(cart.applied_coupons)
    ? cart.applied_coupons.map(value => text(String(value).toLowerCase(), 100)).filter(Boolean).slice(0, 20)
    : [];
  result.click_channel = cart.click_channel === 'push' ? 'push' : 'sms';
  const clickID = text(cart.recovery_click_id, 64);
  if (clickID && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clickID)) throw invalid();
  result.recovery_click_id = clickID || null;
  result.clicked_at = cart.clicked_at ? iso(cart.clicked_at) : occurred;
  result.destination_type = ['checkout', 'exact_product', 'shop'].includes(cart.destination_type) ? cart.destination_type : null;
  result.currency = /^[A-Z]{3}$/.test(cart.currency || input.order?.currency || '') ? (cart.currency || input.order.currency) : 'USD';
  result.total = Number(cart.total || input.order?.total || 0);
  if (!Number.isFinite(result.total) || result.total < 0 || result.total > 10000000) throw invalid();
  result.last_activity_at = iso(cart.last_activity_at || occurred);
  if (Date.parse(result.last_activity_at) > now.getTime() + 300000) throw invalid();
  result.expires_at = iso(cart.expires_at || cart.recovery_expires_at || new Date(Date.parse(occurred) + 7 * 86400000).toISOString());
  if (input.event_type === 'cart.updated') {
    if (!result.version || !result.items.length) throw invalid();
    let url, allowed;
    try { url = new URL(cart.recovery_url); allowed = new URL(env.LUKO_WP_URL); } catch { throw invalid(); }
    if (url.protocol !== 'https:' || url.origin !== allowed.origin || url.username || url.password || url.search || url.hash || !/^\/r\/[A-Za-z0-9_-]{43,128}\/?$/.test(url.pathname)) throw invalid();
    result.recovery_ciphertext = seal(url.href, env.LUKO_RECOVERY_ENCRYPTION_KEY || env.LUKO_WP_SIGNING_SECRET);
  }
  if (input.event_type.startsWith('order.')) {
    const order = input.order || {};
    if (!/^\d{1,24}$/.test(String(order.order_id || ''))) throw invalid();
    const orderClickID = text(order.recovery_click_id, 64);
    if (orderClickID && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orderClickID)) throw invalid();
    const couponLines = Array.isArray(order.coupon_lines) ? order.coupon_lines.slice(0, 20).map(line => ({
      code: text(line?.code, 100).toUpperCase(), discount: Number(line?.discount) || 0,
      discount_tax: Number(line?.discount_tax) || 0
    })) : [];
    const orderItems = Array.isArray(order.items) ? order.items.slice(0, 100).map(item => ({
      product_id: Number(item?.product_id) || 0, variation_id: Number(item?.variation_id) || 0,
      quantity: Number(item?.quantity) || 0, name: text(item?.name, 200), total: Number(item?.total) || 0
    })) : [];
    result.order = { order_id: String(order.order_id), status: text(order.status, 40).toLowerCase(), total: Number(order.total), currency: text(order.currency, 3),
      paid_at: order.paid_at ? iso(order.paid_at) : null, recovery_clicked_at: order.recovery_clicked_at ? iso(order.recovery_clicked_at) : null,
      created_at: order.created_at ? iso(order.created_at) : null,
      recovery_click_id: orderClickID || null,
      recovery_channel: ['sms', 'push'].includes(order.recovery_channel) ? order.recovery_channel : null,
      attribution_method: text(order.attribution_method, 80) || null,
      attribution_strength: text(order.attribution_strength, 20) || null,
      attribution_valid: order.attribution_valid === true,
      coupon_code: order.coupon_verified === true && String(order.coupon_code || '').toUpperCase() === DISCOUNT_CODE ? DISCOUNT_CODE : null,
      coupon_verified: order.coupon_verified === true && String(order.coupon_code || '').toUpperCase() === DISCOUNT_CODE,
      coupon_lines: couponLines, items: orderItems,
      discount_total: Number(order.discount_total) || 0,
      refunded_amount: Number(order.refunded_amount) || 0,
      net_total: Number(order.net_total ?? order.total),
      financial_observed_at: occurred };
    if (!Number.isFinite(result.order.total) || result.order.total < 0 || result.order.total > 10000000
        || !Number.isFinite(result.order.discount_total) || result.order.discount_total < 0
        || !Number.isFinite(result.order.refunded_amount) || result.order.refunded_amount < 0 || result.order.refunded_amount > result.order.total
        || !Number.isFinite(result.order.net_total) || Math.abs(result.order.net_total - (result.order.total - result.order.refunded_amount)) > 0.011
        || !/^[A-Z]{3}$/.test(result.order.currency)) throw invalid();
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
  liveEligibility = campaignLiveSendEligibility,
  classifyReply = classifyRecoveryReply,
  couponLookup = findCouponByCode,
  sendCustomerPush = null,
  loadSettings = null,
  dial = createOutboundCall,
  hangup = hangupCall,
  listVoices = listAccountVoices,
  synthesizeSpeech = speak
} = {}) {
  if (!client) throw new Error('Database client required.');
  const workspace = env.LUKO_WP_STORE_ID || 'vici';
  const encryptionKey = () => env.LUKO_RECOVERY_ENCRYPTION_KEY || env.LUKO_WP_SIGNING_SECRET;
  async function rpc(name, args) {
    const { data, error } = await client.rpc(name, args);
    if (error) throw Object.assign(new Error('Recovery persistence operation failed.'), { code: error.code || 'CART_DATABASE_ERROR' });
    return data;
  }
  function actorID(actor) {
    const value = actor?.id || actor?.user_id || actor?.userId || null;
    const numeric = Number(value);
    return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
  }
  function decrypt(value) {
    if (!value) return null;
    try { return unseal(value, encryptionKey()); } catch { return null; }
  }
  function serializeSettings(row) {
    const voiceConfig = voiceConfiguration(env, row);
    const productionBlockers = [...voiceConfig.errors];
    // Provider approval is an explicit operational gate, separate from having
    // valid credentials and approved compliance copy. Keep the settings UI
    // fail-closed so it cannot describe production calling as ready while the
    // worker would still refuse every non-test number.
    if (env.LUKO_VOICE_PROVIDER_APPROVED !== 'true') productionBlockers.push('provider_approval_missing');
    // A syntactically valid number is not evidence that it answers, accepts
    // opt-outs, and updates the durable suppression list. This is verified
    // operationally before any production voicemail can be enabled.
    if (env.VICI_VOICE_OPT_OUT_HANDLER_VERIFIED !== 'true') productionBlockers.push('toll_free_opt_out_handler_unverified');
    if (env.CART_RECOVERY_VOICE_ENABLED !== 'true') productionBlockers.push('voice_worker_disabled');
    if (env.VOICE_DRY_RUN !== 'false') productionBlockers.push('voice_dry_run_enabled');
    if (row?.voice_compliance_approved !== true) productionBlockers.push('compliance_approval_missing');
    if (row?.voice_human_answer_mode === 'PRERECORDED' && row?.voice_human_timing_approved !== true) {
      productionBlockers.push('human_answer_timing_not_approved');
    }
    return {
      enabled: row?.enabled === true,
      firstSmsDelayMinutes: Number(row?.first_sms_delay_minutes) || 45,
      firstSmsTemplate: row?.first_sms_template || LOCKED_SMS_TEMPLATE,
      firstSmsTemplateLocked: row?.first_sms_template_locked !== false,
      pushEnabled: row?.push_enabled === true,
      pushDelayHours: Number(row?.push_delay_hours) || 48,
      pushTitle: row?.push_title_template || 'Still thinking about {{product_name}}?',
      pushBody: row?.push_body_template || 'Vin here. I managed to get you 15% off if you still want to go ahead. Use code {{discount_code}}.',
      discountPercent: 15,
      discountCode: DISCOUNT_CODE,
      singleProductDestination: 'exact_product',
      multiProductDestination: 'shop',
      lowStockMessagingEnabled: row?.low_stock_enabled === true,
      lowStockThreshold: Number(row?.low_stock_threshold) || 5,
      attributionWindowDays: Number(row?.attribution_window_days) || 7,
      pushShopAttributionWindowHours: Number(row?.push_shop_attribution_window_hours) || 24,
      aiClassificationEnabled: row?.ai_classification_enabled !== false,
      aiDraftRepliesEnabled: row?.ai_draft_replies_enabled !== false,
      automaticAiSending: false,
      voiceEnabled: row?.voice_enabled === true,
      voiceDelayMinutes: Number(row?.voice_delay_minutes) || 180,
      voiceAmdMode: row?.voice_amd_mode || 'premium_ios_call_screening_detection',
      voiceHumanAnswerMode: row?.voice_human_answer_mode || 'DISABLED',
      voiceId: row?.voice_id || null,
      voiceName: row?.voice_name || null,
      voiceModelId: row?.voice_model_id || 'eleven_turbo_v2_5',
      voiceHumanTemplate: row?.voice_human_template || HUMAN_TEMPLATE,
      voiceVoicemailTemplate: row?.voice_voicemail_template || VOICEMAIL_TEMPLATE,
      voiceCallingWindowStart: row?.voice_calling_window_start || '09:00',
      voiceCallingWindowEnd: row?.voice_calling_window_end || '20:00',
      voiceDefaultTimezone: row?.voice_default_timezone || 'America/New_York',
      voiceTransferNumber: row?.voice_transfer_number || null,
      voiceOptOutTollFreeNumber: row?.voice_opt_out_toll_free_number || null,
      voiceHumanTimingApproved: row?.voice_human_timing_approved === true,
      voiceComplianceApproved: row?.voice_compliance_approved === true,
      voiceConfigurationReady: voiceConfig.valid,
      voiceProductionReady: productionBlockers.length === 0,
      voiceBlockers: [...new Set(productionBlockers)]
    };
  }
  function serializeMetrics(value) {
    return {
      active: Number(value?.sms_scheduled || 0),
      queued: Number(value?.sms_scheduled || 0),
      sent: Number(value?.sms_sent || 0),
      delivered: Number(value?.sms_delivered || 0),
      clicked: Number(value?.sms_clicked || 0),
      replied: Number(value?.customer_replies || 0),
      converted: Number(value?.recovered_orders || 0),
      recoveredOrders: Number(value?.recovered_orders || 0),
      recoveredRevenue: value?.recovered_revenue || 0,
      currency: value?.currency || 'USD',
      topReasons: value?.top_abandonment_reasons || [],
      abandonedCartsIdentified: Number(value?.abandoned_carts_identified || 0),
      smsEligible: Number(value?.sms_eligible || 0),
      dryRunProposals: Number(value?.dry_run_proposals || 0),
      aiDrafts: Number(value?.ai_drafts || 0),
      pushScheduled: Number(value?.push_scheduled || 0),
      pushBlocked: Number(value?.push_blocked || 0),
      pushSent: Number(value?.push_sent || 0),
      pushClicked: Number(value?.push_clicked || 0),
      voiceEligible: Number(value?.voice_eligible || 0),
      voiceQueued: Number(value?.voice_queued || 0),
      voiceInitiated: Number(value?.voice_initiated || 0),
      voiceHumanDetected: Number(value?.voice_human_detected || 0),
      voiceVoicemailsPlayed: Number(value?.voice_voicemails_played || 0),
      voiceTransfersConnected: Number(value?.voice_transfers_connected || 0),
      voiceOptOuts: Number(value?.voice_opt_outs || 0)
    };
  }
  function serializeJourney(row, secrets = {}) {
    const items = Array.isArray(row?.cart_items) ? row.cart_items : [];
    const recovered = row?.journey_status === 'CONVERTED' || row?.attribution_status === 'recovered' || row?.status === 'recovered';
    return {
      id: String(row?.id || ''), status: row?.journey_status || 'UNKNOWN',
      customerName: row?.customer_first_name || null, firstName: row?.customer_first_name || null,
      phone: row?.contact_phone || null, phoneAvailable: Boolean(row?.contact_phone),
      smsConsent: row?.consent_granted === true,
      pushPermission: row?.customer_push_permission === true,
      identityResolutionAmbiguous: row?.identity_resolution_ambiguous === true,
      products: items,
      cartValue: row?.cart_total ?? null, currency: row?.currency || 'USD',
      lastActivityAt: row?.last_activity_at || null, primaryProduct: row?.primary_product_name || null,
      recoveryUrl: secrets.recoveryURL || null, smsQueuedAt: row?.due_at || null,
      smsContent: secrets.message || null, smsStatus: row?.sms_status || null,
      pushQueuedAt: row?.push_due_at || null,
      pushContent: row?.push_body || null, pushDestination: row?.push_destination_url || null,
      pushStatus: row?.push_status || null, pushBlockedReason: row?.push_coupon_block_reason || null,
      voiceConsent: row?.voice_marketing_consent === true && row?.ai_voice_consent === true,
      voiceQueuedAt: row?.voice_due_at || null,
      voiceStatus: row?.voice_status || null,
      voiceAttemptCount: Number(row?.voice_attempt_count || 0),
      voiceBlockedReason: row?.voice_last_failure_code || null,
      voiceTransferConnectedAt: row?.voice_transfer_connected_at || null,
      replyStatus: row?.reply_status || null, category: row?.objection_category || 'UNKNOWN',
      secondaryCategory: row?.objection_secondary_category || null,
      classificationConfidence: row?.objection_confidence == null ? null : Number(row.objection_confidence),
      aiSummary: row?.objection_summary || null, aiDraftStatus: row?.reply_status || null,
      purchaseStatus: row?.order_status || (row?.order_id ? 'created' : null),
      orderId: row?.order_id || null,
      recoveredRevenue: recovered ? (row?.net_recovered_revenue ?? row?.order_total ?? 0) : null,
      grossRecoveredRevenue: row?.gross_recovered_revenue ?? null,
      refundAmount: row?.refund_amount ?? null,
      attributionMethod: row?.attribution_method || null,
      attributionStrength: row?.attribution_strength || null,
      orderPaidAt: row?.order_paid_at || null,
      createdAt: row?.created_at || null
    };
  }
  function serializeReply(row, customerMessage = null) {
    return {
      id: String(row?.id || ''), customerMessage,
      category: row?.primary_category || 'UNKNOWN', secondaryCategory: row?.secondary_category || null,
      confidence: row?.confidence == null ? null : Number(row.confidence), summary: row?.short_summary || null,
      draft: decrypt(row?.draft_ciphertext), draftStatus: row?.draft_status || 'NONE',
      medicalEscalation: row?.medical_escalation === true, receivedAt: row?.occurred_at || null,
      sentAt: row?.sent_at || null
    };
  }
  function serializeTimeline(row) {
    const type = row?.event_type || 'EVENT';
    const metadata = row?.metadata || {};
    return { id: String(row?.id || ''), type, title: type.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, letter => letter.toUpperCase()),
      detail: metadata.reason || metadata.primary_category || null,
      orderId: metadata.order_id ? String(metadata.order_id) : null,
      attributionMethod: ['sms_recovery_link', 'push', 'voice_transfer_assisted', 'conversation_assisted', 'recovery_coupon'].includes(metadata.method) ? metadata.method : null,
      attributionStrength: ['DIRECT', 'STRONG'].includes(metadata.strength) ? metadata.strength : null,
      netRevenue: Number.isFinite(Number(metadata.net_revenue)) ? Number(metadata.net_revenue) : null,
      refundAmount: Number.isFinite(Number(metadata.refund_amount)) ? Number(metadata.refund_amount) : null,
      currency: /^[A-Z]{3}$/.test(String(metadata.currency || '')) ? metadata.currency : null,
      createdAt: row?.occurred_at || row?.created_at || null };
  }
  function serializeVoiceAttempt(row) {
    if (!row) return null;
    return {
      id: String(row.id), state: row.state, attemptNumber: Number(row.attempt_number || 0),
      dryRun: row.dry_run === true, provider: row.provider, amdMode: row.amd_mode,
      amdResult: row.amd_result || null, humanAnswerMode: row.human_answer_mode,
      voiceId: row.voice_id, voiceModelId: row.voice_model_id,
      answeredAt: row.answered_at || null, firstAudioAt: row.first_audio_at || null,
      humanAnswerDetectionLatencyMs: row.human_answer_detection_latency_ms == null ? null : Number(row.human_answer_detection_latency_ms),
      humanAnswerFirstAudioLatencyMs: row.human_answer_first_audio_latency_ms == null ? null : Number(row.human_answer_first_audio_latency_ms),
      voicemailPlayedAt: row.voicemail_played_at || null,
      humanMessagePlayedAt: row.human_message_played_at || null,
      transferRequestedAt: row.transfer_requested_at || null,
      transferConnectedAt: row.transfer_connected_at || null,
      optOutAt: row.opt_out_at || null, optOutMethod: row.opt_out_method || null,
      failureCode: row.failure_code || null, initiatedAt: row.initiated_at || null,
      completedAt: row.completed_at || null
    };
  }
  async function one(table, columns, mutate) {
    let query = client.from(table).select(columns);
    query = mutate(query);
    const { data, error } = await query.maybeSingle();
    if (error) throw Object.assign(new Error('Recovery data is unavailable.'), { code: error.code || 'CART_DATABASE_ERROR' });
    return data;
  }
  async function processEvent(input) {
    const normalized = normalizeEvent(input, env, now());
    const connectorPhone = normalized.phone;
    const identity = await rpc('resolve_luko_cart_customer_identity', {
      p_workspace: workspace,
      p_wordpress_user_id: normalized.customer_id || null,
      p_email: normalized.customer_email || null,
      p_phone: normalized.phone || null
    });
    normalized.customer_identity_id = identity?.identity_id || null;
    normalized.identity_resolution_ambiguous = identity?.ambiguous === true;
    if (identity?.ambiguous === true) {
      normalized.consent = { ...normalized.consent, granted: false, resolved_by: 'ambiguous_customer_identity' };
    } else if (identity?.contact_phone) {
      normalized.phone = identity.contact_phone;
      normalized.phone_available = true;
      // Consent evidence is bound to a specific phone. If stable identity
      // resolution selects a different established LUKO number, do not move
      // connector consent across numbers. Canonical evidence is checked below.
      if (connectorPhone && connectorPhone !== identity.contact_phone && normalized.consent.granted === true) {
        normalized.consent = { ...normalized.consent, granted: false, resolved_by: 'phone_identity_mismatch' };
      }
    }
    // A legacy Woo profile can have no connector consent record while the
    // same normalized LUKO contact already has durable opt-in evidence. Reuse
    // that evidence, but never infer consent from the phone itself.
    if (normalized.event_type !== 'consent.updated' && normalized.phone && normalized.consent.granted !== true
        && identity?.luko_contact_linked === true && identity?.ambiguous !== true) {
      const { data: consentRows, error: consentError } = await client.from('sms_consent_events')
        .select('id,event_type,source,evidence_ref,purpose,brand_id,occurred_at')
        .eq('workspace_id', workspace).eq('contact_phone', normalized.phone)
        .order('occurred_at', { ascending: false }).order('id', { ascending: false }).limit(1);
      if (consentError) throw Object.assign(new Error('Existing consent could not be resolved.'), { code: consentError.code || 'CART_DATABASE_ERROR' });
      const latest = consentRows?.[0];
      if (latest?.event_type === 'opt_in' && latest.purpose === 'promotional_sms' && latest.brand_id === workspace
          && latest.source && latest.evidence_ref) {
        normalized.consent = { ...normalized.consent, granted: true, source: latest.source,
          occurred_at: latest.occurred_at, resolved_by: 'existing_luko_consent' };
      }
    }
    // Voice consent is never inferred from SMS consent or from a stored phone.
    // Reuse only the latest durable, versioned voice event for this exact
    // number. Historical SMS-only registrations therefore remain voice=false.
    let latestVoice = null;
    if (normalized.event_type !== 'consent.updated' && normalized.phone && identity?.ambiguous !== true) {
      const { data: voiceRows, error: voiceError } = await client.from('luko_voice_consent_events')
        .select('id,event_type,voice_marketing_consent,ai_voice_consent,consent_version,occurred_at')
        .eq('workspace_id', workspace).eq('contact_phone', normalized.phone)
        .order('occurred_at', { ascending: false }).order('id', { ascending: false }).limit(1);
      if (voiceError && !['42P01', 'PGRST204', 'PGRST205'].includes(voiceError.code)) {
        throw Object.assign(new Error('Existing voice consent could not be resolved.'), { code: voiceError.code || 'CART_DATABASE_ERROR' });
      }
      latestVoice = voiceRows?.[0] || null;
      const incomingAt = Date.parse(normalized.consent.occurred_at || normalized.occurred_at);
      const durableAt = Date.parse(latestVoice?.occurred_at || '');
      // A routine cart event often repeats the original registration evidence.
      // It must never resurrect consent after a later opt-out. When durable
      // evidence is at least as recent, it is canonical for this phone.
      if (latestVoice && Number.isFinite(durableAt) && (!Number.isFinite(incomingAt) || durableAt >= incomingAt)) {
        const durableGranted = latestVoice.event_type === 'opt_in'
          && latestVoice.voice_marketing_consent === true && latestVoice.ai_voice_consent === true
          && latestVoice.consent_version === 'vici_marketing_sms_voice_v1';
        normalized.consent.voice_marketing_consent = durableGranted;
        normalized.consent.ai_voice_consent = durableGranted;
        normalized.consent.voice_consent_event_id = latestVoice.id;
        normalized.consent.voice_resolved_by = durableGranted
          ? 'existing_luko_voice_consent' : 'existing_luko_voice_opt_out';
      }
    }
    // Digest originals before encryption: retry ciphertext is randomized.
    const digest = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const result = await rpc('apply_luko_cart_event', { p_event: normalized, p_digest: digest });
    if (normalized.phone && normalized.consent.version === 'vici_marketing_sms_voice_v1'
        && normalized.consent.disclosure && normalized.consent.source) {
      const evidenceKey = crypto.createHash('sha256').update([
        workspace, normalized.phone, normalized.consent.version,
        normalized.consent.occurred_at || normalized.occurred_at,
        normalized.consent.source,
        normalized.consent.voice_marketing_consent === true ? 'opt_in' : 'opt_out'
      ].join('|')).digest('hex');
      await rpc('record_luko_voice_consent', { p_event: {
        workspace_id: workspace,
        phone: normalized.phone,
        wordpress_user_id: normalized.customer_id,
        voice_marketing_consent: normalized.consent.voice_marketing_consent === true,
        ai_voice_consent: normalized.consent.ai_voice_consent === true,
        consent_version: normalized.consent.version,
        disclosure_text: normalized.consent.disclosure,
        source: normalized.consent.source,
        source_url: normalized.consent.source_url,
        privacy_url: normalized.consent.privacy_url,
        terms_url: normalized.consent.terms_url,
        occurred_at: normalized.consent.occurred_at,
        ip_hash: normalized.consent.ip_hash,
        user_agent_hash: normalized.consent.user_agent_hash,
        evidence_ref: `wordpress-consent:${evidenceKey}`,
        dedupe_key: `wordpress-voice:${evidenceKey}`
      } });
    }
    if (['order.created', 'order.paid', 'cart.emptied'].includes(normalized.event_type)) {
      const voiceStatus = normalized.event_type === 'cart.emptied' ? 'CANCELLED_CART_CHANGED' : 'CANCELLED_PURCHASED';
      try {
        const { data: voiceRow, error: voiceLookupError } = await client.from('luko_cart_recoveries')
          .select('id,voice_call_control_id,voice_status').eq('workspace_id', workspace)
          .eq('external_cart_id', normalized.external_cart_id).maybeSingle();
        if (voiceLookupError) throw voiceLookupError;
        if (voiceRow && !['TRANSFER_CONNECTED', 'VOICE_OPT_OUT_DTMF', 'VOICE_OPT_OUT_SPOKEN'].includes(voiceRow.voice_status)) {
          await client.from('luko_cart_recoveries').update({ voice_status: voiceStatus,
            voice_claim_token: null, voice_claim_until: null, voice_completed_at: now().toISOString(),
            updated_at: now().toISOString() }).eq('id', voiceRow.id);
          await rpc('append_luko_cart_recovery_timeline', { p_recovery_id: voiceRow.id,
            p_event_type: `VOICE_${voiceStatus}`, p_occurred_at: normalized.occurred_at,
            p_metadata: { reason: normalized.event_type }, p_actor_user_id: null });
          if (voiceRow.voice_call_control_id) {
            try { await hangup(voiceRow.voice_call_control_id, crypto.randomUUID(), { env, fetchImpl }); } catch {}
          }
        }
      } catch (error) {
        if (!['42703', '42P01', 'PGRST204', 'PGRST205'].includes(error.code)) throw error;
      }
    }
    if (normalized.event_type === 'cart.clicked' && normalized.recovery_click_id) {
      await rpc('record_luko_cart_recovery_click', { p_event: normalized });
    }
    if (normalized.event_type === 'order.paid') {
      try {
        const cart = await findBy(client, workspace, 'external_cart_id', normalized.external_cart_id);
        const settings = await readSettings();
        const staged = await stageCartRecoveryAttribution(client, cart, normalized.order, settings);
        if (staged.staged && staged.record) {
          try { await stampWordPressAttribution(staged.record); }
          catch (error) { console.error('[CART RECOVERY] Woo order metadata stamp deferred:', error.code || error.message); }
        }
      } catch (error) {
        console.error('[CART RECOVERY] Attribution reconciliation deferred:', error.code || error.message);
      }
    } else if (normalized.event_type === 'order.updated') {
      try {
        const cart = await findBy(client, workspace, 'external_cart_id', normalized.external_cart_id);
        await reconcileCartRecoveryFinancials(client, cart, normalized.order);
      } catch (error) {
        console.error('[CART RECOVERY] Financial reconciliation deferred:', error.code || error.message);
      }
    }
    return result;
  }
  async function stampWordPressAttribution(record) {
    const body = JSON.stringify({
      order_id: record.order_id,
      recovery_id: record.recovery_id,
      external_cart_id: record.external_cart_id,
      attribution_method: record.attribution_method,
      attribution_strength: record.attribution_strength,
      recovery_channel: record.recovery_channel,
      message_id: record.message_id,
      push_id: record.push_id,
      voice_call_id: record.voice_call_control_id,
      recovery_click_id: record.recovery_click_id,
      coupon_code: record.coupon_code,
      attributed_at: record.order_paid_at,
      attribution_model_version: record.attribution_model_version || METHODOLOGY_VERSION
    });
    const url = new URL('/wp-json/luko/v1/order-attribution', env.LUKO_WP_URL);
    const response = await fetchImpl(url.href, { method: 'POST', redirect: 'error',
      headers: signBody(body, env.LUKO_WP_SIGNING_SECRET, Math.floor(now().getTime() / 1000)),
      body, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw Object.assign(new Error('Woo attribution metadata was not accepted.'), { code: 'WOO_ATTRIBUTION_STAMP_FAILED' });
    return response.json();
  }
  async function reconcileWooOrder(order) {
    const meta = Object.fromEntries((Array.isArray(order?.meta_data) ? order.meta_data : [])
      .filter(value => value && typeof value.key === 'string').map(value => [value.key, value.value]));
    const externalID = String(meta._luko_external_cart_id || meta._luko_recovery_cart_id || '');
    if (!externalID) return { reconciled: false, reason: 'not_cart_recovery' };
    const cart = await findBy(client, workspace, 'external_cart_id', externalID);
    if (!cart) return { reconciled: false, reason: 'episode_missing' };
    const couponLines = Array.isArray(order.coupon_lines) ? order.coupon_lines : [];
    const couponUsed = couponLines.some(line => String(line?.code || '').toUpperCase() === DISCOUNT_CODE);
    const refunded = (Array.isArray(order.refunds) ? order.refunds : [])
      .reduce((sum, refund) => sum + Math.abs(Number(refund?.total) || 0), 0);
    const paidAt = order.date_paid_gmt ? `${order.date_paid_gmt}Z` : order.date_paid || null;
    const normalizedOrder = {
      order_id: String(order.id || ''), status: String(order.status || '').toLowerCase(),
      total: Number(order.total) || 0, currency: String(order.currency || ''),
      discount_total: Number(order.discount_total) || 0, refunded_amount: refunded,
      net_total: Math.max(0, (Number(order.total) || 0) - refunded), paid_at: paidAt,
      recovery_clicked_at: meta._luko_recovery_clicked_at || null,
      recovery_click_id: meta._luko_click_id || null,
      recovery_channel: meta._luko_recovery_channel || null,
      attribution_valid: meta._luko_recovery_attribution_valid === 'yes' || ['pending', 'yes'].includes(meta._luko_attributed),
      coupon_code: couponUsed && meta._luko_coupon_code === DISCOUNT_CODE ? DISCOUNT_CODE : null,
      coupon_verified: couponUsed && meta._luko_coupon_code === DISCOUNT_CODE,
      financial_observed_at: order.date_modified_gmt ? `${order.date_modified_gmt}Z` : now().toISOString()
    };
    if (['processing', 'completed'].includes(normalizedOrder.status) && normalizedOrder.paid_at) {
      const staged = await stageCartRecoveryAttribution(client, cart, normalizedOrder, await readSettings());
      if (staged.staged && staged.record) {
        try { await stampWordPressAttribution(staged.record); } catch {}
      }
      return staged;
    }
    return reconcileCartRecoveryFinancials(client, cart, normalizedOrder);
  }
  async function preflight(cart, { requireVoice = false } = {}) {
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
    return status.request_id === requestID && status.eligible === true
      && (!requireVoice || status.current_voice_consent === true) && !status.order_id
      && status.external_cart_id === cart.external_cart_id && Number(status.version ?? status.event_sequence) === version
      && Array.isArray(status.items) && status.items.length > 0;
  }
  async function runDue() {
    if (env.CART_RECOVERY_ENABLED !== 'true') {
      return { disabled: true, claimed: 0, dryRun: 0, sent: 0, deferred: 0, uncertain: 0 };
    }
    const automationSettings = loadSettings ? await loadSettings() : await readSettings();
    if (automationSettings?.enabled !== true) {
      return { disabled: true, reason: 'automation_disabled', claimed: 0, dryRun: 0, sent: 0, deferred: 0, uncertain: 0 };
    }
    const dryRun = env.SMS_DRY_RUN !== 'false';
    const summary = { claimed: 0, dryRun: 0, sent: 0, deferred: 0, uncertain: 0 };
    const rows = await rpc('claim_luko_cart_recoveries', { p_workspace: workspace, p_limit: 20 });
    for (const cart of rows || []) {
      summary.claimed++;
      try {
        // `latestVoiceConsent` above has already proved a current signed
        // combined voice/AI consent event. GHL may not yet know a newly-created
        // Woo contact; absence there is not revocation. Explicit DND, STOP and
        // all durable suppressions remain blocking.
        const recipient = applyCurrentVoiceConsent(
          await evaluateRecipient({ client, phone: cart.contact_phone, env, workspaceID: workspace })
        );
        if (!recipient.eligible) {
          await rpc('defer_luko_cart_recovery', { p_id: cart.id, p_claim: cart.claim_token, p_reason: recipient.reason });
          summary.deferred++;
          continue;
        }
        let checked = false;
        try { checked = await preflight(cart); } catch { checked = false; }
        if (!checked) { await rpc('defer_luko_cart_recovery', { p_id: cart.id, p_claim: cart.claim_token, p_reason: 'wordpress_preflight_failed' }); summary.deferred++; continue; }
        const url = unseal(cart.recovery_ciphertext, encryptionKey());
        const cartItems = Array.isArray(cart.cart_items) ? cart.cart_items : cart.items;
        const message = renderSMSTemplate({
          template: automationSettings?.first_sms_template || automationSettings?.firstSmsTemplate || LOCKED_SMS_TEMPLATE,
          customerFirstName: cart.customer_first_name,
          items: cartItems,
          recoveryURL: url
        });
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
        const finalRecipient = await evaluateRecipient({ client, phone: cart.contact_phone, env, workspaceID: workspace });
        if (!finalRecipient.eligible) {
          await rpc('cancel_luko_cart_recovery_send', { p_id: cart.id, p_claim: cart.claim_token, p_reason: finalRecipient.reason });
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
    summary.push = await runPushDue();
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
    return result;
  }

  async function analyseAttachedReply({ replyID, text: replyText }) {
    const settings = loadSettings ? await loadSettings() : await readSettings();
    const analysis = settings.ai_classification_enabled === false
      ? { category: 'unknown', confidence: 0, summary: 'Classification is disabled.', draft: null, medical: false }
      : await classifyReply({ text: replyText, env });
    const draft = settings.ai_draft_replies_enabled !== false && analysis.draft
      ? seal(analysis.draft, encryptionKey()) : null;
    await rpc('set_luko_cart_reply_analysis', {
      p_reply_id: replyID,
      p_primary_category: String(analysis.category || 'unknown').toUpperCase(),
      p_secondary_category: analysis.secondaryCategory ? String(analysis.secondaryCategory).toUpperCase() : null,
      p_confidence: Number(analysis.confidence) || 0,
      p_summary: String(analysis.summary || 'Reply needs review.').slice(0, 300),
      p_medical_escalation: analysis.medical === true,
      p_draft_ciphertext: draft
    });
  }

  async function handleInboundReply({ phone, text: replyText, messageId, occurredAt }) {
    if (!phone || !messageId) return { attached: false, reason: 'missing_message_identity' };
    let attached;
    try {
      attached = await rpc('attach_luko_cart_recovery_reply', {
        p_workspace: workspace,
        p_phone: phone,
        p_message_id: String(messageId),
        p_occurred_at: occurredAt || now().toISOString()
      });
    } catch (error) {
      if (['42P01', 'PGRST202', 'PGRST204', 'PGRST205'].includes(error.code)) return { attached: false, reason: 'growth_migration_missing' };
      throw error;
    }
    if (!attached?.attached || !attached.reply_id) return attached || { attached: false };
    if (attached.recovery_id) {
      await rpc('mark_luko_cart_conversation', {
        p_recovery_id: attached.recovery_id,
        p_occurred_at: occurredAt || now().toISOString()
      });
    }
    void analyseAttachedReply({ replyID: attached.reply_id, text: replyText })
      .catch(error => console.error('[CART RECOVERY] Reply analysis deferred:', error.code || error.message));
    return attached;
  }

  async function handleOptOut({ phone, occurredAt }) {
    if (!phone) return false;
    try {
      return await rpc('cancel_luko_cart_recoveries_for_phone', {
        p_workspace: workspace, p_phone: phone, p_reason: 'unsubscribed',
        p_occurred_at: occurredAt || now().toISOString()
      });
    } catch (error) {
      if (['42P01', 'PGRST202', 'PGRST204', 'PGRST205'].includes(error.code)) return false;
      throw error;
    }
  }

  async function readSettings() {
    const row = await one('luko_cart_recovery_settings', '*', query => query.eq('workspace_id', workspace));
    return row || {
      workspace_id: workspace, enabled: false, first_sms_delay_minutes: 45,
      first_sms_template: LOCKED_SMS_TEMPLATE, first_sms_template_locked: false,
      push_enabled: false, push_delay_hours: 48, discount_percent: 15,
      discount_code: DISCOUNT_CODE, ai_classification_enabled: true,
      ai_draft_replies_enabled: true, automatic_ai_sending: false,
      attribution_window_days: 7, push_shop_attribution_window_hours: 24,
      voice_enabled: false, voice_delay_minutes: 180,
      voice_amd_mode: 'premium_ios_call_screening_detection', voice_human_answer_mode: 'DISABLED',
      voice_model_id: 'eleven_turbo_v2_5', voice_human_template: HUMAN_TEMPLATE,
      voice_voicemail_template: VOICEMAIL_TEMPLATE, voice_calling_window_start: '09:00',
      voice_calling_window_end: '20:00', voice_default_timezone: 'America/New_York',
      voice_max_attempts: 1, voice_cancel_on_active_conversation: true,
      voice_active_conversation_hours: 24, voice_human_timing_approved: false,
      voice_compliance_approved: false,
      market_policy: { US: { max_automated_cart_sms_per_event: 1 } }
    };
  }

  async function getSettings() { return { settings: serializeSettings(await readSettings()) }; }

  async function updateSettings({ input, actor }) {
    const source = input && typeof input === 'object' ? input : {};
    const smsTemplate = String(source.firstSmsTemplate ?? source.first_sms_template ?? LOCKED_SMS_TEMPLATE).trim();
    const templateValidation = validateSMSTemplate(smsTemplate);
    if (!templateValidation.ok) {
      throw Object.assign(new Error(templateValidation.reason), {
        status: 400,
        code: 'INVALID_CART_RECOVERY_SMS_TEMPLATE',
        publicMessage: templateValidation.reason
      });
    }
    const requestedVoiceID = String(source.voiceId ?? source.voice_id ?? '').trim();
    let authorizedVoice = null;
    if (requestedVoiceID) {
      const catalogue = curatedRecoveryVoices(await listVoices({ env, fetchImpl }));
      authorizedVoice = catalogue.find(voice => voice.id === requestedVoiceID) || null;
      if (!authorizedVoice || authorizedVoice.verified !== true) {
        throw Object.assign(new Error('Choose a voice that belongs to the connected ElevenLabs account.'), {
          status: 400, code: 'UNAUTHORIZED_RECOVERY_VOICE',
          publicMessage: 'That voice is not available in the connected ElevenLabs account.'
        });
      }
    }
    const voiceHumanTemplate = String(source.voiceHumanTemplate ?? source.voice_human_template ?? HUMAN_TEMPLATE).trim();
    const voiceVoicemailTemplate = String(source.voiceVoicemailTemplate ?? source.voice_voicemail_template ?? VOICEMAIL_TEMPLATE).trim();
    // Validate the wording with a sample opt-out number. Saving a voice choice
    // is not placing a call, so the real toll-free line is a production gate,
    // not a prerequisite for persisting settings. Runtime still renders with
    // the real line and refuses every live attempt if it is absent.
    const wantsVoiceEnabled = source.voiceEnabled === true || source.voice_enabled === true;
    if (wantsVoiceEnabled) {
      renderVoiceScripts({ firstName: 'Alex', items: [{ product_name: 'RT' }], tollFreeNumber: '+18005550123',
        humanTemplate: voiceHumanTemplate, voicemailTemplate: voiceVoicemailTemplate });
    }
    const patch = {
      workspace_id: workspace,
      enabled: source.enabled === true,
      first_sms_delay_minutes: 45,
      first_sms_template: templateValidation.template,
      first_sms_template_locked: false,
      push_enabled: source.pushEnabled === true || source.push_enabled === true,
      push_delay_hours: Math.max(1, Math.min(168, Number(source.pushDelayHours ?? source.push_delay_hours) || 48)),
      attribution_window_days: Math.max(1, Math.min(30, Number(source.attributionWindowDays ?? source.attribution_window_days) || 7)),
      push_shop_attribution_window_hours: Math.max(1, Math.min(168, Number(source.pushShopAttributionWindowHours ?? source.push_shop_attribution_window_hours) || 24)),
      push_title_template: String(source.pushTitle || source.push_title_template || source.push_title || 'Still thinking about {{product_name}}?').slice(0, 120),
      push_body_template: String(source.pushBody || source.push_body_template || source.push_body || 'Vin here. I managed to get you 15% off if you still want to go ahead. Use code {{discount_code}}.').slice(0, 300),
      discount_percent: 15,
      discount_code: DISCOUNT_CODE,
      single_product_destination: 'exact_product',
      multi_product_destination: 'shop',
      low_stock_enabled: source.lowStockMessagingEnabled === true || source.low_stock_enabled === true,
      low_stock_threshold: Math.max(1, Math.min(100, Number(source.lowStockThreshold ?? source.low_stock_threshold) || 5)),
      ai_classification_enabled: source.aiClassificationEnabled !== false && source.ai_classification_enabled !== false,
      ai_draft_replies_enabled: source.aiDraftRepliesEnabled !== false && source.ai_draft_replies_enabled !== false && source.ai_draft_enabled !== false,
      automatic_ai_sending: false,
      voice_enabled: wantsVoiceEnabled,
      voice_delay_minutes: Math.max(15, Math.min(10080, Number(source.voiceDelayMinutes ?? source.voice_delay_minutes) || 180)),
      voice_amd_mode: String((source.voiceAmdMode ?? source.voice_amd_mode) || 'premium_ios_call_screening_detection'),
      // PRERECORDED is still independently gated at runtime by measured timing
      // and compliance approval. Saving the preference cannot bypass that.
      voice_human_answer_mode: ['DISABLED', 'TRANSFER_ONLY', 'PRERECORDED'].includes(String(source.voiceHumanAnswerMode ?? source.voice_human_answer_mode))
        ? String(source.voiceHumanAnswerMode ?? source.voice_human_answer_mode) : 'DISABLED',
      voice_id: requestedVoiceID || null,
      voice_name: authorizedVoice?.name || null,
      voice_model_id: String((source.voiceModelId ?? source.voice_model_id) || 'eleven_turbo_v2_5').slice(0, 80),
      voice_human_template: voiceHumanTemplate.slice(0, 3000),
      voice_voicemail_template: voiceVoicemailTemplate.slice(0, 3000),
      voice_calling_window_start: /^\d{2}:\d{2}$/.test((source.voiceCallingWindowStart ?? source.voice_calling_window_start) || '')
        ? (source.voiceCallingWindowStart ?? source.voice_calling_window_start) : '09:00',
      voice_calling_window_end: /^\d{2}:\d{2}$/.test((source.voiceCallingWindowEnd ?? source.voice_calling_window_end) || '')
        ? (source.voiceCallingWindowEnd ?? source.voice_calling_window_end) : '20:00',
      voice_default_timezone: String((source.voiceDefaultTimezone ?? source.voice_default_timezone) || 'America/New_York').slice(0, 100),
      voice_transfer_number: String((source.voiceTransferNumber ?? source.voice_transfer_number) || '').trim() || null,
      voice_opt_out_toll_free_number: String((source.voiceOptOutTollFreeNumber ?? source.voice_opt_out_toll_free_number) || '').trim() || null,
      // Approval flags are deliberately omitted. They are ops-controlled and
      // an ordinary settings save must never clear or grant them.
      market_policy: { US: { max_automated_cart_sms_per_event: 1 } },
      updated_by: actorID(actor),
      updated_at: now().toISOString()
    };
    const { data, error } = await client.from('luko_cart_recovery_settings').upsert(patch, { onConflict: 'workspace_id' }).select('*').single();
    if (error) throw Object.assign(new Error('Recovery settings could not be updated.'), { code: error.code || 'CART_DATABASE_ERROR' });
    return { settings: serializeSettings(data) };
  }

  async function listJourneys({ query = {} } = {}) {
    const limit = Math.max(1, Math.min(100, Number(query.limit) || 30));
    let request = client.from('luko_cart_recovery_journey_list').select('*')
      .eq('workspace_id', workspace).order('last_activity_at', { ascending: false }).limit(limit);
    const status = String(query.status || '').toLowerCase();
    const statusFilters = {
      active: ['QUEUED', 'ELIGIBLE', 'SENT', 'DELIVERED', 'CLICKED'],
      replied: ['REPLIED'], blocked: ['BLOCKED'], converted: ['CONVERTED'],
      cancelled: ['CANCELLED_PURCHASED', 'CANCELLED_CART_CHANGED', 'CANCELLED_UNSUBSCRIBED']
    };
    if (status && status !== 'all') {
      if (!statusFilters[status]) throw Object.assign(new Error('Invalid journey status filter.'), { status: 400 });
      // bounded: every status group is a fixed local list with at most five values.
      request = request.in('journey_status', statusFilters[status]);
    }
    const before = query.before || query.cursor;
    if (before) request = request.lt('last_activity_at', String(before));
    const { data, error } = await request;
    if (error) throw Object.assign(new Error('Recovery journeys are unavailable.'), { code: error.code || 'CART_DATABASE_ERROR' });
    return { journeys: (data || []).map(row => serializeJourney(row)), nextCursor: data?.length === limit ? data[data.length - 1].last_activity_at : null };
  }

  async function getJourney({ id }) {
    if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) throw Object.assign(new Error('Invalid journey id.'), { status: 400 });
    const journey = await one('luko_cart_recoveries', '*', query => query.eq('workspace_id', workspace).eq('id', id));
    if (!journey) throw Object.assign(new Error('Recovery journey not found.'), { status: 404 });
    const [replyResult, timelineResult, attributionResult, voiceAttemptResult] = await Promise.all([
      client.from('luko_cart_recovery_replies').select('*').eq('recovery_id', id).order('occurred_at', { ascending: true }).limit(100),
      client.from('luko_cart_recovery_timeline').select('*').eq('recovery_id', id).order('occurred_at', { ascending: true }).limit(200),
      client.from('luko_cart_recovered_orders').select('*').eq('recovery_id', id).maybeSingle(),
      client.from('luko_cart_voice_attempts').select('*').eq('recovery_id', id)
        .order('attempt_number', { ascending: false }).limit(1).maybeSingle()
    ]);
    if (replyResult.error || timelineResult.error || attributionResult.error || voiceAttemptResult.error) throw Object.assign(new Error('Recovery journey details are unavailable.'), { code: replyResult.error?.code || timelineResult.error?.code || attributionResult.error?.code || voiceAttemptResult.error?.code || 'CART_DATABASE_ERROR' });
    const messageIDs = (replyResult.data || []).map(row => row.inbound_message_id).filter(Boolean).slice(0, 100);
    let messages = new Map();
    if (messageIDs.length) {
      // bounded: replyResult and messageIDs are both capped at 100 above.
      const { data: messageRows, error: messageError } = await client.from('sms_messages').select('id,body').in('id', messageIDs).limit(100);
      if (!messageError) messages = new Map((messageRows || []).map(row => [String(row.id), row.body]));
    }
    const recovered = attributionResult.data || {};
    return {
      journey: serializeJourney({ ...journey,
        attribution_method: recovered.attribution_method,
        attribution_strength: recovered.attribution_strength,
        gross_recovered_revenue: recovered.gross_recovered_revenue,
        refund_amount: recovered.refund_amount,
        net_recovered_revenue: recovered.net_recovered_revenue,
        order_paid_at: recovered.order_paid_at
      }, { message: decrypt(journey.message_ciphertext), recoveryURL: decrypt(journey.recovery_ciphertext) }),
      replies: (replyResult.data || []).map(reply => serializeReply(reply, messages.get(String(reply.inbound_message_id)) || null)),
      timeline: (timelineResult.data || []).map(serializeTimeline),
      voiceAttempt: serializeVoiceAttempt(voiceAttemptResult.data)
    };
  }

  async function dashboard() {
    const [summary, settings, recent] = await Promise.all([metrics(), readSettings(), listJourneys({ query: { limit: 12 } })]);
    return { metrics: serializeMetrics(summary), automation: {
      enabled: settings.enabled === true, smsDelayMinutes: Number(settings.first_sms_delay_minutes) || 45,
      pushEnabled: settings.push_enabled === true, pushDelayHours: Number(settings.push_delay_hours) || 48,
      voiceEnabled: settings.voice_enabled === true, voiceDelayMinutes: Number(settings.voice_delay_minutes) || 180
    }, recentJourneys: recent.journeys };
  }

  async function updateReplyDraft({ journeyId, replyId, input, actor }) {
    const body = String(input?.draft || input?.text || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!body || body.length > 500) throw Object.assign(new Error('Draft must be between 1 and 500 characters.'), { status: 400 });
    const reply = await one('luko_cart_recovery_replies', 'id,recovery_id,medical_escalation', query => query.eq('id', replyId).eq('recovery_id', journeyId));
    if (!reply) throw Object.assign(new Error('Reply draft not found.'), { status: 404 });
    if (reply.medical_escalation) throw Object.assign(new Error('Medical or safety replies require direct human handling.'), { status: 409 });
    const changed = await rpc('edit_luko_cart_reply_draft', { p_reply_id: replyId, p_draft_ciphertext: seal(body, encryptionKey()), p_actor_user_id: actorID(actor) });
    if (!changed) throw Object.assign(new Error('This draft can no longer be edited.'), { status: 409 });
    const updated = await one('luko_cart_recovery_replies', '*', query => query.eq('id', replyId).eq('recovery_id', journeyId));
    return { reply: serializeReply(updated) };
  }

  async function approveReplyDraft({ journeyId, replyId, actor }) {
    const reply = await one('luko_cart_recovery_replies', 'id,recovery_id,draft_ciphertext,medical_escalation', query => query.eq('id', replyId).eq('recovery_id', journeyId));
    if (!reply) throw Object.assign(new Error('Reply draft not found.'), { status: 404 });
    if (reply.medical_escalation) throw Object.assign(new Error('Medical or safety replies cannot use an AI draft.'), { status: 409 });
    const journey = await one('luko_cart_recoveries', 'id,contact_phone', query => query.eq('workspace_id', workspace).eq('id', journeyId));
    if (!journey) throw Object.assign(new Error('Recovery journey not found.'), { status: 404 });
    const message = decrypt(reply.draft_ciphertext);
    if (!message) throw Object.assign(new Error('There is no sendable draft.'), { status: 409 });
    const dryRun = env.SMS_DRY_RUN !== 'false';
    if (!dryRun) {
      const recipient = await evaluateRecipient({ client, phone: journey.contact_phone, env, workspaceID: workspace });
      if (!recipient.eligible) {
        throw Object.assign(new Error('The customer is no longer eligible to receive this reply.'), { status: 409 });
      }
    }
    const attempt = await rpc('begin_luko_cart_reply_send', { p_reply_id: replyId, p_actor_user_id: actorID(actor), p_dry_run: dryRun });
    if (!attempt?.allowed) return { reply: serializeReply(reply), allowed: false, reason: attempt?.reason };
    if (dryRun || attempt.dry_run === true) {
      const updated = await one('luko_cart_recovery_replies', '*', query => query.eq('id', replyId));
      return { reply: serializeReply(updated), dryRun: true, preview: message };
    }
    let accepted;
    try { accepted = await (send || require('../../telnyx').sendSMS)(journey.contact_phone, message); }
    catch {
      await rpc('mark_luko_cart_reply_send_uncertain', { p_reply_id: replyId });
      throw Object.assign(new Error('Send status is uncertain. Do not retry until reconciled.'), { status: 503 });
    }
    if (!accepted?.messageId) {
      await rpc('mark_luko_cart_reply_send_uncertain', { p_reply_id: replyId });
      throw Object.assign(new Error('Send status is uncertain. Do not retry until reconciled.'), { status: 503 });
    }
    await rpc('finish_luko_cart_reply_send', { p_reply_id: replyId, p_message_id: accepted.messageId });
    const { error } = await client.from('sms_messages').insert({ telnyx_message_id: accepted.messageId, contact_phone: journey.contact_phone,
      direction: 'outbound', body: message, status: 'sent', created_at: now().toISOString() });
    if (error) console.error('[CART RECOVERY] Approved reply sent but inbox mirror failed:', error.code || error.message);
    const updated = await one('luko_cart_recovery_replies', '*', query => query.eq('id', replyId));
    return { reply: serializeReply(updated), sent: true, messageId: accepted.messageId };
  }

  async function discardReplyDraft({ journeyId, replyId, actor }) {
    const reply = await one('luko_cart_recovery_replies', 'id,recovery_id', query => query.eq('id', replyId).eq('recovery_id', journeyId));
    if (!reply) throw Object.assign(new Error('Reply draft not found.'), { status: 404 });
    const changed = await rpc('discard_luko_cart_reply_draft', { p_reply_id: replyId, p_actor_user_id: actorID(actor) });
    if (!changed) throw Object.assign(new Error('This draft can no longer be discarded.'), { status: 409 });
    const updated = await one('luko_cart_recovery_replies', '*', query => query.eq('id', replyId));
    return { reply: serializeReply(updated) };
  }

  async function runPushDue() {
    if (env.CART_RECOVERY_PUSH_ENABLED !== 'true') return { disabled: true, claimed: 0, dryRun: 0, sent: 0, blocked: 0, uncertain: 0 };
    const settings = loadSettings ? await loadSettings() : await readSettings();
    if (!settings?.push_enabled) return { disabled: true, claimed: 0, dryRun: 0, sent: 0, blocked: 0, uncertain: 0 };
    const result = { claimed: 0, dryRun: 0, sent: 0, blocked: 0, uncertain: 0 };
    const dryRun = env.CART_RECOVERY_PUSH_DRY_RUN !== 'false';
    const rows = await rpc('claim_luko_cart_pushes', { p_workspace: workspace, p_limit: 20 });
    for (const cart of rows || []) {
      result.claimed++;
      const pushClaim = cart.push_claim_token;
      try {
        let checked = false;
        try { checked = await preflight(cart); } catch { checked = false; }
        if (!checked) {
          await rpc('mark_luko_cart_push_blocked', { p_id: cart.id, p_claim: pushClaim, p_reason: 'wordpress_preflight_failed' });
          result.blocked++;
          continue;
        }
        const coupon = await couponLookup(DISCOUNT_CODE);
        const recoveryURL = unseal(cart.recovery_ciphertext, encryptionKey());
        const pushCart = { ...cart, total: cart.cart_total, applied_coupons: cart.cart_applied_coupons,
          items: Array.isArray(cart.cart_items) ? cart.cart_items : cart.items };
        const proposal = composePush({ cart: pushCart, coupon, storeURL: env.LUKO_WP_URL,
          recoveryURL, requireChannel: !dryRun,
          scarcityEnabled: settings.low_stock_enabled === true, scarcityThreshold: settings.low_stock_threshold,
          titleTemplate: settings.push_title_template, bodyTemplate: settings.push_body_template, now: now() });
        if (!proposal.eligible) {
          await rpc('mark_luko_cart_push_blocked', { p_id: cart.id, p_claim: pushClaim, p_reason: proposal.reason || 'push_ineligible' });
          result.blocked++;
          continue;
        }
        const attempt = await rpc('begin_luko_cart_push', { p_id: cart.id, p_claim: pushClaim,
          p_dry_run: dryRun,
          p_discount_verified: true, p_destination_type: pushCart.items?.length === 1 ? 'exact_product' : 'shop',
          p_destination_url: proposal.destination || null, p_title: proposal.title || null, p_body: proposal.body || null });
        if (!attempt?.allowed) { result.blocked++; continue; }
        if (dryRun) {
          await rpc('finish_luko_cart_push', { p_id: cart.id, p_claim: pushClaim, p_provider_message_id: null, p_dry_run: true });
          result.dryRun++;
          continue;
        }
        if (typeof sendCustomerPush !== 'function') {
          await rpc('mark_luko_cart_push_blocked', { p_id: cart.id, p_claim: pushClaim, p_reason: 'customer_push_sender_unavailable' });
          result.blocked++;
          continue;
        }
        let finalCheck = false;
        try { finalCheck = await preflight(cart); } catch { finalCheck = false; }
        if (!finalCheck) {
          await rpc('mark_luko_cart_push_blocked', { p_id: cart.id, p_claim: pushClaim, p_reason: 'final_wordpress_preflight_failed' });
          result.blocked++;
          continue;
        }
        const confirmed = await rpc('confirm_luko_cart_push_send', { p_id: cart.id, p_claim: pushClaim });
        if (!confirmed?.allowed) {
          await rpc('mark_luko_cart_push_blocked', { p_id: cart.id, p_claim: pushClaim,
            p_reason: confirmed?.reason || 'state_changed' });
          result.blocked++;
          continue;
        }
        let accepted;
        try { accepted = await sendCustomerPush({ destinationID: confirmed.customer_push_destination_id, ...proposal }); }
        catch {
          await rpc('mark_luko_cart_push_send_uncertain', { p_id: cart.id, p_claim: pushClaim });
          result.uncertain++;
          continue;
        }
        if (!accepted?.messageId) {
          await rpc('mark_luko_cart_push_send_uncertain', { p_id: cart.id, p_claim: pushClaim });
          result.uncertain++;
          continue;
        }
        await rpc('finish_luko_cart_push', { p_id: cart.id, p_claim: pushClaim, p_provider_message_id: accepted.messageId, p_dry_run: false });
        result.sent++;
      } catch (error) {
        console.error('[CART RECOVERY] Push processing deferred:', error.code || error.message);
        result.uncertain++;
      }
    }
    return result;
  }

  async function hasActiveConversation(cart, settings) {
    if (settings.voice_cancel_on_active_conversation === false) return false;
    const hours = Math.max(1, Math.min(168, Number(settings.voice_active_conversation_hours) || 24));
    const since = new Date(now().getTime() - hours * 3600000).toISOString();
    const { data, error } = await client.from('luko_cart_recovery_replies').select('id')
      .eq('recovery_id', cart.id).gte('occurred_at', since).limit(1);
    if (error) throw Object.assign(new Error('Conversation state is unavailable.'), { code: error.code || 'CART_DATABASE_ERROR' });
    return Boolean(data?.length);
  }

  async function latestVoiceConsent(phone) {
    const { data, error } = await client.from('luko_voice_consent_events')
      .select('id,event_type,voice_marketing_consent,ai_voice_consent,consent_version,occurred_at')
      .eq('workspace_id', workspace).eq('contact_phone', phone)
      .order('occurred_at', { ascending: false }).order('id', { ascending: false }).limit(1);
    if (error) throw Object.assign(new Error('Voice consent evidence is unavailable.'), { code: error.code || 'CART_DATABASE_ERROR' });
    const row = data?.[0];
    return row?.event_type === 'opt_in' && row.voice_marketing_consent === true
      && row.ai_voice_consent === true && row.consent_version === 'vici_marketing_sms_voice_v1' ? row : null;
  }

  async function listRecoveryVoices() {
    const voices = await listVoices({ env, fetchImpl });
    return { voices: curatedRecoveryVoices(voices),
      authorizationBoundary: 'connected_elevenlabs_account_curated_us_voices' };
  }

  async function previewRecoveryVoice({ voiceID } = {}) {
    const requested = String(voiceID || '');
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(requested)) {
      throw Object.assign(new Error('Choose a voice from the Vin voice list and try again.'), {
        code: 'INVALID_RECOVERY_VOICE', status: 400
      });
    }
    const catalogue = await listRecoveryVoices();
    const voice = catalogue.voices.find(candidate => candidate.id === requested);
    if (!voice) {
      throw Object.assign(new Error('That voice is no longer available. Choose another Vin voice and try again.'), {
        code: 'INVALID_RECOVERY_VOICE', status: 404
      });
    }
    const result = await synthesizeSpeech({
      text: RECOVERY_VOICE_PREVIEW_TEXT,
      voiceID: voice.id,
      env,
      fetchImpl
    });
    if (!Buffer.isBuffer(result?.audio) || result.audio.length === 0) {
      throw Object.assign(new Error('The voice preview could not be produced. Try again in a moment.'), {
        code: 'RECOVERY_VOICE_PREVIEW_FAILED', status: 502
      });
    }
    return {
      audio: result.audio,
      contentType: result.contentType || 'audio/mpeg',
      voice: { id: voice.id, name: voice.name }
    };
  }

  async function previewRecoveryAttempt({ journeyId, branch } = {}) {
    if (!/^[0-9a-f-]{36}$/i.test(String(journeyId || '')) || !['human', 'voicemail'].includes(branch)) {
      throw Object.assign(new Error('Choose a recovery journey and message to preview.'), {
        code: 'INVALID_RECOVERY_VOICE_PREVIEW', status: 400
      });
    }
    const attempt = await one('luko_cart_voice_attempts',
      'id,voice_id,voice_model_id,rendered_human_text,rendered_voicemail_text,human_message_played_at,voicemail_played_at,dry_run',
      query => query.eq('workspace_id', workspace).eq('recovery_id', journeyId)
        .order('attempt_number', { ascending: false }).limit(1));
    if (!attempt || attempt.dry_run === true ||
        (branch === 'human' && !attempt.human_message_played_at) ||
        (branch === 'voicemail' && !attempt.voicemail_played_at)) {
      throw Object.assign(new Error('No delivered message is available for this journey yet.'), {
        code: 'INVALID_RECOVERY_VOICE_PREVIEW', status: 404
      });
    }
    const voices = curatedRecoveryVoices(await listVoices({ env, fetchImpl }));
    if (!voices.some(voice => voice.id === attempt.voice_id)) {
      throw Object.assign(new Error('The voice used for this message is no longer available.'), {
        code: 'INVALID_RECOVERY_VOICE_PREVIEW', status: 404
      });
    }
    // This is a fresh rendering of the historically saved script, never a
    // recording of the customer call. Its branch and voice are fixed by the
    // persisted attempt; the client cannot submit arbitrary speech.
    const spoken = branch === 'human' ? attempt.rendered_human_text : attempt.rendered_voicemail_text;
    if (!spoken || spoken.length > MAX_CHARACTERS) {
      throw Object.assign(new Error('This saved message is too long to preview accurately.'), {
        code: 'INVALID_RECOVERY_VOICE_PREVIEW', status: 409
      });
    }
    const result = await synthesizeSpeech({ text: spoken, voiceID: attempt.voice_id,
      env: { ...env, ELEVENLABS_MODEL: attempt.voice_model_id }, fetchImpl });
    if (!Buffer.isBuffer(result?.audio) || result.audio.length === 0) {
      throw Object.assign(new Error('The message preview could not be produced. Try again later.'), {
        code: 'RECOVERY_VOICE_PREVIEW_FAILED', status: 502
      });
    }
    return { audio: result.audio, contentType: result.contentType || 'audio/mpeg',
      attemptId: attempt.id, branch };
  }

  async function runVoiceDue() {
    if (env.CART_RECOVERY_VOICE_ENABLED !== 'true') {
      return { disabled: true, claimed: 0, dryRun: 0, initiated: 0, deferred: 0, blocked: 0, uncertain: 0 };
    }
    const settings = loadSettings ? await loadSettings() : await readSettings();
    if (settings?.voice_enabled !== true) {
      return { disabled: true, reason: 'automation_disabled', claimed: 0, dryRun: 0, initiated: 0, deferred: 0, blocked: 0, uncertain: 0 };
    }
    const dryRun = env.VOICE_DRY_RUN !== 'false';
    const summary = { claimed: 0, dryRun: 0, initiated: 0, deferred: 0, blocked: 0, uncertain: 0 };
    const rows = await rpc('claim_luko_cart_voice_calls', { p_workspace: workspace, p_limit: 20 });
    for (const cart of rows || []) {
      summary.claimed++;
      const claim = cart.voice_claim_token;
      try {
        const consent = await latestVoiceConsent(cart.contact_phone);
        if (!consent) {
          await rpc('defer_luko_cart_voice_call', { p_id: cart.id, p_claim: claim,
            p_status: 'BLOCKED_NO_CONSENT', p_reason: 'voice_consent_not_current', p_due_at: null });
          summary.blocked++;
          continue;
        }
        const recipient = await evaluateRecipient({ client, phone: cart.contact_phone, env, workspaceID: workspace });
        if (!recipient.eligible) {
          await rpc('defer_luko_cart_voice_call', { p_id: cart.id, p_claim: claim,
            p_status: 'BLOCKED_SUPPRESSED', p_reason: recipient.reason || 'dnc', p_due_at: null });
          summary.blocked++;
          continue;
        }
        if (await hasActiveConversation(cart, settings)) {
          await rpc('defer_luko_cart_voice_call', { p_id: cart.id, p_claim: claim,
            p_status: 'CANCELLED_ACTIVE_CONVERSATION', p_reason: 'active_human_sms_conversation', p_due_at: null });
          summary.deferred++;
          continue;
        }
        const timeZone = cart.customer_timezone || settings.voice_default_timezone || 'America/New_York';
        if (!insideCallingWindow({ now: now(), timeZone, start: settings.voice_calling_window_start, end: settings.voice_calling_window_end })) {
          const retryAt = new Date(now().getTime() + 30 * 60000).toISOString();
          await rpc('defer_luko_cart_voice_call', { p_id: cart.id, p_claim: claim,
            p_status: 'DEFERRED_CALLING_WINDOW', p_reason: 'outside_calling_window', p_due_at: retryAt });
          summary.deferred++;
          continue;
        }
        const configuration = voiceConfiguration(env, settings);
        if (!configuration.valid) {
          await rpc('defer_luko_cart_voice_call', { p_id: cart.id, p_claim: claim,
            p_status: 'BLOCKED_CONFIGURATION', p_reason: configuration.errors.join(','), p_due_at: null });
          summary.blocked++;
          continue;
        }
        let checked = false;
        try { checked = await preflight(cart, { requireVoice: true }); } catch { checked = false; }
        if (!checked) {
          await rpc('defer_luko_cart_voice_call', { p_id: cart.id, p_claim: claim,
            p_status: 'CANCELLED_CART_CHANGED', p_reason: 'wordpress_preflight_failed', p_due_at: null });
          summary.deferred++;
          continue;
        }
        const scripts = renderVoiceScripts({ firstName: cart.customer_first_name,
          items: cart.cart_items, tollFreeNumber: configuration.tollFreeNumber,
          humanTemplate: settings.voice_human_template, voicemailTemplate: settings.voice_voicemail_template });
        const humanMode = settings.voice_human_answer_mode === 'PRERECORDED'
          && settings.voice_human_timing_approved === true && settings.voice_compliance_approved === true
          ? 'PRERECORDED' : (settings.voice_human_answer_mode === 'TRANSFER_ONLY' ? 'TRANSFER_ONLY' : 'DISABLED');
        const commandID = crypto.randomUUID();
        const attempt = await rpc('begin_luko_cart_voice_call', { p_id: cart.id, p_claim: claim, p_attempt: {
          dry_run: dryRun, amd_mode: configuration.amdMode, human_answer_mode: humanMode,
          voice_id: configuration.voiceID, voice_model_id: configuration.modelID,
          human_template_version: HUMAN_TEMPLATE_VERSION, voicemail_template_version: VOICEMAIL_TEMPLATE_VERSION,
          rendered_human_text: scripts.human, rendered_voicemail_text: scripts.voicemail,
          consent_event_id: consent.id, provider_command_id: commandID
        } });
        if (!attempt?.allowed) { summary.deferred++; continue; }
        if (attempt.dry_run === true) { summary.dryRun++; continue; }

        // Production is a separate, fail-closed gate. Saving settings cannot
        // authorize spend or customer contact.
        const testNumbers = new Set(String(env.VOICE_TEST_NUMBERS || '').split(',').map(value => normalisePhone(value.trim())).filter(Boolean));
        const productionAllowed = env.LUKO_VOICE_PROVIDER_APPROVED === 'true'
          && env.VICI_VOICE_OPT_OUT_HANDLER_VERIFIED === 'true'
          && settings.voice_compliance_approved === true;
        if (env.VICI_VOICE_OPT_OUT_HANDLER_VERIFIED !== 'true'
            || (!productionAllowed && !testNumbers.has(cart.contact_phone))) {
          await rpc('defer_luko_cart_voice_call', { p_id: cart.id, p_claim: claim,
            p_status: 'BLOCKED_CONFIGURATION', p_reason: 'production_voice_not_approved', p_due_at: null });
          summary.blocked++;
          continue;
        }
        let finalCheck = false;
        try { finalCheck = await preflight(cart, { requireVoice: true }); } catch { finalCheck = false; }
        if (!finalCheck) {
          await rpc('defer_luko_cart_voice_call', { p_id: cart.id, p_claim: claim,
            p_status: 'CANCELLED_PURCHASED', p_reason: 'final_wordpress_preflight_failed', p_due_at: null });
          summary.deferred++;
          continue;
        }
        const clientState = Buffer.from(JSON.stringify({ kind: 'cart_recovery_voice', recovery_id: cart.id,
          attempt_id: attempt.attempt_id })).toString('base64');
        let accepted;
        try {
          accepted = await dial({ to: cart.contact_phone, from: env.TELNYX_PHONE_NUMBER,
            connectionId: env.TELNYX_CONNECTION_ID, webhookUrl: new URL('/webhooks/voice', env.APP_URL).href,
            amdMode: configuration.amdMode, clientState, commandId: commandID }, { env, fetchImpl });
        } catch (error) {
          await rpc('defer_luko_cart_voice_call', { p_id: cart.id, p_claim: claim,
            p_status: 'RECONCILIATION_REQUIRED', p_reason: error.code || 'provider_boundary_uncertain', p_due_at: null });
          summary.uncertain++;
          continue;
        }
        const providerCall = accepted?.data || accepted;
        if (!providerCall?.call_control_id) {
          await rpc('defer_luko_cart_voice_call', { p_id: cart.id, p_claim: claim,
            p_status: 'RECONCILIATION_REQUIRED', p_reason: 'missing_call_control_id', p_due_at: null });
          summary.uncertain++;
          continue;
        }
        const dialPersisted = await rpc('finish_luko_cart_voice_dial', { p_id: cart.id, p_claim: claim,
          p_attempt_id: attempt.attempt_id, p_call_control_id: providerCall.call_control_id,
          p_call_session_id: providerCall.call_session_id || '', p_call_leg_id: providerCall.call_leg_id || '' });
        if (dialPersisted !== true) {
          // Consent, suppression, purchase, or claim state may have changed
          // across the provider boundary. Never leave an untracked call live.
          try { await hangup(providerCall.call_control_id, crypto.randomUUID(), { env, fetchImpl }); } catch {}
          summary.uncertain++;
          continue;
        }
        summary.initiated++;
      } catch (error) {
        console.error('[CART RECOVERY] Voice processing deferred:', error.code || error.message);
        try { await rpc('defer_luko_cart_voice_call', { p_id: cart.id, p_claim: claim,
          p_status: 'FAILED', p_reason: error.code || 'voice_processing_failed', p_due_at: null }); } catch {}
        summary.uncertain++;
      }
    }
    return summary;
  }

  return { processEvent, runDue, runPushDue, runVoiceDue, listRecoveryVoices, previewRecoveryVoice, previewRecoveryAttempt, metrics, preflight, markDelivery, handleInboundReply, handleOptOut, reconcileWooOrder,
    dashboard, listJourneys, getJourney, getSettings, updateSettings, updateReplyDraft,
    approveReplyDraft, discardReplyDraft };
}
module.exports = { createCartRecoveryService, normalizeEvent, DEFAULT_COPY, RECOVERY_VOICE_PREVIEW_TEXT };
