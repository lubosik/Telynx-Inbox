'use strict';

const crypto = require('node:crypto');
const { normalisePhone } = require('./phone');
const {
  answerCall, gatherUsingSpeak, hangupCall, speakStatefulOnCall
} = require('./telnyx-api');

const STATE_KIND = 'vici_voice_opt_out';
const WORKSPACE = 'vici';
const CONSENT_VERSION = 'vici_marketing_sms_voice_v1';

const MENU_PROMPT = 'You have reached the automated call opt-out line for Vici Peptides. '
  + 'To stop automated calls to the number you are calling from, press 9. '
  + 'To remove a different U.S. phone number, press 2.';
const NUMBER_PROMPT = 'Enter the ten digit U.S. phone number that should stop receiving automated calls.';
const SUCCESS_PROMPT = 'Your request has been recorded. Vici Peptides will not make future automated marketing calls to that number. Goodbye.';
const NO_CHANGE_PROMPT = 'No opt-out request was recorded. Goodbye.';

function encodeState(phase) {
  return Buffer.from(JSON.stringify({ kind: STATE_KIND, phase })).toString('base64');
}

function decodeState(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64').toString('utf8'));
    return parsed?.kind === STATE_KIND && typeof parsed.phase === 'string' ? parsed : null;
  } catch (_) { return null; }
}

function configuredNumber(env) {
  return normalisePhone(env.VICI_VOICE_OPT_OUT_TOLL_FREE_NUMBER || '');
}

function isOptOutDestination(payload, env) {
  const target = configuredNumber(env);
  // The same Call Control application owns both the outbound Vici caller ID
  // and this inbound line. A call placed *to* the toll-free number by a test
  // or another application must not make its originating leg behave like the
  // inbound IVR leg.
  return Boolean(target && payload?.direction === 'incoming'
    && normalisePhone(payload?.to || '') === target);
}

function eventTime(event) {
  const value = event?.occurred_at || event?.payload?.occurred_at;
  return value && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : new Date().toISOString();
}

function enteredUSPhone(digits) {
  const clean = String(digits || '').replace(/\D/g, '');
  return clean.length === 10 && clean[0] >= '2' ? `+1${clean}` : null;
}

function commandID(event, action) {
  return crypto.createHash('sha256').update(`${event.id}:${action}`).digest('hex').slice(0, 32);
}

function createVoiceOptOutHandler({ client, env = process.env, commands = {} }) {
  const answer = commands.answer || answerCall;
  const gather = commands.gather || gatherUsingSpeak;
  const speak = commands.speak || speakStatefulOnCall;
  const hangup = commands.hangup || hangupCall;

  async function recordOptOut(phone, event) {
    const normalized = normalisePhone(phone || '');
    if (!/^\+1\d{10}$/.test(normalized || '')) {
      throw Object.assign(new Error('A valid U.S. phone number is required for voice opt-out.'), {
        code: 'VOICE_OPT_OUT_PHONE_INVALID'
      });
    }
    const occurredAt = eventTime(event);
    const callID = String(event.payload?.call_control_id || '');
    const { error } = await client.from('luko_voice_suppressions').insert({
      workspace_id: WORKSPACE,
      contact_phone: normalized,
      reason_code: 'provider_opt_out',
      source_call_id: callID || null,
      suppressed_at: occurredAt,
      metadata: {
        source: 'toll_free_callback',
        provider_event_id: String(event.id || '')
      }
    });
    // The partial unique index makes a repeated callback idempotent. A later
    // consent event must never resurrect the caller merely because the first
    // suppression insert already exists.
    if (error && error.code !== '23505') throw error;

    const { error: consentError } = await client.rpc('record_luko_voice_consent', { p_event: {
      workspace_id: WORKSPACE,
      phone: normalized,
      voice_marketing_consent: false,
      ai_voice_consent: false,
      consent_version: CONSENT_VERSION,
      source: 'toll_free_callback',
      occurred_at: occurredAt,
      dedupe_key: `voice-toll-free-optout:${String(event.id || callID)}:${normalized}`,
      evidence_ref: `telnyx-event:${String(event.id || '')}`
    } });
    if (consentError) throw consentError;
    return normalized;
  }

  async function sayAndFinish(callID, text, event, phase = 'goodbye') {
    return speak(callID, text, {
      clientState: encodeState(phase),
      commandId: commandID(event, phase)
    }, { env });
  }

  async function collectMenu(callID, event) {
    return gather(callID, MENU_PROMPT, {
      validDigits: '29', minimumDigits: 1, maximumDigits: 1,
      terminatingDigit: '', maximumTries: 2, timeoutMillis: 10000,
      invalidPayload: 'Please press 9 to stop automated calls, or press 2 to enter another number.',
      clientState: encodeState('menu'), commandId: commandID(event, 'menu')
    }, { env });
  }

  async function collectNumber(callID, event) {
    return gather(callID, NUMBER_PROMPT, {
      validDigits: '0123456789', minimumDigits: 10, maximumDigits: 10,
      terminatingDigit: '', maximumTries: 2, timeoutMillis: 15000,
      invalidPayload: 'Please enter all ten digits of the U.S. phone number.',
      clientState: encodeState('number'), commandId: commandID(event, 'number')
    }, { env });
  }

  async function handle(event) {
    const payload = event?.payload || {};
    const state = decodeState(payload.client_state);
    if (!state && !isOptOutDestination(payload, env)) return { handled: false };

    const type = String(event.event_type || '');
    const callID = String(payload.call_control_id || '');
    if (!callID) return { handled: true };

    if (type === 'call.initiated') {
      // Telnyx does not consistently repeat `direction` on call.answered.
      // Attach state to the answer command so every later webhook remains
      // unambiguously owned by this IVR without relying on an in-memory map.
      await answer(callID, {
        clientState: encodeState('answer'),
        commandId: commandID(event, 'answer')
      }, { env });
    } else if (type === 'call.answered') {
      await collectMenu(callID, event);
    } else if (type === 'call.gather.ended') {
      const digits = String(payload.digits || '');
      const valid = payload.status === 'valid';
      if (state?.phase === 'menu' && valid && digits === '2') {
        await collectNumber(callID, event);
      } else if (state?.phase === 'menu' && valid && digits === '9') {
        const caller = normalisePhone(payload.from || '');
        if (/^\+1\d{10}$/.test(caller || '')) {
          await recordOptOut(caller, event);
          await sayAndFinish(callID, SUCCESS_PROMPT, event);
        } else {
          await collectNumber(callID, event);
        }
      } else if (state?.phase === 'number' && valid && enteredUSPhone(digits)) {
        await recordOptOut(enteredUSPhone(digits), event);
        await sayAndFinish(callID, SUCCESS_PROMPT, event);
      } else {
        await sayAndFinish(callID, NO_CHANGE_PROMPT, event);
      }
    } else if (type === 'call.speak.ended' && state?.phase === 'goodbye') {
      try {
        await hangup(callID, commandID(event, 'hangup'), { env });
      } catch (error) {
        // A caller may hang up as the goodbye ends. Telnyx then returns 422 /
        // 90018 to our redundant hangup command; the desired state is already
        // reached, so acknowledge it instead of creating an endless retry.
        const message = String(error?.message || '');
        if (!message.includes('90018') && !/call has already ended/i.test(message)) throw error;
      }
    }
    // call.dtmf.received, call.hangup and command lifecycle events are owned by
    // this flow as well, but require no additional command.
    return { handled: true };
  }

  return { handle, recordOptOut };
}

module.exports = {
  MENU_PROMPT, NUMBER_PROMPT, SUCCESS_PROMPT, NO_CHANGE_PROMPT,
  createVoiceOptOutHandler, decodeState, encodeState, enteredUSPhone,
  isOptOutDestination
};
