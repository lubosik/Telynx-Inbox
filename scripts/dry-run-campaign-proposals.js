#!/usr/bin/env node
'use strict';

/**
 * Offline-only campaign proposal drafting.
 *
 * SAFETY HEADER
 *   Reads two local JSON fixtures and nothing else. It imports no database, no
 *   messaging provider, and no OpenRouter client: the model reply is a fixture
 *   too, so this script cannot reach a network, cannot write a row, and cannot
 *   contact anybody. It exists so the whole pipeline — opportunity contract,
 *   mechanism selection, audience validation, copy validation, distinctness,
 *   projections — can be read end to end without a deploy.
 *
 * USAGE
 *   node scripts/dry-run-campaign-proposals.js \
 *     --opportunity path/to/opportunity.json \
 *     --model-reply path/to/model-reply.json \
 *     [--catalogue path/to/products.json] [--limit 4] [--json]
 *
 *   `--model-reply` holds what a model WOULD have said: a JSON array of
 *   { mechanism, message, rationale }. Supplying it by hand is the point. A
 *   reviewer can put a health claim, a discount, a reworded duplicate or a
 *   number in it and watch the deterministic layers refuse each one.
 *
 * WHAT IT PRINTS
 *   Aggregate and structural only: mechanisms, offers, risks, the audience in
 *   plain English, the drafted copy, and every refusal by rule id. It prints
 *   no customer, no phone, no order and no name, because none of those exist
 *   anywhere in its inputs.
 */

const fs = require('fs');
const path = require('path');
const { draftProposals } = require('../lib/campaigns/proposal-writer');

function argumentValue(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
}

function readJSON(file, label) {
  if (!file) {
    console.error(`Missing ${label}. See the usage block at the top of this file.`);
    process.exit(2);
  }
  const resolved = path.resolve(process.cwd(), file);
  if (!fs.existsSync(resolved)) {
    console.error(`${label} not found: ${resolved}`);
    process.exit(2);
  }
  try {
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (error) {
    console.error(`${label} is not valid JSON: ${error.message}`);
    process.exit(2);
  }
}

function printHuman(result) {
  console.log(`\nOpportunity: ${result.opportunity.title}`);
  console.log(`  kind      ${result.opportunity.kind}`);
  console.log(`  cohort    ${result.opportunity.cohort.label}`);
  console.log(`  source    ${result.opportunitySource}`);
  console.log(`  requested ${result.requested}   surfaced ${result.returned}   refused ${result.refused.length}`);

  for (const proposal of result.proposals) {
    console.log(`\n── ${proposal.mechanismLabel}  [${proposal.distinctnessClass}]`);
    console.log(`   audience   ${proposal.audience.plainEnglish}`);
    if (proposal.audience.narrowedBy) console.log(`   narrowed   ${proposal.audience.narrowedBy}`);
    if (proposal.audience.narrowingSkipped) console.log(`   not narrowed ${proposal.audience.narrowingSkipped}`);
    console.log(`   offer      ${proposal.offer.kind}`);
    if (proposal.offer.termsRequiredFromHuman.length) {
      for (const term of proposal.offer.termsRequiredFromHuman) console.log(`     a human must set: ${term}`);
    }
    console.log(`   copy       ${proposal.copy.text}`);
    console.log(`   septets    ${proposal.copy.septets}`);
    console.log(`   premise    ${proposal.reasoning.mechanismPremise}`);
    console.log(`   model says ${proposal.reasoning.modelRationale}`);
    for (const risk of proposal.risks) {
      console.log(`   risk       [${risk.severity}] ${risk.statement}`);
    }
    for (const projection of proposal.projections) {
      const figure = projection.value === null ? 'no figure' : `${projection.value} ${projection.unit}`;
      console.log(`   figure     ${projection.label}: ${figure}  (${projection.status})`);
      console.log(`              basis: ${projection.basis}`);
    }
    for (const dropped of proposal.droppedProjections) {
      console.log(`   withheld   ${dropped.id}: ${dropped.reason}`);
    }
  }

  for (const refusal of result.refused) {
    console.log(`\n×× ${refusal.mechanismLabel || refusal.mechanism}  refused at ${refusal.stage}`);
    for (const reason of refusal.reasons || []) console.log(`   ${reason}`);
    for (const term of refusal.bannedTerms || []) console.log(`   banned term: ${term}`);
    if (refusal.tooSimilarTo) console.log(`   too similar to: ${refusal.tooSimilarTo}`);
    for (const error of refusal.errors || []) console.log(`   ${error.path}: ${error.reason}`);
  }
  console.log('\nNothing was saved. Nothing was scheduled. Nothing was sent.\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const opportunity = readJSON(argumentValue(argv, '--opportunity'), '--opportunity fixture');
  const modelReply = readJSON(argumentValue(argv, '--model-reply'), '--model-reply fixture');
  const catalogueArgument = argumentValue(argv, '--catalogue');
  const products = catalogueArgument ? readJSON(catalogueArgument, '--catalogue fixture') : [];
  const limit = Number.parseInt(argumentValue(argv, '--limit') || '', 10);

  // The model is a constant. This script has no OpenRouter client and cannot
  // acquire one: `completion` here returns the fixture and never makes a call.
  const completion = async () => ({ content: JSON.stringify(modelReply), model: 'fixture/offline' });

  let result;
  try {
    result = await draftProposals(
      {
        opportunity,
        opportunitySource: 'client_supplied',
        products,
        segments: [],
        mechanismLimit: Number.isInteger(limit) ? limit : undefined
      },
      {
        // The brake is satisfied locally rather than read from the shell, so
        // running this script can never depend on, or imply, a deployed
        // environment having the feature switched on.
        env: { CAMPAIGN_OPPORTUNITY_PROPOSALS_ENABLED: 'true' },
        completion
      }
    );
  } catch (error) {
    console.error(`\nRefused: ${error.message}`);
    console.error(`Code: ${error.code || 'unknown'}\n`);
    process.exit(1);
  }

  if (argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
}

main().catch(error => {
  console.error(error?.message || error);
  process.exit(1);
});
