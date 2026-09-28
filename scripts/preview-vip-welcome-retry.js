'use strict';

// Read-only production evidence. No drafts, approvals, schedules or SMS writes.
// Prints aggregate results only; customer identities and message bodies stay private.
require('dotenv').config({ quiet: true });
const { supabase } = require('../db');
const { fetchAllRows } = require('../lib/fetch-all-rows');
const { gatherFacts } = require('../lib/campaigns/personalise');
const { render } = require('../lib/campaigns/merge-fields');
const { validateCopy } = require('../lib/campaigns/copy-validator');
const { WELCOME_MESSAGE } = require('../lib/campaigns/vip-welcome-automation');

const FAILED_BATCHES = new Set([
  '0b2f6970-4a82-4138-9865-ec89a960fa2d',
  'd1066ccb-b496-46bf-819d-c4614a77fab2',
  '5c4550d6-da4a-4218-93fd-ebd04ee32ee0'
]);

async function loadRetryAudience(supabase) {
  const welcomes = await fetchAllRows(supabase, 'sms_campaigns', 'id', {
    filter: query => query.eq('workspace_id', 'vici').eq('workflow_category', 'vip_welcome'),
    maxRows: 50000
  });
  const welcomeIDs = new Set(welcomes.map(row => row.id));
  const rows = await fetchAllRows(supabase, 'sms_campaign_recipients',
    'id,campaign_id,contact_phone,state', {
      filter: query => query.eq('workspace_id', 'vici'), maxRows: 50000
    });
  const original = rows.filter(row => FAILED_BATCHES.has(row.campaign_id));
  const failed = new Set(original.filter(row => row.state === 'failed').map(row => row.contact_phone));
  // Later successful sends or queued retries must never get another welcome.
  const protectedPhones = new Set(rows.filter(row =>
    ['sent', 'delivered', 'pending', 'claimed', 'deferred'].includes(row.state)
    && welcomeIDs.has(row.campaign_id)
    && !FAILED_BATCHES.has(row.campaign_id)).map(row => row.contact_phone));
  const phones = [...failed].filter(phone => !protectedPhones.has(phone));
  const facts = await gatherFacts({ client: supabase, phones });
  return { original, failed, phones, facts };
}

async function main() {
  const { original, failed, phones, facts } = await loadRetryAudience(supabase);
  const months = {};
  let renderable = 0;
  let invalid = 0;
  let maxSeptets = 0;
  for (const phone of phones) {
    const person = facts.get(phone);
    const output = render(WELCOME_MESSAGE, person);
    const verdict = validateCopy(output.text, { requireOptOut: false });
    if (output.missing.length || !verdict.ok) { invalid++; continue; }
    renderable++;
    maxSeptets = Math.max(maxSeptets, verdict.septets);
    const since = render('{{loyalty_since}}', person).text;
    months[since] = (months[since] || 0) + 1;
  }
  console.log(JSON.stringify({
    readOnly: true, originalStates: original.reduce((out, row) => {
      out[row.state] = (out[row.state] || 0) + 1; return out;
    }, {}), failedUnique: failed.size, excludedAlreadySentOrQueued: failed.size - phones.length,
    renderable, invalid, maxSeptets, loyaltyMonths: months,
    note: 'Current consent, suppression, cadence and audited approval still required before scheduling.'
  }, null, 2));
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { loadRetryAudience };
