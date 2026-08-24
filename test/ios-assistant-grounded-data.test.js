'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

const MODELS = read('ios/ViciInbox/Core/AssistantBusinessModels.swift');
const SOURCE = read('ios/ViciInbox/Core/AssistantBusinessDataSource.swift');
const EVIDENCE = read('ios/ViciInbox/Core/AssistantEvidenceRegistry.swift');
const API = read('ios/ViciInbox/Core/APIClient.swift');
const PROJECT = read('ios/ViciInbox.xcodeproj/project.pbxproj');
const GROUNDED = read('ios/ViciInbox/Core/AssistantGroundedModels.swift');
const TOOLS = read('ios/ViciInbox/App/OnDeviceAssistantTools.swift');
const MODEL = read('ios/ViciInbox/App/AssistantModel.swift');
const VIEW = read('ios/ViciInbox/UI/AssistantView.swift');
const ROUTER = read('ios/ViciInbox/App/AppRouter.swift');
const PROMPT = read('ios/ViciInbox/Core/AssistantPromptCatalog.swift');
const crypto = require('node:crypto');

test('assistant business facade is read-only, bounded, and uses existing permissions', () => {
  assert.match(SOURCE, /protocol AssistantBusinessAPI: Sendable/);
  for (const call of [
    'fetchAnalyticsOverview', 'fetchAttributions', 'fetchAssistantAuditSummary',
    'fetchActivityStats', 'fetchSegments', 'fetchSegment', 'fetchSegmentMember',
    'fetchSegmentMemberships', 'fetchCampaigns', 'fetchCampaignReviewCount',
    'fetchCampaignPerformance', 'fetchAssistantOpportunityPortfolio', 'fetchReferrals'
  ]) assert.ok(SOURCE.includes(call), `missing read: ${call}`);

  for (const forbidden of [
    '/api/send', '/api/upload', '/api/react', 'createCampaign', 'approveCampaign',
    'scheduleCampaign', 'cancelScheduledMessage', 'createReferral', 'claimReferral',
    'reassignReferral', 'resolveReferral', 'fetchConversation'
  ]) assert.equal(SOURCE.includes(forbidden), false, `write or content surface: ${forbidden}`);

  assert.match(SOURCE, /min\(25, max\(1, pageSize\)\)/);
  assert.match(SOURCE, /min\(20, max\(1, pageSize\)\)/);
  assert.match(SOURCE, /min\(50, max\(1, limit\)\)/);
  assert.match(API, /fetchAssistantOpportunityPortfolio[\s\S]*?name: "refresh", value: "false"/);
  assert.match(API, /fetchAssistantAuditSummary[\s\S]*?"\/api\/audit\/summary"/);
  assert.doesNotMatch(SOURCE, /fetchAudit\(/);
});

test('model-visible DTOs exclude human and customer prose and identity', () => {
  for (const forbiddenDeclaration of [
    /let\s+contactName\b/, /let\s+memberName\b/, /let\s+segmentName\b/,
    /let\s+actorName\b/, /let\s+title\b/, /let\s+detail\b/,
    /let\s+summary\b/, /let\s+phone\b/,
    /let\s+referredByName\b/, /let\s+ownerName\b/, /let\s+orderID\b/,
    /let\s+attributionID\b/, /let\s+campaignID\b/
  ]) assert.doesNotMatch(MODELS, forbiddenDeclaration, String(forbiddenDeclaration));

  for (const forbidden of [
    'proposedMessage', 'finalMessage', 'initialNote', 'messageBody',
    'previousState', 'newState', 'userAgent', 'contactPhone'
  ]) assert.equal(MODELS.includes(forbidden), false, `unsafe DTO field: ${forbidden}`);

  assert.match(SOURCE, /if automatic \{[\s\S]*?automaticFacts/);
  assert.match(SOURCE, /else \{\s*facts = \[\]/);
  assert.doesNotMatch(SOURCE, /\.evidence\.facts/);
  assert.doesNotMatch(SOURCE, /safeExplanation.*(?:note|purpose)/i);
});

test('authoritative empty is structurally distinct from every failure', () => {
  assert.match(MODELS, /enum AssistantBusinessOutcome<Value>/);
  assert.match(MODELS, /case available\(AssistantVerifiedBusinessData<Value>\)/);
  assert.match(MODELS, /case unavailable\(AssistantBusinessFailure\)/);
  assert.match(MODELS, /let isAuthoritativeEmpty: Bool/);
  for (const kind of ['sessionExpired', 'permissionDenied', 'notFound', 'notReady', 'unavailable']) {
    assert.ok(MODELS.includes(`case ${kind}`), `missing failure kind ${kind}`);
  }
  assert.match(SOURCE, /status == 403 \{ return \.permissionDenied \}/);
  assert.match(SOURCE, /status == 404 \{ return \.notFound \}/);
  assert.match(SOURCE, /status == 503[\s\S]*?\.notReady/);
  assert.match(API, /case server\(String, statusCode: Int\? = nil, code: String\? = nil\)/);
});

test('evidence is private, bounded, generation-fenced, and cancellation-aware', () => {
  assert.match(EVIDENCE, /actor AssistantEvidenceRegistry/);
  assert.match(EVIDENCE, /static let maximumReferences = 200/);
  assert.match(EVIDENCE, /static let maximumReferencesPerRequest = 40/);
  assert.match(EVIDENCE, /capacityExceeded/);
  assert.doesNotMatch(EVIDENCE, /evictIfNeeded/);
  assert.match(EVIDENCE, /generation: AssistantEvidenceGeneration/);
  assert.match(EVIDENCE, /try Task\.checkCancellation\(\)/);
  assert.match(EVIDENCE, /guard generation == activeGeneration else/);
  assert.match(EVIDENCE, /activeGeneration = AssistantEvidenceGeneration\(value: UUID\(\)\)/);
  assert.match(SOURCE, /generation: AssistantEvidenceGeneration/);
  assert.match(SOURCE, /let activeBeforeRead = await evidence\.generation\(\)/);
  assert.match(SOURCE, /guard generation == activeBeforeRead else/);
  assert.match(SOURCE, /guard generation == activeGeneration else/);
  const registrations = (SOURCE.match(/evidence\.register\(/g) || []).length;
  const fences = (SOURCE.match(/requiredPermission: \.[A-Za-z]+,\s*generation: generation/g) || []).length;
  assert.ok(registrations >= 10);
  assert.equal(fences, registrations, 'every registration requires the captured generation');
  assert.doesNotMatch(EVIDENCE, /UserDefaults|FileManager|Logger|ViciLog/);
  assert.match(EVIDENCE, /beginGeneration[\s\S]*?without deleting citations/);
  assert.match(EVIDENCE, /func discard\(_ generation/);
  assert.match(EVIDENCE, /func commit\(_ generation/);
  assert.match(EVIDENCE, /retaining tokens: Set<AssistantEvidenceToken>/);
  assert.match(EVIDENCE, /func clear\(\)/);
  assert.match(TOOLS, /discardGroundedRequest\(generation\)/);
  assert.match(TOOLS, /commitGroundedRequest/);
  assert.match(TOOLS, /lifecycleSequence == resetSequence/);
  assert.match(MODEL, /AssistantTranscriptPolicy\.maximumVisibleExchanges/);
  assert.match(MODEL, /businessReasoning\.releaseEvidence/);
});

test('Xcode 26 tool surface is fixed, read-only, and model output carries no data', () => {
  assert.match(TOOLS, /private struct AssistantFixedReadTool: Tool/);
  assert.match(TOOLS, /@Generable\s+struct Arguments/);
  assert.match(TOOLS, /\.anyOf\(\["read"\]\)/);
  assert.match(TOOLS, /let operation: @Sendable \(\) async throws -> Void/);
  assert.match(TOOLS, /return "Verified data captured\."/);
  assert.match(TOOLS, /LanguageModelSession\(model: model, tools: \[tool\]\)/);
  assert.doesNotMatch(TOOLS, /DynamicProfile|AppIntent|PrivateCloudCompute/);
  assert.doesNotMatch(TOOLS, /return\s+(?:snapshot|record|reference|claims|token)/);
  assert.doesNotMatch(TOOLS, /\b(?:post|patch|put|delete)\s*\(/i);
});

test('deterministic renderer selects exact aggregate claims and ignores model prose', () => {
  assert.match(GROUNDED, /_ = modelText/);
  assert.match(GROUNDED, /reference\.scope == scope/);
  assert.match(GROUNDED, /guard matches\.count == 1/);
  assert.match(GROUNDED, /AssistantEvidenceCitation\(label: label, token: reference\.token\)/);
  assert.match(GROUNDED, /reference\.scope == \.record/);
  assert.match(MODELS, /enum AssistantEvidenceScope[\s\S]*?case aggregate[\s\S]*?case record/);
  assert.doesNotMatch(GROUNDED, /modelText\.(?:contains|split|components)|sanitise\(modelText/);
});

test('every supported figure gets a reviewed citation routed to its actual evidence screen', () => {
  for (const label of [
    'Recovered revenue', 'Influenced revenue',
    'Activity event count', 'Activity warning count', 'Pending automations',
    'Saved segment count', 'Campaign count', 'Campaign review count',
    'Opportunity finding count', 'Actionable finding count',
    'Unresolved referral count', 'Referrals needing attention'
  ]) assert.ok(GROUNDED.includes(`"${label}"`), `missing reviewed citation: ${label}`);
  assert.match(SOURCE, /analytics:revenue:[\s\S]*?destination: \.analyticsAttributions/);
  assert.doesNotMatch(SOURCE, /analytics:messaging:[\s\S]*?destination: \.inbox/);
  assert.doesNotMatch(SOURCE, /analytics:calls:[\s\S]*?destination: \.calls/);
  assert.match(SOURCE, /opportunity_count[\s\S]*?destination: \.opportunities/);
  assert.match(SOURCE, /automation_pending[\s\S]*?destination: \.automations/);
  assert.match(GROUNDED, /case \.automations:[\s\S]*?return \.growth\(\.automations\)/);
  assert.match(GROUNDED, /case \.opportunities:[\s\S]*?return \.opportunities/);
  assert.match(VIEW, /Label\(citation\.label/);
  assert.equal(VIEW.includes('Open evidence \\(index'), false);
});

test('analytics availability and incomplete source warnings suppress unsupported totals', () => {
  assert.match(SOURCE, /AssistantAnalyticsClaimPolicy\.allowedFamilies/);
  assert.match(SOURCE, /allowedFamilies\.contains\(\.revenue\)/);
  assert.doesNotMatch(SOURCE, /allowedFamilies\.contains\(\.messaging\)/);
  assert.doesNotMatch(SOURCE, /allowedFamilies\.contains\(\.calls\)/);
  assert.match(MODELS, /guard !warningCodes\.contains\(where: isIncomplete\) else \{ return \[\] \}/);
  for (const marker of ['TRUNCATED', 'PARTIAL', 'INCOMPLETE', 'UNKNOWN']) {
    assert.ok(MODELS.includes(`"${marker}"`), `missing incomplete marker ${marker}`);
  }
});

test('summary reads retain aggregates only, while explicit drill-downs may retain records', () => {
  const recordScopes = SOURCE.match(/scope: \.record/g) || [];
  assert.equal(recordScopes.length, 3,
    'only attribution rows and exact segment-member outcomes may register record evidence');
  for (const model of [
    'AssistantSegmentSummary', 'AssistantCampaignSummary',
    'AssistantOpportunityFinding', 'AssistantReferralSummary'
  ]) {
    const declaration = MODELS.slice(MODELS.indexOf(`struct ${model}:`));
    assert.match(declaration.slice(0, declaration.indexOf('\n}')), /evidence: AssistantEvidenceToken\?/);
  }
});

test('stored segment evidence uses trusted app context and excludes human prose', () => {
  assert.match(GROUNDED, /struct AssistantBusinessContext/);
  assert.match(GROUNDED, /context\.segmentEvidenceTarget/);
  assert.match(GROUNDED, /case segmentEvidence\(AssistantSegmentEvidenceTarget\)/);
  assert.match(TOOLS, /case \.segmentEvidence\(let target\)/);
  assert.match(TOOLS, /read_stored_segment_evidence/);
  assert.match(TOOLS, /source\.segmentDetail/);
  assert.match(TOOLS, /source\.segmentMember/);
  assert.match(TOOLS, /source\.segmentMemberships/);
  assert.match(GROUNDED, /Human-entered prose is not exposed to the Assistant/);
  assert.match(VIEW, /private var assistantBusinessContext: AssistantBusinessContext/);
  assert.match(VIEW, /case \.segment\(let id, _\), \.segmentPeople\(let id, _\):/);
  assert.match(VIEW, /businessContext: assistantBusinessContext/);
  assert.doesNotMatch(GROUNDED, /parse[\s\S]{0,500}(?:segmentID|memberPhone)\s*=/,
    'ids and phones must not be parsed from a question');
});

test('citation taps recheck exact identity, permissions, and capability', () => {
  assert.match(GROUNDED, /struct AssistantIdentitySnapshot/);
  for (const field of ['userID', 'role', 'isLegacyShared', 'viaLegacySession', 'permissions']) {
    assert.ok(GROUNDED.includes(`let ${field}`), `identity fence omits ${field}`);
  }
  assert.match(API, /func fetchCurrentUserStrict\(\) async throws -> AuthUser/);
  const strict = API.slice(API.indexOf('func fetchCurrentUserStrict'), API.indexOf('func updateOnboarding'));
  assert.doesNotMatch(strict, /lastKnownUser\s*\?\?/);
  assert.match(TOOLS, /fetchAssistantStatus\(\)/);
  assert.match(TOOLS, /fetchCurrentUserStrict\(\)/);
  assert.match(TOOLS, /freshIdentity == initiatingIdentity/);
  assert.match(VIEW, /AssistantIdentitySnapshot\(user: user\)\.stableKey/);
  assert.match(MODEL, /AssistantIdentitySnapshot\(user: user\)/);
  assert.match(MODEL, /guard let route else \{[\s\S]*?obscureAndPurge\(\)/);
});

test('grounded prompt hash matches its actual bundled runtime bytes', () => {
  const body = PROMPT.match(/private static let groundedToolsV1 = """\n([\s\S]*?)\n    """/);
  assert.ok(body, 'grounded instruction body is missing');
  const runtimeBytes = body[1].split('\n').map(line => line.replace(/^    /, '')).join('\n');
  const actualHash = crypto.createHash('sha256').update(runtimeBytes).digest('hex');
  const declaration = PROMPT.match(/static let groundedTools[\s\S]*?contentSHA256: "([0-9a-f]{64})"/);
  assert.ok(declaration, 'grounded prompt hash is missing');
  assert.equal(declaration[1], actualHash);
});

test('opportunity and analytics honesty metadata survives safe projection', () => {
  assert.match(MODELS, /let stale: Bool/);
  assert.match(MODELS, /let ageSeconds: Int/);
  assert.match(MODELS, /let refreshFailureCode: String\?/);
  assert.match(MODELS, /struct AssistantOpportunityRefusal[\s\S]*?let reason: String/);
  assert.doesNotMatch(MODELS, /struct AssistantOpportunityRefusal[\s\S]*?let detail:/);
  assert.match(MODELS, /let revenueAvailable: Bool/);
  assert.match(MODELS, /let notices: \[AssistantDataNotice\]/);
  assert.match(SOURCE, /safeNotices\(record\.warnings\.map\(\\\.code\)\)/);
});

test('checked-in project contains the complete grounded data boundary', () => {
  for (const file of [
    'AssistantBusinessModels.swift',
    'AssistantEvidenceRegistry.swift',
    'AssistantBusinessDataSource.swift',
    'AssistantGroundedModels.swift',
    'OnDeviceAssistantTools.swift'
  ]) assert.ok(PROJECT.includes(file), `${file} is absent from the checked-in project`);
});
