'use strict';
// Shared singleton Map for inbound calls waiting for SIP transfer.
// Imported by both voice-webhook.js (writes) and voice.js (reads/triggers).
// Node module cache guarantees both files reference the same instance.
// Structure: callControlId -> { contactPhone, sipTarget, stage, transferTimer }
const pendingCalls = new Map();
module.exports = pendingCalls;
