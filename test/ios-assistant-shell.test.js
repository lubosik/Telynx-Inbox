'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

const MODELS = read('ios/ViciInbox/Core/AssistantModels.swift');
const MODEL = read('ios/ViciInbox/App/AssistantModel.swift');
const REASONER = read('ios/ViciInbox/App/OnDeviceAssistantReasoner.swift');
const PROMPT = read('ios/ViciInbox/Core/AssistantPromptCatalog.swift');
const VIEW = read('ios/ViciInbox/UI/AssistantView.swift');
const ACCOUNT = read('ios/ViciInbox/UI/AccountMenuView.swift');
const ROUTER = read('ios/ViciInbox/App/AppRouter.swift');
const ROOT_VIEW = read('ios/ViciInbox/UI/RootView.swift');
const API = read('ios/ViciInbox/Core/APIClient.swift');
const MODEL_SMOKE = read('ios/Tests/AssistantModelSmoke.swift');

test('assistant account entry fails closed for identity, role, and explicit permission', () => {
  assert.match(MODELS, /guard let user,/);
  assert.match(MODELS, /!user\.isSharedTeamLogin/);
  assert.match(MODELS, /user\.permissions != nil/);
  assert.match(MODELS, /role == "owner" \|\| role == "admin"/);
  assert.match(MODELS, /user\.permissionSet\.contains\(Permission\.assistantUse\)/);
  assert.match(ACCOUNT, /if AssistantAccess\.isPermitted\(for: session\.currentUser\)/);
  assert.match(ROUTER, /case \.assistant:\s*return assistant/);
  assert.match(VIEW, /private var hasClientAccess:[\s\S]*?AssistantAccess\.isPermitted/);
  assert.match(VIEW, /\.onChange\(of: hasClientAccess\)[\s\S]*?router\.dismissAccount\(\)/);
});

test('capability check is exact, fail closed, and refreshed at every required boundary', () => {
  assert.match(API, /decodedGET\("\/api\/assistant\/status"\)/);
  assert.match(MODELS, /status\.mode == AssistantCapabilityStatus\.supportedMode/);
  assert.match(MODELS, /currentOSMajor >= status\.minimumOSMajor/);
  assert.match(MODEL, /catch \{[\s\S]*?machine\.fail\(\)/);
  assert.match(VIEW, /\.task \{[\s\S]*?refreshCapability/);
  assert.match(VIEW, /if phase == \.active[\s\S]*?refreshCapability/);
  assert.match(VIEW, /Retry access check/);
  const submit = MODEL.slice(MODEL.indexOf('func submit('), MODEL.indexOf('func noteCallActivity'));
  assert.match(submit, /await refreshCapability/);
  assert.ok(submit.indexOf('await refreshCapability') < submit.indexOf('transcript.append'));
});

test('assistant installs only the concrete iOS 26 no-tools on-device model', () => {
  for (const state of [
    'checkingCapability', 'disabled', 'unavailable', 'idle', 'thinking',
    'speaking', 'interruptedByCall', 'failed'
  ]) assert.ok(MODELS.includes(`case ${state}`), `missing state ${state}`);

  assert.match(REASONER, /#if canImport\(FoundationModels\)/);
  assert.match(REASONER, /@available\(iOS 26\.0, \*\)/);
  assert.match(REASONER, /SystemLanguageModel/);
  assert.match(REASONER, /\.default/);
  assert.match(REASONER, /model\.availability/);
  assert.match(REASONER, /LanguageModelSession\(model: model, tools: \[\]\)/);
  assert.match(REASONER, /session\.prewarm\(\)/);
  assert.match(REASONER, /session\.respond\(to: prompt\)/);
  assert.match(REASONER, /Task\.checkCancellation\(\)/);
  assert.match(REASONER, /LanguageModelSession\.GenerationError/);
  for (const errorCase of [
    'assetsUnavailable', 'decodingFailure', 'exceededContextWindowSize',
    'guardrailViolation', 'refusal', 'rateLimited', 'concurrentRequests',
    'unsupportedGuide', 'unsupportedLanguageOrLocale'
  ]) assert.match(REASONER, new RegExp(`\\.${errorCase}`), `missing Xcode 26 error ${errorCase}`);
  assert.doesNotMatch(REASONER, /LanguageModelError|SystemLanguageModel\.Error|localizedDescription|debugDescription/);

  const phaseSixSource = [MODELS, MODEL, REASONER, PROMPT, VIEW].join('\n');
  for (const forbidden of [
    'DynamicProfile', 'PrivateCloudComputeLanguageModel', 'AppIntent',
    'URLSession', 'OpenRouter', 'Claude', 'Gemini'
  ]) assert.equal(phaseSixSource.includes(forbidden), false, `forbidden Phase 6 API ${forbidden}`);
  assert.doesNotMatch(phaseSixSource, /(?:struct|class|enum)\s+\w+\s*:\s*LanguageModel/);
  assert.doesNotMatch(phaseSixSource, /(?:struct|class|enum)\s+\w+\s*:\s*Tool/);
  assert.doesNotMatch(phaseSixSource, /\/api\/(?:messages|campaigns|contacts|analytics|voice)/);
  assert.doesNotMatch(phaseSixSource, /\b(?:post|put|patch|delete)\s*\(/i);
});

test('prompt is versioned, hash-verified, trusted, and separate from user input', () => {
  assert.match(PROMPT, /id: "vici-assistant-reasoner-v1\.0-ios26"/);
  assert.match(PROMPT, /changelog:/);
  assert.match(PROMPT, /no business data and no tools/);
  assert.match(PROMPT, /NEVER invent or imply access/);
  assert.match(PROMPT, /You cannot perform actions/);
  assert.doesNotMatch(PROMPT, /userText|submittedText|draft/);
  assert.match(REASONER, /AssistantPromptCatalog\.current\.instructions/);
  assert.match(REASONER, /let prompt = Prompt[\s\S]*?userText/);

  const body = PROMPT.match(/private static let instructionsV1 = """\n([\s\S]*?)\n    """/);
  assert.ok(body, 'versioned instruction body is missing');
  const runtimeBytes = body[1].split('\n').map(line => line.replace(/^    /, '')).join('\n');
  const actualHash = crypto.createHash('sha256').update(runtimeBytes).digest('hex');
  const declaredHash = PROMPT.match(/contentSHA256: "([0-9a-f]{64})"/)[1];
  assert.equal(declaredHash, actualHash, 'prompt hash must match the bundled runtime bytes');
});

test('strict Phase 6 scope rejects business and action requests before model invocation', () => {
  assert.match(MODELS, /enum AssistantReasoningScope/);
  assert.match(MODELS, /guard generatedGreetingRequests\.contains\(normalised\) else/);
  assert.match(MODELS, /private static let generatedGreetingRequests/);
  assert.match(MODELS, /private static let localShellAnswers/);
  assert.match(MODELS, /enum AssistantGreetingOutputPolicy/);
  assert.match(MODELS, /rangeOfCharacter\(from: \.decimalDigits\)/);
  assert.match(MODELS, /private static let allowedNormalisedGreetings/);
  assert.match(MODELS, /allowedNormalisedGreetings\.contains\(normalised\)/);
  assert.match(MODELS, /AssistantGreetingOutputPolicy\.validatedGreeting\(generated\)/);
  assert.match(MODELS, /return AssistantScopedResponse\(text: unavailableDataMessage, wasGenerated: false\)/);
  const scopedTask = MODEL.slice(MODEL.indexOf('let task = Task'), MODEL.indexOf('responseTask = task'));
  assert.match(scopedTask, /AssistantReasoningScope\.answer/);
  assert.ok(scopedTask.indexOf('AssistantReasoningScope.answer') < scopedTask.indexOf('reasoning.respond'));
  const modelAllowlist = MODELS.slice(
    MODELS.indexOf('private static let generatedGreetingRequests'),
    MODELS.indexOf('private static let localShellAnswers')
  );
  for (const forbidden of ['revenue', 'orders', 'messages', 'campaigns', 'customers', 'send a message']) {
    assert.equal(modelAllowlist.includes(`"${forbidden}"`), false, `${forbidden} must not be model-allowed`);
  }
  assert.match(MODEL_SMOKE, /return "Vici made \$999,999 today\."/);
  assert.match(MODEL_SMOKE, /precondition\(respondCount == 0/);
  assert.match(MODEL_SMOKE, /model\.transcript\.allSatisfy \{ !\$0\.text\.contains\("999,999"\) \}/);
  assert.match(MODEL_SMOKE, /model\.draft = "Hello"/);
  assert.match(MODEL_SMOKE, /greeting == AssistantGreetingOutputPolicy\.fallback/);
  assert.match(MODEL_SMOKE, /respondCount == 1/);
});

test('transcript is memory-only and purged on navigation, background, and calls', () => {
  const phaseSixSource = [MODELS, MODEL, REASONER, PROMPT, VIEW].join('\n');
  for (const forbidden of [
    /UserDefaults\s*\./, /FileManager\s*\./, /@Model\b/, /ModelContainer\b/,
    /Logger\s*\(/, /ViciLog\s*\./
  ]) assert.doesNotMatch(phaseSixSource, forbidden, `transcript persistence or logging: ${forbidden}`);
  assert.match(MODEL, /transcript\.removeAll\(keepingCapacity: false\)/);
  assert.match(MODEL, /draft\.count > AssistantInputPolicy\.maximumCharacters/);
  assert.match(MODELS, /maximumCharacters = 500/);
  assert.match(VIEW, /else \{[\s\S]*?model\.obscureAndPurge\(\)/);
  assert.match(VIEW, /\.onDisappear[\s\S]*?model\.obscureAndPurge\(\)/);
  assert.match(VIEW, /\.onChange\(of: callIsActive\)[\s\S]*?model\.noteCallActivity\(active\)/);
  assert.match(ROOT_VIEW, /\.onChange\(of: session\.activeCall\)[\s\S]*?router\.dismissAccount\(\)/);
  assert.match(MODEL, /responseTask\?\.cancel\(\)/);
  assert.match(MODEL, /responseGeneration \+= 1/);
  assert.match(MODEL, /generation == responseGeneration/);
  assert.match(MODEL, /cancelResponse\(resetSession: true\)[\s\S]*?clearPrivateText\(\)/);
  assert.match(REASONER, /func reset\(\)[\s\S]*?session = Self\.makeSession/);
  assert.match(MODEL_SMOKE, /DelayedGreetingGate/);
  assert.match(MODEL_SMOKE, /delayedModel\.noteCallActivity\(true\)/);
  assert.match(MODEL_SMOKE, /lateResponse == nil/);
  assert.match(MODEL_SMOKE, /delayedModel\.transcript\.isEmpty/);
  assert.match(MODEL_SMOKE, /delayedModel\.phase == \.interruptedByCall/);
});

test('assistant copy accurately limits grounded reasoning and business access', () => {
  assert.match(VIEW, /Ask for a verified Vici summary/);
  assert.match(VIEW, /Permission-checked business reads/);
  assert.match(VIEW, /No write actions/);
  assert.match(VIEW, /On-device reasoning/);
  assert.equal(VIEW.includes('\u2014'), false, 'no em dash in user-facing shell copy');
});

test('generated project contains every Assistant reasoning source', () => {
  const project = read('ios/ViciInbox.xcodeproj/project.pbxproj');
  for (const file of [
    'AssistantModels.swift', 'AssistantPromptCatalog.swift',
    'AssistantModel.swift', 'OnDeviceAssistantReasoner.swift', 'AssistantView.swift'
  ]) {
    assert.ok(project.includes(file), `${file} is absent from the checked-in project`);
  }
});
