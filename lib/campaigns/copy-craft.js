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

  'Specific always beats general. "15 percent off your next order" is a reason to act; "a '
    + 'special offer" is not. "the RT you ordered in June" is a fact about that person; "your '
    + 'recent purchase" is a mail merge that forgot to merge.',

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
  SELF_CHECK,
  TECHNIQUES,
  renderBusinessContext,
  renderSelfCheck,
  renderTechniques
};
