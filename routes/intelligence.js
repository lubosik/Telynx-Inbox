const router = require('express').Router();
const { supabase, insertSmsMessage } = require('../db');
const { analyseConversation, generateCampaignBrief } = require('../intelligence');
const { sendSMS } = require('../telnyx');
const { isOptedOut } = require('../flows/utils');
const { broadcast } = require('../lib/broadcaster');
const { normaliseTelnyxStatus } = require('../lib/message-status');
const { logAuditSafely } = require('../lib/audit/log');
const { messageFingerprint } = require('../lib/audit/redact');
const {
  campaignLiveSendEligibility,
  evaluateSingleRecipient
} = require('../lib/campaigns/eligibility');

router.get('/campaigns/overview', async (req, res) => {
  try {
    const brief = await generateCampaignBrief();
    res.json(brief);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/campaigns/all', async (req, res) => {
  const { status } = req.query;
  let query = supabase.from('sms_campaign_suggestions').select('*')
    .order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);
  const { data } = await query;
  res.json(data || []);
});

router.post('/campaigns/:id/dismiss', async (req, res) => {
  try {
    const { data: dismissed, error } = await supabase
      .from('sms_campaign_suggestions')
      .update({ status: 'dismissed' })
      .eq('id', req.params.id)
      .select('id, contact_phone, suggestion_type, status')
      .maybeSingle();
    // PostgREST reports failure in `error`, never as a rejection, so this has
    // to be checked rather than relied upon to throw.
    if (error) throw Object.assign(new Error(error.message), { code: error.code });
    if (!dismissed) return res.status(404).json({ error: 'Not found', code: 'SUGGESTION_NOT_FOUND' });

    await logAuditSafely({
      eventType: 'campaign.suggestion.dismissed',
      req,
      entityId: dismissed.id,
      contactPhone: dismissed.contact_phone || null,
      summary: `Dismissed the ${dismissed.suggestion_type || 'campaign'} suggestion for ${dismissed.contact_phone || 'an unknown contact'}`,
      previousState: { status: 'pending' },
      newState: { status: 'dismissed' },
      metadata: { suggestion_id: dismissed.id, suggestion_type: dismissed.suggestion_type || null }
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[INTELLIGENCE] Dismiss failed:', err?.code || err?.message || 'internal_error');
    res.status(500).json({ error: 'That suggestion could not be dismissed.', code: 'SUGGESTION_DISMISS_FAILED' });
  }
});

router.post('/campaigns/:id/send', async (req, res) => {
  try {
    // This legacy one-contact suggestion path still sends immediately. It must
    // not become a bypass around the new Campaign approval/provider brakes.
    const live = await campaignLiveSendEligibility({ client: supabase });
    if (!live.allowed) {
      return res.status(409).json({
        error: 'Live campaign sending is disabled pending explicit provider approval.',
        code: 'CAMPAIGN_LIVE_SEND_DISABLED'
      });
    }

    const { data: suggestion, error: suggestionError } = await supabase
      .from('sms_campaign_suggestions').select('*').eq('id', req.params.id).maybeSingle();
    if (suggestionError) throw suggestionError;
    if (!suggestion) return res.status(404).json({ error: 'Not found', code: 'SUGGESTION_NOT_FOUND' });

    const recipient = await evaluateSingleRecipient({ client: supabase, phone: suggestion.contact_phone });
    if (!recipient.eligible) {
      return res.status(403).json({
        error: 'This recipient does not have current send eligibility.',
        code: 'CAMPAIGN_RECIPIENT_SUPPRESSED',
        reason: recipient.reason
      });
    }
    if (await isOptedOut(suggestion.contact_phone)) {
      return res.status(403).json({ error: 'This contact opted out of messages' });
    }
    const { messageId, status: providerStatus } = await sendSMS(suggestion.contact_phone, suggestion.suggested_message);
    const inserted = await insertSmsMessage({
      telnyx_message_id: messageId,
      contact_phone: suggestion.contact_phone,
      direction: 'outbound',
      body: suggestion.suggested_message,
      status: normaliseTelnyxStatus(providerStatus)
    });
    await supabase.from('sms_campaign_suggestions')
      .update({ status: 'sent' }).eq('id', req.params.id);
    await supabase.from('sms_contacts').upsert({
      phone: suggestion.contact_phone,
      last_seen: new Date().toISOString()
    }, { onConflict: 'phone' });
    broadcast({
      type: 'new_message',
      phone: suggestion.contact_phone,
      body: suggestion.suggested_message,
      direction: 'outbound',
      id: inserted?.id || null,
      telnyx_message_id: messageId
    });

    // The SMS has already gone out by this point, so this is safe-logged: an
    // audit failure must not produce a 500 that invites a second send. The
    // drafted body is referenced by length and digest, never copied.
    await logAuditSafely({
      eventType: 'campaign.suggestion.sent',
      req,
      entityId: suggestion.id,
      contactPhone: suggestion.contact_phone,
      summary: `Approved and sent the ${suggestion.suggestion_type || 'campaign'} suggestion to ${suggestion.contact_phone}`,
      previousState: { status: suggestion.status || 'pending' },
      newState: { status: 'sent' },
      metadata: {
        suggestion_id: suggestion.id,
        suggestion_type: suggestion.suggestion_type || null,
        ...messageFingerprint(suggestion.suggested_message)
      }
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[INTELLIGENCE] Suggestion send failed:', err?.code || 'internal_error');
    res.status(500).json({ error: 'That suggestion could not be sent.', code: 'SUGGESTION_SEND_FAILED' });
  }
});

router.post('/analyse/:phone', async (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  try {
    const result = await analyseConversation(phone);
    res.json({ success: true, profile: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:phone', async (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  const { data: profile } = await supabase
    .from('sms_customer_profiles').select('*').eq('contact_phone', phone).maybeSingle();
  const { data: suggestions } = await supabase
    .from('sms_campaign_suggestions').select('*')
    .eq('contact_phone', phone).eq('status', 'pending').order('created_at', { ascending: false });
  res.json({ profile: profile || null, suggestions: suggestions || [] });
});

module.exports = router;
