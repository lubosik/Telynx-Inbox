'use strict';
/**
 * lib/campaigns/copy-craft.js — how to write a good SMS, as opposed to how to
 * avoid writing an illegal one.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A SEPARATE FILE FROM copy-rules.js
 *
 *   copy-rules.js is the law: twenty-one prohibitions, every one of which the
 *   validator enforces deterministically, kept in step with a research doc.
 *   Nothing in here is enforceable and nothing in here should ever be, because
 *   "this sentence is flabby" is not a thing a regex can decide.
 *
 *   They were the same thing until the owner said the drafts ignored him. The
 *   model was being handed twenty-one things it must not do, one unemphasised
 *   line about what he actually wanted, and a closing instruction whose last
 *   words were "a boring compliant message is the goal". It did as it was
 *   told. It produced boring compliant messages that had little to do with the
 *   brief.
 *
 *   Compliance is the floor, not the brief. This file is the brief.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THESE PARTICULAR TECHNIQUES
 *
 *   They are the ones that survive the constraints this business actually has.
 *   Most SMS copywriting advice is about urgency, scarcity and exclamation
 *   marks, all three of which copy-rules.js bans outright — for carrier
 *   filtering and for a supplement retailer's advertising exposure. What is
 *   left is the harder and better half of the craft: specificity, one idea,
 *   and earning the first forty characters.
 */

/**
 * What the business is, so the model is not writing for a generic "US
 * business" as it was before.
 *
 * Deliberately says what the shop sells and NOT what anything does, because
 * the moment a model knows a product category it starts reaching for benefit
 * language, and every benefit claim in this category is one the validator will
 * reject and a regulator would care about.
 */
const BUSINESS = Object.freeze({
  name: 'Vici',
  sender: 'Vin from Vici',
  what: 'an online shop selling research peptides direct to customers in the United States',
  customers: 'people who have already bought at least once, so they know what the shop is '
    + 'and do not need it explained',
  voice: 'one person texting another from a shop they have bought from. Familiar and '
    + 'unhurried, never a brand broadcasting and never a marketer performing enthusiasm',
  // Named because the model otherwise writes "your recent purchase" where the
  // merge field would have said the actual product, which is the whole
  // difference between a blast and a message.
  personalisation: 'The shop knows each customer\'s first name, how many orders they have '
    + 'placed, what they last bought and roughly when. Use the variables for these rather '
    + 'than writing around them.'
});

/**
 * The craft. Positive instruction only: every line says what to DO.
 *
 * Ordered by how much difference each makes to a message that is already legal.
 */
const TECHNIQUES = Object.freeze([
  'One idea per message. A text that says two things says neither. If the brief contains '
    + 'two ideas, pick the one that would make somebody act and drop the other.',

  'The first forty characters are the whole message for most people, because that is what '
    + 'shows on a lock screen. Put the point there. The brand comes first for identification, '
    + 'so the point has to arrive immediately after it, not in the second sentence.',

  // The counter-examples are DESCRIBED, not quoted. Writing the vague phrase
  // out in full would put a carrier-filtered term in front of the model, which
  // is the trap this file's own test exists to catch.
  'Specific always beats general. "15 percent off your next order" is a reason to act; a '
    + 'vague gesture at savings is not. "the RT you ordered in June" is a fact about that '
    + 'person; "your recent purchase" is a mail merge that forgot to merge.',

  'Write the sentence you would actually text. Read it aloud: if you would not say it to '
    + 'somebody standing in front of you, rewrite it. "Thought of you when this came back in" '
    + 'is a sentence. "We wanted to reach out regarding your recent purchase" is not.',

  'Ask one question or make one offer, and make it obvious what happens next. A message that '
    + 'ends without a clear next step gets read and forgotten.',

  'Cut every word that is doing no work. Adjectives are almost always the first to go, and '
    + '"just", "simply", "actually" and "we wanted to" are always the first after that.',

  'Contractions and short sentences. "You\'re" not "you are". Two short sentences beat one '
    + 'long one at this length.',

  // Deliberately not "earn the discount": "discount" is on the carrier-filter
  // banned list in copy-rules.js, and priming the model with a word the
  // validator will reject only costs candidates.
  'Give the code a reason. If there is a code, say why it exists before giving it, even '
    + 'briefly. A code with no reason reads as a mass send, which is what it is.',

  'Vary the candidates by APPROACH, not by synonym. Three messages that differ only in '
    + 'whether they say "hi" or "hey" are one message. Try a different opening idea, a '
    + 'different order, a different reason.'
]);

/**
 * Patterns taken from real marketing SMS the owner received and forwarded.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHERE THESE COME FROM
 *
 *   Two threads on his own phone: a UK gym chain running win-backs to lapsed
 *   members, and a fast-fashion retailer running offer blasts. Both are
 *   competent, high-volume programmes. Neither is a style to copy — the point
 *   is which of their techniques survive this business's constraints, and
 *   which are the exact things copy-rules.js exists to forbid.
 *
 * WHAT WAS DELIBERATELY NOT TAKEN, AND WHY
 *
 *   Almost everything that gives those messages their punch is banned here,
 *   and correctly so:
 *
 *     - Exclamation marks. Both senders lean on them; rule 6 forbids them.
 *     - Manufactured deadlines: "Ends midnight", "before they're gone",
 *       "ends tonight". Rule 11 forbids invented urgency outright.
 *     - Currency amounts: "1st month for £10", "from £0.19". Rule 12.
 *     - ALL CAPS mechanics: "UP TO 80% OFF and DOWN TO £0.29". Rule 17.
 *     - The word "Free". Rule 13, because carriers filter it.
 *     - Shortened links (tinyurl, s.pro). Rule 19 and copy-rules' own
 *       shortener list.
 *
 *   The multi-line block layout was not taken either, and for a different
 *   reason: it is genuinely good, and it does not fit. The gym's messages run
 *   past 250 characters across four blocks, which is two segments they have
 *   chosen to pay for. Rule 2 holds this business to 160 septets in one
 *   segment, and at that length a four-block layout leaves about thirty words.
 *   FORBIDDEN_CONTROL in copy-rules.js stays as it is.
 *
 *   One of those threads also sent the SAME message twice in seventy-five
 *   minutes. That is not a technique, it is the failure the frequency
 *   reservation and the dedupe window in this system exist to prevent, and it
 *   is worth remembering that a real programme at real scale still does it.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHAT IS LEFT IS THE HALF THAT TRAVELS
 */
const OBSERVED_PATTERNS = Object.freeze([
  'Put the offer in the FIRST sentence, straight after the brand. Both senders do this and '
    + 'neither warms up: "Rejoin [the gym nearest you] and get your first month for [a price]". '
    + 'No greeting, no "we hope you are well", no throat-clearing. The reader decides in the '
    + 'notification preview whether to open it.',

  'Name the exact thing. Every one of these messages carries one concrete, checkable detail: '
    + 'a specific price, a specific product, a specific branch. None of them says "a great '
    + 'offer" or "our latest range". Vagueness is what people scroll past.',

  'Use the verb that matches where the reader actually is. The gym says "Rejoin", not "Join", '
    + 'because it is writing to people who left. The verb is doing the segmentation out loud, '
    + 'and it tells the reader this was meant for them.',

  'Tie it to a moment the reader recognises. One thread hangs an offer on payday: a real thing '
    + 'in the reader\'s week rather than an invented deadline. This shop\'s honest equivalent is '
    + 'the reader\'s own order: how long since it was, what was in it, which is a real moment '
    + 'and needs no manufactured one.',

  'Label the next step instead of leaving it implied. "Sign up here:" before a link, "just '
    + 'reply" before a question. A message that ends without naming the action gets read and '
    + 'put down.',

  'Swap ONE detail per person and leave the rest. The gym changes only the branch name; '
    + 'everything else is identical across sends. Here that detail is the product they bought '
    + 'or the month they bought it. One true specific does more than three vague ones.',

  // Deliberately describes the shouting rather than reproducing it. Quoting a
  // real capitalised offer line here would prime the model with the exact
  // string rule 17 discards, which is the trap this file's own test caught.
  'Write the body in sentence case. Compare the two senders directly: the one writing in '
    + 'sentence case reads like a shop texting you, and the one setting its whole offer in '
    + 'capitals reads like a billboard. Rule 17 already forbids that; it is also simply '
    + 'worse writing.'
]);

function renderObservedPatterns() {
  return OBSERVED_PATTERNS.map((line, index) => `${index + 1}. ${line}`).join('\n');
}

/**
 * The check the model runs on its own output before returning it.
 *
 * Cheap and effective: a model that has just written nine rules' worth of copy
 * will catch its own worst line if asked one direct question about it.
 */
const SELF_CHECK = Object.freeze([
  'Does this message do what the brief asked for? If not, rewrite it. The brief is the job.',
  'Would a person read the first forty characters and understand why they were texted?',
  'Is there a word in here doing no work?',
  'Is it 160 characters or fewer including the brand and the opt-out sentence?'
]);

function renderBusinessContext() {
  return [
    `The business: ${BUSINESS.name}, ${BUSINESS.what}.`,
    `Who receives these: ${BUSINESS.customers}.`,
    `Voice: ${BUSINESS.voice}.`,
    BUSINESS.personalisation
  ].join('\n');
}

function renderTechniques() {
  return TECHNIQUES.map((line, index) => `${index + 1}. ${line}`).join('\n');
}

function renderSelfCheck() {
  return SELF_CHECK.map(line => `- ${line}`).join('\n');
}

module.exports = {
  BUSINESS,
  OBSERVED_PATTERNS,
  renderObservedPatterns,
  SELF_CHECK,
  TECHNIQUES,
  renderBusinessContext,
  renderSelfCheck,
  renderTechniques
};
