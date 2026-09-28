'use strict';

// Owner-authorized retry of confirmed failures ONLY. Never directly calls Telnyx
// send. Uses ordinary audited approval, immutable rendering and scheduling rails.
// Run only AFTER the matching Railway release is healthy. No past-time fallback.
require('dotenv').config({ quiet: true });
const { supabase } = require('../db');
const { loadRetryAudience } = require('./preview-vip-welcome-retry');
const { createCampaignService } = require('../lib/campaigns/service');
const { WELCOME_MESSAGE } = require('../lib/campaigns/vip-welcome-automation');
const { syncVIPBenefitCoupon } = require('../lib/vip-benefit-coupon');
const { render } = require('../lib/campaigns/merge-fields');
const { logAudit } = require('../lib/audit/log');

const TITLE = 'VIP welcome retry: 28 September 2026';
const SEND_AT = '2026-09-28T22:00:00.000Z';

async function main() {
  const service = createCampaignService({ client: supabase, env: process.env });
  const { phones, facts } = await loadRetryAudience(supabase);
  if (!process.argv.includes('--schedule')) {
    const first = phones.find(phone => !render(WELCOME_MESSAGE, facts.get(phone)).missing.length);
    console.log(JSON.stringify({ readOnly: true, failedCandidates: phones.length,
      example: first ? render(WELCOME_MESSAGE, facts.get(first)).text : null, sendAt: SEND_AT }));
    return;
  }
  if (process.env.VIP_RETRY_APPROVED !== 'YES') throw new Error('Explicit VIP_RETRY_APPROVED=YES is required.');
  if (Date.now() >= Date.parse(SEND_AT)) throw new Error('The approved send time has passed. Ask for a new date, never send immediately.');
  const response = await fetch('https://api.telnyx.com/v2/10dlc/phone_number_campaigns/%2B19177254009', {
    headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` }, signal: AbortSignal.timeout(15000)
  });
  const assignment = await response.json();
  if (!response.ok || assignment.assignmentStatus !== 'ASSIGNED'
      || assignment.campaignId !== '4b30019d-e41f-7293-475b-9bdf7ac114ef'
      || assignment.tmobileNumberMappingStatus !== 'ADDED'
      || assignment.nonTmobileNumberMappingStatus !== 'ADDED') throw new Error('VIP sender registration is not ready. Nothing scheduled.');
  await syncVIPBenefitCoupon({ client: supabase });
  const { data: existing, error } = await supabase.from('sms_campaigns')
    .select('id,status,scheduled_for').eq('workspace_id', 'vici').eq('title', TITLE).maybeSingle();
  if (error) throw error;
  if (existing) {
    console.log(JSON.stringify({ existing: true, ...existing, note: 'No duplicate retry was created.' }));
    return;
  }
  const recipients = phones.filter(phone => facts.get(phone)?.email
    && !render(WELCOME_MESSAGE, facts.get(phone)).missing.length)
    .map(phone => ({ phone, name: facts.get(phone).contactName, reason: { source: 'owner_approved_failed_vip_retry' } }));
  const { campaign } = await service.create({ title: TITLE, message: WELCOME_MESSAGE,
    workflowCategory: 'vip_welcome', recipients }, null);
  const preview = await service.dryRun(campaign.id);
  const blocked = new Set(preview.recipients.filter(person => !person.eligible).map(person => person.phone));
  const audience = await service.recipients(campaign.id, { pageSize: 100 });
  // This approved retry has 102 candidates, so page explicitly rather than
  // silently treating the service's 100-row page as the whole audience.
  const second = await service.recipients(campaign.id, { page: 2, pageSize: 100 });
  for (const row of [...audience.items, ...second.items]) {
    if (blocked.has(row.contact_phone)) await service.deselectRecipient(campaign.id, row.id, null);
  }
  if (!preview.eligible) throw new Error(`No currently eligible recipients. Draft ${campaign.id} retained for review.`);
  await service.submitReview(campaign.id, null);
  const prepared = await service.approve(campaign.id, null);
  const fingerprint = `campaign-approved:${campaign.id}:${prepared.campaign.revision}`;
  const proof = await logAudit({ eventType: 'campaign.approved', actorType: 'user',
    entityId: campaign.id, summary: 'Owner-approved retry of failed VIP welcomes',
    metadata: { revision: prepared.campaign.revision, recipient_count: prepared.recipientCount,
      audience_digest: prepared.audienceHash, message_digest: prepared.messageHash }, fingerprint });
  if (!proof.recorded && proof.reason !== 'duplicate') throw new Error('Approval audit was not recorded. Nothing scheduled.');
  await service.finalizeApproval(campaign.id, prepared.campaign.revision, { ...proof, fingerprint });
  const scheduled = await service.schedule(campaign.id, SEND_AT, null);
  const saved = await supabase.from('sms_campaign_settings').update({
    vip_welcome_message_template: WELCOME_MESSAGE, updated_at: new Date().toISOString()
  }).eq('workspace_id', 'vici');
  if (saved.error) throw saved.error;
  console.log(JSON.stringify({ campaignID: campaign.id, status: scheduled.status,
    scheduledFor: scheduled.scheduled_for, eligible: preview.eligible,
    excluded: preview.suppressed, reasons: preview.reasons, templateUpdated: true }));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
