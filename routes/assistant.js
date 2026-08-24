'use strict';
/**
 * routes/assistant.js - remote capability gate for the native assistant.
 *
 * There is deliberately no prompt, model, tool, mutation, or business-data
 * endpoint here. Reasoning is on-device. Existing read APIs remain the only
 * source of business facts and retain their own route-policy permissions.
 *
 * Two independent gates apply:
 *   1. route policy requires assistant.use;
 *   2. this handler requires a named Owner/Admin actor.
 *
 * The second gate prevents a mistaken per-user grant from enabling the pilot
 * for a Support Agent, and prevents the shared identity from using a feature
 * whose transcript and actions need one accountable person.
 */

const express = require('express');

const ENABLED_VALUE = 'true';
const ELIGIBLE_ROLES = new Set(['owner', 'admin']);

function isNamedAdmin(actor) {
  if (!actor || !ELIGIBLE_ROLES.has(String(actor.role || '').toLowerCase())) return false;
  if (actor.isLegacyShared === true || actor.viaLegacySession === true) return false;
  return actor.id !== null && actor.id !== undefined && String(actor.id).trim() !== '';
}

function createAssistantRouter({ env = process.env } = {}) {
  const router = express.Router();

  router.get('/status', (req, res) => {
    res.set('Cache-Control', 'no-store, private');

    if (!isNamedAdmin(req.actor)) {
      return res.status(403).json({
        error: 'The assistant pilot is available only to named Owner and Admin accounts.',
        code: 'ASSISTANT_NAMED_ADMIN_REQUIRED'
      });
    }

    const enabled = env.ASSISTANT_ENABLED === ENABLED_VALUE;
    return res.json({
      enabled,
      mode: 'on_device_read_only',
      minimumOSMajor: 26,
      reason: enabled ? null : 'pilot_disabled'
    });
  });

  return router;
}

module.exports = createAssistantRouter;
module.exports.isNamedAdmin = isNamedAdmin;
