'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

const MODELS = read('ios/ViciInbox/Core/CampaignProposalModels.swift');
const API = read('ios/ViciInbox/Core/APIClient.swift');
const VIEW = read('ios/ViciInbox/UI/OffersAndProposalsView.swift');
const ASSISTANT = [
  'ios/ViciInbox/Core/AssistantBusinessDataSource.swift',
  'ios/ViciInbox/Core/AssistantBusinessModels.swift',
  'ios/ViciInbox/Core/AssistantGroundedModels.swift',
  'ios/ViciInbox/App/OnDeviceAssistantTools.swift'
].map(read).join('\n');

test('proposal read is fixed to the proposed queue and never mutates', () => {
  const proposalRead = API.slice(
    API.indexOf('func fetchProposedCampaignProposals'),
    API.indexOf('/// The aggregate-only opportunity portfolio')
  );
  assert.match(proposalRead, /func fetchProposedCampaignProposals/);
  assert.match(proposalRead, /decodedGET\("\/api\/campaign-proposals"/);
  assert.match(proposalRead, /URLQueryItem\(name: "status", value: "proposed"\)/);
  assert.match(proposalRead, /min\(50, max\(1, pageSize\)\)/);
  // ACCEPT AND DISMISS ARE NOW ALLOWED. APPROVE, SCHEDULE AND SEND ARE NOT.
  //
  // The line has moved, and it has moved to the place that matters. Accepting
  // turns a draft into a campaign in `draft` status: reviewable, editable, and
  // reaching nobody. Approving and scheduling are what put a message in front
  // of a customer, and they live on the campaign screen behind Face ID.
  //
  // Before this, the drafts were a dead end: the assistant could write four
  // and the only way to act on one was a direct HTTP call.
  for (const forbidden of [
    '/api/campaign-proposals/draft', '/approve', '/schedule', '/send'
  ]) assert.equal(proposalRead.includes(forbidden), false, `iOS proposal client must not contain ${forbidden}`);
  assert.match(proposalRead, /func acceptCampaignProposal/);
  assert.match(proposalRead, /func dismissCampaignProposal/);
});

test('the native screen may create a draft, never send, and says so honestly', () => {
  assert.match(VIEW, /session\.can\(Permission\.campaignsManage\)/);
  // The header sentence changed with the screen. What has to survive is the
  // claim that nothing on it has reached anybody, which is still true.
  assert.match(VIEW, /Every item below is an unapproved idea/);
  assert.match(VIEW, /Intentional no-offer controls/);
  assert.match(VIEW, /Structured offer proposals/);
  // No longer read-only, and the copy no longer says it is. What it does say
  // is the thing that is still true and still load-bearing.
  assert.match(VIEW, /Nothing here has been sent/);
  assert.match(VIEW, /approving and scheduling both ask for your face/);
  assert.match(VIEW, /func clear\(\)[\s\S]*?items = \[\]/);
  assert.match(VIEW, /requestLifecycle == lifecycle/);
  assert.match(VIEW, /CampaignProposalPagingPolicy\.nextPage/);
  assert.match(MODELS, /static let maximumReportedRows = 10_000/);
  assert.match(MODELS, /let completePages = total \/ pageSize/);
  assert.match(MODELS, /total % pageSize == 0/);
  assert.doesNotMatch(MODELS, /total \+ pageSize|page \* pageSize/);
  assert.doesNotMatch(VIEW, /page \* pageSize/);
  assert.doesNotMatch(VIEW, /ContentUnavailableView/);
  // The screen may accept and dismiss a DRAFT. It may not approve, schedule or
  // send anything, and there must be no button offering to.
  for (const forbiddenAction of [
    /func\s+approve/, /func\s+schedule/, /func\s+send/,
    /Button\("Approve/, /Button\("Schedule/, /Button\("Send/
  ]) assert.doesNotMatch(VIEW, forbiddenAction);
  assert.match(VIEW, /Turn into a campaign/);
  // Both buttons on every row disable together, so a double tap cannot accept
  // the same draft twice and create two campaigns.
  assert.match(VIEW, /busyProposalID/);
  assert.match(VIEW, /guard busyProposalID == nil else \{ return \}/);
});

test('decoding fails closed on malformed copy, status, offer, bounds and sensitive keys', () => {
  assert.match(MODELS, /guard status == "proposed"/);
  assert.match(MODELS, /validated, failedChecks\.isEmpty/);
  assert.match(MODELS, /appliedBy == "human_at_review"/);
  assert.match(MODELS, /statedInCopy == false/);
  assert.match(MODELS, /items\.count <= pageSize/);
  assert.match(MODELS, /static let forbiddenKeyFragments/);
  for (const fragment of ['recipient', 'phone', 'contact', 'customer', 'order', 'email', 'token']) {
    assert.ok(MODELS.includes(`"${fragment}"`), `missing sensitive-key fence: ${fragment}`);
  }
  assert.match(MODELS, /case none/);
  assert.match(MODELS, /case shippingConcession = "shipping_concession"/);
  assert.match(MODELS, /case assortmentChange = "assortment_change"/);
  assert.match(MODELS, /case monetaryDiscount = "monetary_discount"/);
});

test('any failed page purges previously loaded unapproved copy before showing an error', () => {
  const decodingCatch = VIEW.slice(
    VIEW.indexOf('} catch APIError.decoding'),
    VIEW.indexOf('func loadMore')
  );
  assert.match(decodingCatch, /purgeLoadedContent\(\)[\s\S]*?Nothing was shown/);
  assert.match(decodingCatch, /catch \{[\s\S]*?purgeLoadedContent\(\)/);
  assert.match(VIEW, /private func purgeLoadedContent\(\)[\s\S]*?items = \[\][\s\S]*?page = 0/);
});

test('proposal copy and models never enter the Assistant tool or registry boundary', () => {
  assert.equal(ASSISTANT.includes('CampaignProposal'), false);
  assert.equal(ASSISTANT.includes('/api/campaign-proposals'), false);
  assert.doesNotMatch(VIEW, /AssistantModel|AssistantBusinessContext|AssistantGroundedResponse/);
});
