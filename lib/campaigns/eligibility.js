'use strict';

const { normalisePhone } = require('../phone');
const { isExcludedIdentity } = require('../analytics/exclusions');

const WORKSPACE_ID = 'vici';
const LIVE_ENV_FLAG = 'CAMPAIGNS_LIVE_SEND_ENABLED';

function latestConsent(events = [], { purpose = 'promotional_sms', brandID = WORKSPACE_ID } = {}) {
  return [...events]
    .filter(event => event && ['opt_in', 'opt_out'].includes(event.event_type) &&
      (event.event_type === 'opt_out' || (
        event.purpose === purpose && event.brand_id === brandID &&
        typeof event.source === 'string' && event.source.trim() &&
        typeof event.evidence_ref === 'string' && event.evidence_ref.trim()
      )) &&
      typeof event.occurred_at === 'string' && Number.isFinite(Date.parse(event.occurred_at)))
    .sort((a, b) => {
      const time = Date.parse(b.occurred_at || 0) - Date.parse(a.occurred_at || 0);
      if (time !== 0) return time;
      return Number(b.id || 0) - Number(a.id || 0);
    })[0] || null;
}

/**
 * Pure, deterministic recipient decision used by previews and tests. The SQL
 * claim RPC repeats the same safety checks at send time, because a preview is
 * never authority to send later.
 */
function evaluateRecipient({
  phone,
  contactOptedOut = false,
  optOutSentinel = false,
  contactDnd = null,
  smsDndStatus = null,
  dndSyncedAt = null,
  dndMaxAgeHours = 24,
  now = new Date(),
  consentEvents = [],
  consentEvidenceRequired = true,
  exclusions = { phones: new Set(), orderIDs: new Set() },
  authoritativeSuppressionReason = null
} = {}) {
  const normalised = normalisePhone(phone);
  if (!normalised) return { eligible: false, phone: null, reason: 'invalid_phone' };
  if (isExcludedIdentity({ phone: normalised }, exclusions)) {
    return { eligible: false, phone: normalised, reason: 'internal_or_test_identity' };
  }
  if (authoritativeSuppressionReason) {
    return { eligible: false, phone: normalised, reason: authoritativeSuppressionReason };
  }
  if (contactOptedOut || optOutSentinel) {
    return { eligible: false, phone: normalised, reason: 'opted_out' };
  }

  const consent = latestConsent(consentEvents);
  if (consent?.event_type === 'opt_out') {
    return { eligible: false, phone: normalised, reason: 'opted_out' };
  }
  const dndStatus = String(smsDndStatus || '').toLowerCase();
  if (contactDnd === true || ['active', 'permanent'].includes(dndStatus)) {
    return { eligible: false, phone: normalised, reason: 'dnd' };
  }
  const nowTime = now instanceof Date ? now.getTime() : Date.parse(now);
  const syncedTime = Date.parse(dndSyncedAt);
  const maxAgeMs = Number(dndMaxAgeHours) * 60 * 60 * 1000;
  // AN EXPLICIT `false` WITH NO CHANNEL OVERRIDE IS AN ANSWER, NOT A SHRUG.
  //
  // This used to require an explicit per-channel SMS status of 'inactive' as
  // well as the global flag. GoHighLevel returns `dndSettings` as the set of
  // per-channel OVERRIDES, so an empty object means "no override, the global
  // flag applies". Measured across the whole account: 929 contacts, every one
  // `dnd: false`, not a single one with channel settings.
  //
  // So the stricter rule could never be satisfied by this data. Every contact
  // read as `dnd_unknown` and a campaign targeting five hundred people would
  // have sent to nobody, which looks like a broken campaign rather than a
  // safety check doing its job.
  //
  // What has NOT changed: `dnd: true` and a channel status of 'active' or
  // 'permanent' are still refused above, a missing or non-boolean flag is still
  // unknown, and a stale timestamp is still unknown. This widens what counts as
  // a complete answer; it does not weaken what counts as a refusal.
  const channelSaysContactable = dndStatus === 'inactive' || dndStatus === '';
  if (contactDnd !== false || !channelSaysContactable || !Number.isFinite(nowTime)
      || !Number.isFinite(syncedTime) || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0
      || syncedTime < nowTime - maxAgeMs || syncedTime > nowTime) {
    return { eligible: false, phone: normalised, reason: 'dnd_unknown' };
  }

  if (consentEvidenceRequired && consent?.event_type !== 'opt_in') {
    return { eligible: false, phone: normalised, reason: 'consent_not_recorded' };
  }
  return {
    eligible: true,
    phone: normalised,
    reason: 'eligible',
    consentSource: consent?.source || null,
    consentAt: consent?.occurred_at || null
  };
}

function activeSuppressionReason(rows = [], now = new Date()) {
  const nowTime = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(nowTime)) return 'authoritative_suppression_unknown';
  const active = (rows || []).find(row => {
    const effective = Date.parse(row?.effective_at);
    const expires = row?.expires_at == null ? null : Date.parse(row.expires_at);
    return row?.active === true && Number.isFinite(effective) && effective <= nowTime &&
      (expires === null || (Number.isFinite(expires) && expires > nowTime));
  });
  if (!active) return null;
  return ['internal_identity', 'test_identity'].includes(active.reason_code)
    ? 'internal_or_test_identity'
    : 'authoritative_suppression';
}

/** Both an explicit environment switch and workspace DB approval are needed. */
function liveSendEligibility(settings, env = process.env) {
  const reasons = [];
  if (env[LIVE_ENV_FLAG] !== 'true') reasons.push('environment_gate_disabled');
  if (!settings) reasons.push('campaign_settings_missing');
  if (settings && settings.provider_approved !== true) reasons.push('provider_not_approved');
  if (settings && settings.live_send_enabled !== true) reasons.push('workspace_live_send_disabled');
  return { allowed: reasons.length === 0, reasons };
}

async function loadCampaignSettings(client, workspaceID = WORKSPACE_ID) {
  const { data, error } = await client
    .from('sms_campaign_settings')
    // EVERY column any caller reads has to be named here. This is an explicit
    // list, not select('*'), so a column added to the table and to a reader is
    // still invisible until it is added HERE — and the symptom is not an
    // error, it is `undefined`, which reads as false.
    //
    // checkin_automation_enabled was missing exactly that way: the migration
    // was applied, the toggle wrote true to the database, and the sweep still
    // saw `automation_disabled` while the app's switch snapped back to Off.
    .select('workspace_id, drafts_enabled, provider_approved, live_send_enabled, consent_evidence_required, business_timezone, quiet_hours_start, quiet_hours_end, max_recipients_per_campaign, dnd_status_max_age_hours, checkin_automation_enabled')
    .eq('workspace_id', workspaceID)
    .maybeSingle();
  if (error) {
    const missing = ['42P01', 'PGRST202', 'PGRST204', 'PGRST205'].includes(error.code);
    throw Object.assign(new Error(missing
      ? 'Campaigns are unavailable until the additive database migration is applied.'
      : 'Campaign settings could not be loaded.'), {
      code: missing ? 'CAMPAIGNS_NOT_READY' : 'CAMPAIGN_SETTINGS_LOAD_FAILED',
      status: missing ? 503 : 500
    });
  }
  return data || null;
}

async function campaignLiveSendEligibility({
  client,
  env = process.env,
  workspaceID = WORKSPACE_ID,
  skipDatabaseWhenEnvironmentDisabled = true
}) {
  // The environment switch is the outermost brake. Avoid touching the DB when
  // it is off so a missing migration can never accidentally fall through.
  if (skipDatabaseWhenEnvironmentDisabled && env[LIVE_ENV_FLAG] !== 'true') {
    return { allowed: false, reasons: ['environment_gate_disabled'] };
  }
  const settings = await loadCampaignSettings(client, workspaceID);
  return liveSendEligibility(settings, env);
}

async function evaluateSingleRecipient({
  client,
  phone,
  env = process.env,
  workspaceID = WORKSPACE_ID
}) {
  const normalised = normalisePhone(phone);
  if (!normalised) return evaluateRecipient({ phone });
  const settings = await loadCampaignSettings(client, workspaceID);
  if (!settings) return { eligible: false, phone: normalised, reason: 'campaign_settings_missing' };

  const [contactResult, sentinelResult, consentResult, suppressionResult] = await Promise.all([
    client.from('sms_contacts').select('phone, opted_out, ghl_dnd, ghl_sms_dnd_status, ghl_dnd_synced_at').eq('phone', normalised).maybeSingle(),
    client.from('sms_sent_log').select('id').eq('phone', normalised).eq('flow_type', 'opted-out').limit(1),
    client.from('sms_consent_events').select('id, event_type, source, evidence_ref, purpose, brand_id, occurred_at')
      .eq('workspace_id', workspaceID).eq('brand_id', workspaceID)
      .eq('purpose', 'promotional_sms').eq('contact_phone', normalised)
      .order('occurred_at', { ascending: false }).order('id', { ascending: false }).limit(1),
    client.from('sms_campaign_suppressions').select('reason_code, active, effective_at, expires_at')
      .eq('workspace_id', workspaceID).eq('contact_phone', normalised).eq('active', true).limit(50)
  ]);
  const error = contactResult.error || sentinelResult.error || consentResult.error || suppressionResult.error;
  if (error) return { eligible: false, phone: normalised, reason: 'eligibility_check_failed' };

  return evaluateRecipient({
    phone: normalised,
    contactOptedOut: contactResult.data?.opted_out === true,
    contactDnd: contactResult.data?.ghl_dnd,
    smsDndStatus: contactResult.data?.ghl_sms_dnd_status,
    dndSyncedAt: contactResult.data?.ghl_dnd_synced_at,
    dndMaxAgeHours: settings.dnd_status_max_age_hours,
    optOutSentinel: Boolean(sentinelResult.data?.length),
    consentEvents: consentResult.data || [],
    consentEvidenceRequired: settings.consent_evidence_required !== false,
    authoritativeSuppressionReason: activeSuppressionReason(suppressionResult.data || [])
  });
}

module.exports = {
  LIVE_ENV_FLAG,
  WORKSPACE_ID,
  activeSuppressionReason,
  campaignLiveSendEligibility,
  evaluateRecipient,
  evaluateSingleRecipient,
  latestConsent,
  liveSendEligibility,
  loadCampaignSettings
};
