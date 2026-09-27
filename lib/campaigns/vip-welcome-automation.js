'use strict';

/**
 * The one-time VIP welcome, carried by the ordinary campaign delivery rails.
 *
 * Membership remains the canonical `best_repeat_customers` segment. Its
 * `first_seen_at` is the durable moment the system first observed a customer
 * crossing into VIP. Campaign recipients are the lifetime delivery ledger, so
 * a restart or repeated sweep cannot welcome the same phone twice.
 */
const { selectIn } = require('../fetch-all-rows');
const { normalisePhone } = require('../phone');
const { loadCampaignSettings } = require('./eligibility');
// The store's send hour is one policy, not two. Importing the check-in
// resolver rather than restating 18:00 here is deliberate: a second copy of
// the hour would drift the moment one of them is changed, and both automations
// are answering the same question about the same business day.
const { nextSendTime } = require('./check-in-automation');
const { VIP_SEGMENT_KEY } = require('../vip-customers');

const WORKFLOW_CATEGORY = 'vip_welcome';
const WELCOME_DELAY_HOURS = 24;
const RECENT_CONVERSATION_GAP_HOURS = 2;
const SWEEP_INTERVAL_HOURS = 1;
const HOUR_MS = 60 * 60 * 1000;
const PAGE_SIZE = 500;

// “free” and “sale” are deliberately absent: both are blocked carrier-risk
// terms in the shared copy validator. “Included” preserves the offer without
// weakening the same gate every manually drafted campaign crosses.
//
// SECOND PERSON THROUGHOUT, on the owner's instruction of 27 Sep 2026. The
// earlier wording opened “VIP access is live for one of our most loyal
// researchers”, which describes somebody else in front of the person reading
// it. It now says what is true of them: they are the loyal customer, and their
// access is the thing that is unlocked.
//
// NO COUPON CODE IS NAMED, ON PURPOSE. The message promises a private code and
// asks them to reply for it, because Dominic is choosing that code himself. It
// deliberately does not carry {{code}}: that placeholder would oblige a
// verified WooCommerce coupon before this could ever send, and the VIP win-back
// code VICI30 is a different offer that must not leak into the welcome.
const WELCOME_MESSAGE = "Hi {{first_name}}, it's Vin from Vici. You're one of our most loyal customers, so your VIP access is unlocked: a private code, first look at new compounds, and 1:1 research support on this line 24/7. Coaching can cost thousands a month. Yours is included at no extra cost. Want your code?";

function firstName(row = {}) {
  const explicit = String(row.first_name || '').trim();
  if (explicit) return explicit;
  return String(row.name || '').trim().split(/\s+/)[0] || null;
}

async function paged(queryForPage, maxRows = 100000) {
  const rows = [];
  for (let from = 0; from < maxRows; from += PAGE_SIZE) {
    const { data, error } = await queryForPage(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
  throw Object.assign(new Error('VIP welcome scan exceeded its safe row limit.'), {
    code: 'VIP_WELCOME_SCAN_LIMIT'
  });
}

/** Recipient states that mean a welcome is still on its way out. */
const IN_FLIGHT_STATES = new Set(['pending', 'deferred', 'claimed']);

/**
 * Phones that must not be queued again, because a welcome already reached them
 * or is already on its way.
 *
 * ── A RECIPIENT ROW IS NOT A DELIVERY ────────────────────────────────────
 *
 * This counted every recipient row on every `vip_welcome` campaign, whatever
 * its state and whether the campaign was archived. The retired 101-person
 * welcome draft therefore suppressed the entire VIP population: 101 rows at
 * `state = 'draft'`, `sent_at = null`, on an archived campaign that never sent
 * anything. Measured against production, enabling the automation would have
 * queued nobody and looked like a dead feature rather than a bug.
 *
 * So "already welcomed" now means one of two things:
 *
 *   1. It was actually sent. `sent_at` is the only durable evidence of that,
 *      and it suppresses forever even if the campaign was later archived or
 *      cancelled, because the customer did receive the message.
 *
 *   2. It is in flight on a campaign that is still live. That prevents a
 *      second welcome racing the first, while an archived or cancelled
 *      campaign stops holding anybody back.
 *
 * A draft that was abandoned matches neither, which is the whole point.
 */
async function priorWelcomePhones({ client, workspaceID = 'vici' }) {
  const campaigns = await paged((from, to) => client.from('sms_campaigns')
    .select('id,status,archived_at')
    .eq('workspace_id', workspaceID)
    .eq('workflow_category', WORKFLOW_CATEGORY)
    .order('id', { ascending: true })
    .range(from, to));

  const phones = new Set();
  // One campaign at a time. A computed UUID list in `.in()` grows into the
  // request URL and is the same shape that previously took down the inbox.
  for (const campaign of campaigns) {
    const retired = Boolean(campaign.archived_at)
      || ['cancelled', 'rejected'].includes(String(campaign.status || '').toLowerCase());
    const recipients = await paged((from, to) => client.from('sms_campaign_recipients')
      .select('contact_phone,state,sent_at')
      .eq('workspace_id', workspaceID)
      .eq('campaign_id', campaign.id)
      .order('id', { ascending: true })
      .range(from, to));
    for (const row of recipients) {
      const phone = normalisePhone(row.contact_phone);
      if (!phone) continue;
      const delivered = Boolean(row.sent_at);
      const inFlight = !retired && IN_FLIGHT_STATES.has(String(row.state || '').toLowerCase());
      if (delivered || inFlight) phones.add(phone);
    }
  }
  return phones;
}

async function recentConversationTimes({ client, phones, since }) {
  const latest = new Map();
  const unique = [...new Set(phones)].filter(Boolean);
  // One indexed latest-row query per new VIP. This is a small once-per-person
  // audience and, unlike a combined `.in()` read, it cannot silently lose a
  // phone when more than 1,000 conversation rows exist inside the two-hour
  // window.
  for (const phone of unique) {
    const { data, error } = await client.from('sms_messages')
      .select('contact_phone,created_at')
      .eq('contact_phone', phone)
      .gte('created_at', since.toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    const time = Date.parse(data?.created_at || '');
    if (Number.isFinite(time)) latest.set(phone, time);
  }
  return latest;
}

/** Customers eligible to be enrolled now. Purely creates an audience; it
 * neither checks consent nor sends. Those stay in the existing approval and
 * provider fences, which re-check them at the last responsible moment. */
async function dueVIPWelcomes({
  client,
  workspaceID = 'vici',
  now = new Date(),
  welcomeDelayHours = WELCOME_DELAY_HOURS,
  conversationGapHours = RECENT_CONVERSATION_GAP_HOURS
} = {}) {
  const { data: segment, error: segmentError } = await client.from('sms_campaign_segments')
    .select('id,segment_key')
    .eq('workspace_id', workspaceID)
    .eq('segment_key', VIP_SEGMENT_KEY)
    .is('archived_at', null)
    .maybeSingle();
  if (segmentError) throw segmentError;
  if (!segment?.id) return { candidates: 0, due: [], reasons: { segment_missing: 1 } };

  const crossedBefore = new Date(now.getTime() - welcomeDelayHours * HOUR_MS).toISOString();
  const members = await paged((from, to) => client.from('sms_campaign_segment_members')
    .select('contact_phone,contact_id,contact_name_snapshot,first_seen_at,membership_source')
    .eq('workspace_id', workspaceID)
    .eq('segment_id', segment.id)
    .lte('first_seen_at', crossedBefore)
    .order('first_seen_at', { ascending: true })
    .order('contact_phone', { ascending: true })
    .range(from, to));

  const reached = await priorWelcomePhones({ client, workspaceID });
  const unseen = members.filter(row => {
    const phone = normalisePhone(row.contact_phone);
    return phone && !reached.has(phone);
  });
  const phones = unseen.map(row => normalisePhone(row.contact_phone));
  const contacts = await selectIn(client, 'sms_contacts',
    'id,phone,name,first_name,last_name', 'phone', phones);
  const contactByPhone = new Map(contacts.map(row => [normalisePhone(row.phone), row]));

  const recentCutoff = new Date(now.getTime() - conversationGapHours * HOUR_MS);
  const recent = await recentConversationTimes({ client, phones, since: recentCutoff });
  const reasons = { already_enrolled: members.length - unseen.length, recent_conversation: 0, missing_name: 0 };
  const due = [];
  for (const member of unseen) {
    const phone = normalisePhone(member.contact_phone);
    const contact = contactByPhone.get(phone) || {};
    const name = firstName(contact) || firstName({ name: member.contact_name_snapshot });
    if (!name) { reasons.missing_name += 1; continue; }
    if ((recent.get(phone) || 0) > recentCutoff.getTime()) {
      reasons.recent_conversation += 1;
      continue;
    }
    due.push({
      phone,
      contactId: Number(contact.id || member.contact_id) || null,
      name: contact.name || member.contact_name_snapshot || name,
      reason: {
        source: 'vip_welcome_automation',
        segment_key: VIP_SEGMENT_KEY,
        first_seen_at: member.first_seen_at,
        membership_source: member.membership_source || 'computed',
        delay_hours: welcomeDelayHours
      }
    });
  }
  return { candidates: members.length, due, reasons };
}

async function queuedVIPWelcomeRecipients({ client, workspaceID = 'vici' } = {}) {
  const campaigns = await paged((from, to) => client.from('sms_campaigns')
    .select('id,title,scheduled_for,status,created_at')
    .eq('workspace_id', workspaceID)
    .eq('workflow_category', WORKFLOW_CATEGORY)
    .in('status', ['scheduled', 'sending'])
    .order('scheduled_for', { ascending: true })
    .order('id', { ascending: true })
    .range(from, to));
  const output = [];
  for (const campaign of campaigns) {
    const rows = await paged((from, to) => client.from('sms_campaign_recipients')
      .select('id,campaign_id,contact_phone,contact_name_snapshot,rendered_message,planned_send_at,state')
      .eq('workspace_id', workspaceID)
      .eq('campaign_id', campaign.id)
      .eq('selected', true)
      .in('state', ['pending', 'deferred'])
      .order('planned_send_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to), 5000);
    for (const row of rows) output.push({
      id: String(row.id), campaignID: String(campaign.id),
      campaignTitle: campaign.title || 'VIP welcome',
      contactName: row.contact_name_snapshot || null,
      phone: row.contact_phone || null, message: row.rendered_message || null,
      sendAt: row.planned_send_at || campaign.scheduled_for || null, state: row.state
    });
  }
  output.sort((a, b) => String(a.sendAt || '').localeCompare(String(b.sendAt || '')));
  return output;
}

/**
 * The automation's own most recent run, for the Automations screen.
 *
 * ── A RETIRED DRAFT IS NOT A RUN ─────────────────────────────────────────
 *
 * This ignored `archived_at`, so the superseded 101-person "Welcome our Vici
 * VIP customers" draft kept presenting itself as the latest VIP welcome. The
 * owner saw a campaign he had already retired, and following it showed the old
 * wording rather than the template the automation actually sends. Archiving it
 * was supposed to take it off the screen; this is the read that kept it there.
 *
 * Only archived campaigns are excluded. A `draft` is deliberately still
 * visible, because the sweep's `draft_failed` path leaves one behind and that
 * is a failure the owner needs to see rather than have filtered away.
 */
async function latestVIPWelcomeCampaign({ client, workspaceID = 'vici' } = {}) {
  const { data, error } = await client.from('sms_campaigns')
    .select('id,title,status,created_at,scheduled_for')
    .eq('workspace_id', workspaceID)
    .eq('workflow_category', WORKFLOW_CATEGORY)
    .is('archived_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function runVIPWelcomeSweep({
  client, service, audit, now = new Date(), workspaceID = 'vici', logger = console,
  readDue = dueVIPWelcomes,
  loadSettings = loadCampaignSettings
} = {}) {
  const settings = await loadSettings(client, workspaceID);
  if (!settings?.vipWelcomeAutomationAvailable) {
    return { ran: false, reason: 'migration_required' };
  }
  if (settings.vip_welcome_automation_enabled !== true) {
    return { ran: false, reason: 'automation_disabled' };
  }

  const audience = await readDue({ client, workspaceID, now });
  if (!audience.due.length) {
    return { ran: true, reason: 'nobody_due', candidates: audience.candidates, reasons: audience.reasons };
  }

  let created;
  try {
    created = await service.create({
      title: 'Welcome new Vici VIP customers',
      message: settings.vip_welcome_message_template || WELCOME_MESSAGE,
      workflowCategory: WORKFLOW_CATEGORY,
      recipients: audience.due
    }, null);
    const id = created.campaign.id;
    await service.submitReview(id, null);
    const prepared = await service.approve(id, null);
    const proof = await audit({
      campaign: prepared.campaign,
      recipientCount: prepared.recipientCount,
      audienceHash: prepared.audienceHash,
      messageHash: prepared.messageHash
    });
    await service.finalizeApproval(id, prepared.campaign.revision, proof);
    // ── 6 PM IN THE STORE'S ZONE, NOT ONE MINUTE FROM NOW ────────────────
    //
    // This used to schedule `now + 60s`. Switching the automation on at 20:30
    // in New York would therefore have queued every welcome for 20:31, which
    // the quiet-hours fence would then have had to argue with one recipient at
    // a time, and the Automations screen would have shown a send time nobody
    // chose.
    //
    // The owner asked for the same slot the check-ins use: the next 18:00 in
    // the business timezone, which carries a two-hour lead so a sweep running
    // at 17:30 does not fire half an hour later. `nextSendTime` resolves that
    // against the real zone, so it stays correct across both daylight-saving
    // transitions rather than assuming a fixed UTC offset.
    const zone = settings.business_timezone || 'America/New_York';
    const sendAt = nextSendTime(now, zone).toISOString();
    const campaign = await service.schedule(id, sendAt, null);
    return {
      ran: true, reason: 'scheduled', campaignID: id,
      recipients: prepared.recipientCount, sendAt: campaign.scheduled_for || sendAt,
      candidates: audience.candidates, reasons: audience.reasons
    };
  } catch (error) {
    logger.error(`[VIP WELCOME] Automation could not schedule its draft: ${error.message}`);
    return {
      ran: true, reason: 'draft_failed', campaignID: created?.campaign?.id || null,
      candidates: audience.candidates, reasons: audience.reasons,
      failure: { code: error.code || null, message: error.message }
    };
  }
}

module.exports = {
  HOUR_MS,
  RECENT_CONVERSATION_GAP_HOURS,
  SWEEP_INTERVAL_HOURS,
  WELCOME_DELAY_HOURS,
  WELCOME_MESSAGE,
  WORKFLOW_CATEGORY,
  dueVIPWelcomes,
  latestVIPWelcomeCampaign,
  priorWelcomePhones,
  queuedVIPWelcomeRecipients,
  recentConversationTimes,
  runVIPWelcomeSweep
};
