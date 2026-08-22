'use strict';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const DEFAULT_POLICY = Object.freeze({
  minimumSpacingHours: 24,
  rollingWeekLimit: 2,
  rollingMonthDays: 30,
  rollingMonthLimit: 4
});

function asTime(value) {
  if (value instanceof Date) return value.getTime();
  return Date.parse(value);
}

function acceptedPromotionalTimes(entries = []) {
  const seen = new Set();
  const times = [];
  for (const entry of entries) {
    if (entry?.classification !== 'promotional') continue;
    const id = String(entry.idempotencyKey || entry.providerMessageID || entry.id || '');
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    const time = asTime(entry.acceptedAt || entry.sentAt);
    if (Number.isFinite(time)) times.push(time);
  }
  return times.sort((a, b) => a - b);
}

function consentCoversCampaign(consent, { brand, useCase } = {}) {
  if (!String(brand || '').trim() || !String(useCase || '').trim()) return false;
  if (consent?.status !== 'active' || consent?.scope !== 'promotional') return false;
  if (!String(consent?.source || '').trim() || !String(consent?.evidenceReference || '').trim()) return false;
  if (!Number.isFinite(asTime(consent?.collectedAt))) return false;
  if (brand && consent?.brand !== brand) return false;
  if (useCase && !Array.isArray(consent?.useCases)) return false;
  if (useCase && !consent.useCases.includes(useCase)) return false;
  return true;
}

function providerCoversCampaign(provider, { campaignType, now }) {
  if (!String(campaignType || '').trim()) return false;
  if (provider?.status !== 'active') return false;
  if (provider?.bindingConfirmed !== true || provider?.copyScopeApproved !== true) return false;
  const reviewedAt = asTime(provider?.reviewedAt);
  if (!Number.isFinite(reviewedAt) || !String(provider?.evidenceReference || '').trim()) return false;
  const expiry = provider?.expiresAt ? asTime(provider.expiresAt) : null;
  if (expiry !== null && (!Number.isFinite(expiry) || expiry <= now)) return false;
  if (!Array.isArray(provider?.permittedCampaignTypes)) return false;
  return provider.permittedCampaignTypes.includes(campaignType);
}

function evaluatePromotionalCadence({
  now = new Date(),
  campaignType,
  brand,
  useCase,
  consent,
  providerEligibility,
  tenantLiveSendEnabled = false,
  runtimeLiveSendEnabled = false,
  legalRulesAllow = false,
  quietHoursAllow = false,
  optedOut = false,
  dnd = false,
  pendingRevocation = false,
  internalOrTestIdentity = false,
  explicitTestCampaign = false,
  recentCommercialContacts = [],
  policy = DEFAULT_POLICY
} = {}) {
  const nowTime = asTime(now);
  if (!Number.isFinite(nowTime)) throw new Error('now must be a valid date.');
  const hardReasons = [];
  if (!tenantLiveSendEnabled) hardReasons.push('tenant_live_send_disabled');
  if (!runtimeLiveSendEnabled) hardReasons.push('runtime_live_send_disabled');
  if (!providerCoversCampaign(providerEligibility, { campaignType, now: nowTime })) hardReasons.push('provider_eligibility_required');
  if (!consentCoversCampaign(consent, { brand, useCase })) hardReasons.push('promotional_consent_required');
  if (optedOut) hardReasons.push('opted_out');
  if (dnd) hardReasons.push('dnd');
  if (pendingRevocation) hardReasons.push('revocation_pending_review');
  if (!legalRulesAllow) hardReasons.push('legal_rule_not_confirmed');
  if (!quietHoursAllow) hardReasons.push('quiet_hours_block');
  if (internalOrTestIdentity && !explicitTestCampaign) hardReasons.push('internal_or_test_identity');

  const contacts = acceptedPromotionalTimes(recentCommercialContacts).filter(time => time <= nowTime);
  const requestedPolicy = {
    minimumSpacingHours: Number(policy.minimumSpacingHours ?? DEFAULT_POLICY.minimumSpacingHours),
    rollingWeekLimit: Number(policy.rollingWeekLimit ?? DEFAULT_POLICY.rollingWeekLimit),
    rollingMonthDays: Number(policy.rollingMonthDays ?? DEFAULT_POLICY.rollingMonthDays),
    rollingMonthLimit: Number(policy.rollingMonthLimit ?? DEFAULT_POLICY.rollingMonthLimit)
  };
  const policyValid = Number.isFinite(requestedPolicy.minimumSpacingHours) && requestedPolicy.minimumSpacingHours >= 0 &&
    Number.isInteger(requestedPolicy.rollingWeekLimit) && requestedPolicy.rollingWeekLimit > 0 &&
    Number.isInteger(requestedPolicy.rollingMonthDays) && requestedPolicy.rollingMonthDays > 0 &&
    Number.isInteger(requestedPolicy.rollingMonthLimit) && requestedPolicy.rollingMonthLimit > 0;
  if (!policyValid) hardReasons.push('frequency_policy_invalid');
  const effectivePolicy = policyValid ? requestedPolicy : DEFAULT_POLICY;
  const spacingMs = effectivePolicy.minimumSpacingHours * HOUR_MS;
  const weekLimit = effectivePolicy.rollingWeekLimit;
  const monthDays = effectivePolicy.rollingMonthDays;
  const monthLimit = effectivePolicy.rollingMonthLimit;
  const cadenceReasons = [];
  const nextCandidates = [];
  const latest = contacts.at(-1);
  if (Number.isFinite(latest) && latest + spacingMs > nowTime) {
    cadenceReasons.push('minimum_spacing');
    nextCandidates.push(latest + spacingMs);
  }

  const weekly = contacts.filter(time => time > nowTime - 7 * DAY_MS);
  if (weekly.length >= weekLimit) {
    cadenceReasons.push('rolling_week_cap');
    nextCandidates.push(weekly[weekly.length - weekLimit] + 7 * DAY_MS);
  }
  const monthly = contacts.filter(time => time > nowTime - monthDays * DAY_MS);
  if (monthly.length >= monthLimit) {
    cadenceReasons.push('rolling_month_cap');
    nextCandidates.push(monthly[monthly.length - monthLimit] + monthDays * DAY_MS);
  }

  const reasons = [...new Set([...hardReasons, ...cadenceReasons])];
  return {
    allowed: reasons.length === 0,
    hardBlocked: hardReasons.length > 0,
    deferOnly: hardReasons.length === 0 && cadenceReasons.length > 0,
    reasons,
    nextEligibleContactAt: nextCandidates.length ? new Date(Math.max(...nextCandidates)).toISOString() : null,
    counts: { rollingWeek: weekly.length, rollingMonth: monthly.length },
    policy: effectivePolicy
  };
}

module.exports = {
  DEFAULT_POLICY,
  acceptedPromotionalTimes,
  consentCoversCampaign,
  evaluatePromotionalCadence,
  providerCoversCampaign
};
