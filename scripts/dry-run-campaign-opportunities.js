#!/usr/bin/env node
'use strict';

/**
 * Offline-only campaign opportunity orchestrator.
 *
 * Input is a local JSON fixture. The script imports no database, queue, APNs,
 * WooCommerce client or messaging provider. Authoritative inventory refetches
 * are represented by explicit trusted snapshots inside that fixture, making
 * safety and determinism reviewable without touching production.
 */

const fs = require('fs');
const path = require('path');
const { prepareOpportunityDraftRun } = require('../lib/campaigns/opportunity-orchestrator');

function argumentValue(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
}

function summary(run) {
  const byWorkflow = {};
  const suppressionReasons = {};
  for (const draft of run.drafts) {
    byWorkflow[draft.workflowCategory] = (byWorkflow[draft.workflowCategory] || 0) + 1;
  }
  for (const row of run.suppressed) {
    for (const reason of row.reasons) suppressionReasons[reason] = (suppressionReasons[reason] || 0) + 1;
  }
  for (const row of run.collisionSuppressions) {
    suppressionReasons[row.reason] = (suppressionReasons[row.reason] || 0) + 1;
  }
  return {
    mode: run.mode,
    ruleVersion: run.ruleVersion,
    generatedAt: run.generatedAt,
    workspaceID: run.workspaceID,
    opportunitiesPrepared: run.opportunities.length,
    draftsPrepared: run.drafts.length,
    byWorkflow,
    notificationsPrepared: run.notifications.length,
    suppressionReasons,
    safety: run.safety
  };
}

async function run(argv = process.argv.slice(2)) {
  const inputPath = argumentValue(argv, '--input');
  if (!inputPath) throw new Error('Usage: node scripts/dry-run-campaign-opportunities.js --input /absolute/path/to/fixture.json');
  const fixture = JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8'));
  const authoritativeByKey = fixture.authoritativeProducts || {};
  const result = await prepareOpportunityDraftRun(fixture, {
    authoritativeProductRefetch: async ({ productID, variationID }) => {
      const key = `${productID}:${variationID || 'parent'}`;
      return authoritativeByKey[key] || null;
    }
  });
  return summary(result);
}

if (require.main === module) {
  run().then(report => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }).catch(error => {
    console.error(`[CAMPAIGN OPPORTUNITY DRY RUN] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { run, summary };
