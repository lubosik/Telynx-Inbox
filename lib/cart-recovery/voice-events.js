'use strict';

const crypto = require('node:crypto');
const { amdBranch, isSpokenOptOut, voiceConfiguration } = require('./voice');
const {
  hangupCall, speakPremiumOnCall, startTranscription, stopAudioOnCall, transferCall
} = require('../telnyx-api');

function occurred(event) {
  const value = event?.occurred_at || new Date().toISOString();
  return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : new Date().toISOString();
}

function commandID() { return crypto.randomUUID(); }

const TERMINAL_STATES = new Set([
  'CANCELLED_PURCHASED', 'FAX_OR_SILENCE', 'NOT_SURE',
  'VOICE_OPT_OUT_DTMF', 'VOICE_OPT_OUT_SPOKEN',
  'VOICEMAIL_PLAYED', 'HUMAN_MESSAGE_PLAYED', 'TRANSFER_CONNECTED',
  'FAILED', 'TRANSFER_FAILED', 'TRANSFER_NO_ANSWER'
]);

const SPEECH_STATES = new Set([
  'HUMAN_MESSAGE_PLAYING', 'HUMAN_MESSAGE_PLAYED',
  'VOICEMAIL_PLAYING', 'VOICEMAIL_PLAYED'
]);

const TRANSFER_STATES = new Set(['TRANSFER_REQUESTED', 'TRANSFER_INITIATED', 'TRANSFER_CONNECTED']);

function decodeClientState(value) {
  try {
    const parsed = JSON.parse(Buffer.from(String(value || ''), 'base64').toString('utf8'));
    return parsed?.kind === 'cart_recovery_voice' ? parsed : null;
  } catch { return null; }
}

function createVoiceEventHandler({ client, env = process.env, api = {}, now = () => new Date(), schedule = null } = {}) {
  if (!client) throw new Error('Database client required.');
  const commands = {
    hangup: api.hangup || hangupCall,
    speak: api.speak || speakPremiumOnCall,
    transcribe: api.transcribe || startTranscription,
    stopAudio: api.stopAudio || stopAudioOnCall,
    transfer: api.transfer || transferCall
  };
  const workspace = env.LUKO_WP_STORE_ID || 'vici';
  const scheduleTask = schedule || ((callback, delay) => {
    const timer = setTimeout(callback, delay);
    timer.unref?.();
    return timer;
  });

  async function rpc(name, args) {
    const { data, error } = await client.rpc(name, args);
    if (error) throw Object.assign(new Error('Voice recovery persistence failed.'), { code: error.code || 'VOICE_DATABASE_ERROR' });
    return data;
  }

  async function resolve(event) {
    const payload = event.payload || {};
    const callControlID = payload.call_control_id;
    const state = decodeClientState(payload.client_state);
    async function findAttempt(column, value) {
      const { data, error } = await client.from('luko_cart_voice_attempts').select('*')
        .eq('workspace_id', workspace).eq(column, value).maybeSingle();
      if (error) throw Object.assign(new Error('Voice attempt lookup failed.'), {
        code: error.code || 'VOICE_DATABASE_ERROR'
      });
      return data;
    }
    let attempt = callControlID ? await findAttempt('call_control_id', callControlID) : null;
    // The earliest Telnyx event can beat persistence of its call-control ID.
    // Recovery client_state gives us a safe attempt-ID fallback and, crucially,
    // prevents a recovery call from falling into the legacy recording handler.
    if (!attempt && state?.attempt_id) attempt = await findAttempt('id', state.attempt_id);
    if (!callControlID && !state?.attempt_id) return null;
    if (!attempt && state) {
      throw Object.assign(new Error('Voice recovery attempt not found.'), {
        code: 'VOICE_RECOVERY_ATTEMPT_NOT_FOUND'
      });
    }
    if (!attempt) return null;
    const { data: recovery, error: recoveryError } = await client.from('luko_cart_recoveries').select('*')
      .eq('workspace_id', workspace).eq('id', attempt.recovery_id).maybeSingle();
    if (recoveryError) throw Object.assign(new Error('Voice recovery lookup failed.'), { code: recoveryError.code || 'VOICE_DATABASE_ERROR' });
    const { data: settings, error: settingsError } = await client.from('luko_cart_recovery_settings').select('*')
      .eq('workspace_id', workspace).maybeSingle();
    if (settingsError) throw Object.assign(new Error('Voice settings lookup failed.'), { code: settingsError.code || 'VOICE_DATABASE_ERROR' });
    return { attempt, recovery, settings: settings || {}, callControlID: callControlID || attempt.call_control_id };
  }

  async function patchAttempt(id, values) {
    const { error } = await client.from('luko_cart_voice_attempts').update({ ...values, updated_at: now().toISOString() }).eq('id', id);
    if (error) throw Object.assign(new Error('Voice attempt update failed.'), { code: error.code || 'VOICE_DATABASE_ERROR' });
  }

  async function transitionAttempt(id, expectedStates, values) {
    const { data, error } = await client.from('luko_cart_voice_attempts')
      .update({ ...values, updated_at: now().toISOString() })
      // bounded: internal state-machine callers pass fixed arrays of at most three states.
      .eq('id', id).in('state', expectedStates).select('id').maybeSingle();
    if (error) throw Object.assign(new Error('Voice attempt transition failed.'), {
      code: error.code || 'VOICE_DATABASE_ERROR'
    });
    return Boolean(data);
  }

  async function patchRecovery(id, values) {
    const { error } = await client.from('luko_cart_recoveries').update({ ...values, updated_at: now().toISOString() }).eq('id', id);
    if (error) throw Object.assign(new Error('Voice recovery update failed.'), { code: error.code || 'VOICE_DATABASE_ERROR' });
  }

  async function transitionRecovery(id, expectedStatuses, values) {
    const { data, error } = await client.from('luko_cart_recoveries')
      .update({ ...values, updated_at: now().toISOString() })
      // bounded: internal state-machine callers pass fixed arrays of at most three statuses.
      .eq('id', id).in('voice_status', expectedStatuses).select('id').maybeSingle();
    if (error) throw Object.assign(new Error('Voice recovery transition failed.'), {
      code: error.code || 'VOICE_DATABASE_ERROR'
    });
    return Boolean(data);
  }

  async function timeline(recoveryID, type, at, metadata = {}) {
    return rpc('append_luko_cart_recovery_timeline', {
      p_recovery_id: recoveryID, p_event_type: type, p_occurred_at: at,
      p_metadata: metadata, p_actor_user_id: null
    });
  }

  async function fail(ctx, state, failureCode, at = now().toISOString(), expectedStates = []) {
    if (!await transitionAttempt(ctx.attempt.id, expectedStates, {
      state, failure_code: failureCode, completed_at: at
    })) return false;
    if (!await transitionRecovery(ctx.recovery.id, expectedStates, {
      voice_status: state, voice_last_failure_code: failureCode, voice_completed_at: at
    })) return false;
    await timeline(ctx.recovery.id, state, at, {
      attempt_id: ctx.attempt.id, reason: failureCode
    });
    return true;
  }

  async function speak(ctx, branch, eventID) {
    if (!ctx.callControlID) throw new Error('Call control id missing.');
    if (TERMINAL_STATES.has(ctx.attempt.state) || SPEECH_STATES.has(ctx.attempt.state)) return false;
    const config = voiceConfiguration(env, ctx.settings);
    if (!config.valid) throw Object.assign(new Error('Voice configuration is incomplete.'), { code: 'VOICE_CONFIGURATION_INVALID' });
    const text = branch === 'human' ? ctx.attempt.rendered_human_text : ctx.attempt.rendered_voicemail_text;
    const state = branch === 'human' ? 'HUMAN_MESSAGE_PLAYING' : 'VOICEMAIL_PLAYING';
    // Persist the branch before issuing the provider command. Telnyx can deliver
    // call.speak.started/ended immediately, and those webhooks must always see
    // whether this was the human or voicemail script.
    const expected = branch === 'human'
      ? ['HUMAN_DETECTED']
      : ['MACHINE_DETECTED', 'GREETING_END_DETECTED'];
    if (!await transitionAttempt(ctx.attempt.id, expected, { state })) return false;
    if (!await transitionRecovery(ctx.recovery.id, expected, { voice_status: state })) return false;
    await timeline(ctx.recovery.id, state, now().toISOString(), { attempt_id: ctx.attempt.id });
    try {
      await commands.speak(ctx.callControlID, text, {
        voice: config.telnyxVoice,
        apiKeyRef: env.TELNYX_ELEVENLABS_API_KEY_REF,
        commandId: eventID || commandID()
      }, { env });
    } catch {
      await fail(ctx, 'FAILED', 'voice_speak_failed', now().toISOString(), [state]);
      try { await commands.hangup(ctx.callControlID, commandID(), { env }); } catch {}
      return false;
    }
    return true;
  }

  function scheduleMachineSpeechFallback(ctx) {
    const configured = Number(env.VICI_VOICE_MACHINE_FALLBACK_MS || 30000);
    const delay = Number.isFinite(configured) && configured >= 5000 && configured <= 45000
      ? configured : 30000;
    scheduleTask(async () => {
      try {
        // Some carrier voicemail systems identify themselves as a machine but
        // never produce Telnyx's optional greeting-ended webhook. Re-read the
        // durable state so a late greeting event, hangup, opt-out, or purchase
        // always wins. `speak` uses conditional state transitions, so this and
        // a simultaneous webhook can never play the message twice.
        const current = await resolve({ payload: { call_control_id: ctx.callControlID } });
        if (current?.attempt?.state === 'MACHINE_DETECTED' && !current.attempt.completed_at) {
          await speak(current, 'machine', commandID());
        }
      } catch (error) {
        console.error('[CART VOICE] Machine greeting fallback failed:', error.code || error.message);
      }
    }, delay);
  }

  async function suppress(ctx, method, event) {
    const at = occurred(event);
    if (['VOICE_OPT_OUT_DTMF', 'VOICE_OPT_OUT_SPOKEN'].includes(ctx.attempt.state)) {
      try { await commands.stopAudio(ctx.callControlID); } catch {}
      try { await commands.hangup(ctx.callControlID, commandID(), { env }); } catch {}
      return;
    }
    try {
      const { error } = await client.from('luko_voice_suppressions').insert({
        workspace_id: workspace, contact_phone: ctx.recovery.contact_phone,
        reason_code: method === 'dtmf_9' ? 'dtmf_9' : 'spoken_stop',
        source_call_id: ctx.callControlID, suppressed_at: at,
        metadata: { recovery_id: ctx.recovery.id, attempt_id: ctx.attempt.id }
      });
      if (error && error.code !== '23505') throw error;
    } catch (error) {
      if (error.code !== '23505') throw error;
    }
    await rpc('record_luko_voice_consent', { p_event: {
      workspace_id: workspace, phone: ctx.recovery.contact_phone,
      wordpress_user_id: ctx.recovery.wordpress_user_id,
      voice_marketing_consent: false, ai_voice_consent: false,
      consent_version: ctx.recovery.voice_consent_version || 'vici_marketing_sms_voice_v1',
      source: method, occurred_at: at, dedupe_key: `voice-optout:${event.id}`,
      evidence_ref: `telnyx-event:${event.id}`
    } });
    const state = method === 'dtmf_9' ? 'VOICE_OPT_OUT_DTMF' : 'VOICE_OPT_OUT_SPOKEN';
    await patchAttempt(ctx.attempt.id, { state, opt_out_at: at, opt_out_method: method, completed_at: at });
    await patchRecovery(ctx.recovery.id, { voice_status: state, voice_completed_at: at });
    await timeline(ctx.recovery.id, state, at, { method });
    try { await commands.stopAudio(ctx.callControlID); } catch {}
    try { await commands.hangup(ctx.callControlID, commandID(), { env }); } catch {}
  }

  async function transfer(ctx, event) {
    if (TRANSFER_STATES.has(ctx.attempt.state) || TERMINAL_STATES.has(ctx.attempt.state)) return;
    const config = voiceConfiguration(env, ctx.settings);
    if (!config.transferNumber) {
      await fail(ctx, 'TRANSFER_FAILED', 'transfer_number_missing', occurred(event), [
        'ANSWERED', 'HUMAN_DETECTED', 'HUMAN_MESSAGE_PLAYING'
      ]);
      try { await commands.hangup(ctx.callControlID, commandID(), { env }); } catch {}
      return;
    }
    if (!await transitionAttempt(ctx.attempt.id, [
      'ANSWERED', 'HUMAN_DETECTED', 'HUMAN_MESSAGE_PLAYING'
    ], { state: 'TRANSFER_REQUESTED', transfer_requested_at: occurred(event) })) return;
    if (!await transitionRecovery(ctx.recovery.id, [
      'ANSWERED', 'HUMAN_DETECTED', 'HUMAN_MESSAGE_PLAYING'
    ], { voice_status: 'TRANSFER_REQUESTED' })) return;
    await timeline(ctx.recovery.id, 'VOICE_TRANSFER_REQUESTED', occurred(event));
    try { await commands.stopAudio(ctx.callControlID); } catch {}
    try {
      await commands.transfer(ctx.callControlID, config.transferNumber, env.TELNYX_PHONE_NUMBER,
        'Vici Peptides', commandID(), { env });
    } catch {
      await fail(ctx, 'TRANSFER_FAILED', 'voice_transfer_failed', occurred(event), ['TRANSFER_REQUESTED']);
      try { await commands.hangup(ctx.callControlID, commandID(), { env }); } catch {}
      return;
    }
    if (await transitionAttempt(ctx.attempt.id, ['TRANSFER_REQUESTED'], { state: 'TRANSFER_INITIATED' })) {
      await transitionRecovery(ctx.recovery.id, ['TRANSFER_REQUESTED'], { voice_status: 'TRANSFER_INITIATED' });
    }
  }

  async function handle(event) {
    const ctx = await resolve(event);
    if (!ctx) return { handled: false };
    const payload = event.payload || {};
    const at = occurred(event);
    const type = event.event_type;

    if (ctx.recovery.order_id && ![
      'TRANSFER_CONNECTED', 'VOICE_OPT_OUT_DTMF', 'VOICE_OPT_OUT_SPOKEN', 'CANCELLED_PURCHASED'
    ].includes(ctx.recovery.voice_status)) {
      await patchAttempt(ctx.attempt.id, { state: 'CANCELLED_PURCHASED', completed_at: at });
      await patchRecovery(ctx.recovery.id, { voice_status: 'CANCELLED_PURCHASED', voice_completed_at: at });
      try { await commands.hangup(ctx.callControlID, commandID(), { env }); } catch {}
      return { handled: true, cancelled: 'purchase' };
    }

    if (type === 'call.initiated') {
      if (ctx.attempt.state !== 'DIALING') return { handled: true };
      if (!await transitionAttempt(ctx.attempt.id, ['DIALING'], {
        state: 'INITIATED', call_control_id: payload.call_control_id,
        call_session_id: payload.call_session_id, call_leg_id: payload.call_leg_id
      })) return { handled: true };
      await transitionRecovery(ctx.recovery.id, ['DIALING'], {
        voice_status: 'INITIATED', voice_call_control_id: payload.call_control_id,
        voice_call_session_id: payload.call_session_id, voice_call_leg_id: payload.call_leg_id });
    } else if (type === 'call.answered') {
      if (TERMINAL_STATES.has(ctx.attempt.state) || SPEECH_STATES.has(ctx.attempt.state)
          || TRANSFER_STATES.has(ctx.attempt.state)) return { handled: true };
      if (!await transitionAttempt(ctx.attempt.id, ['INITIATED'], { state: 'ANSWERED', answered_at: at })) {
        return { handled: true };
      }
      if (!await transitionRecovery(ctx.recovery.id, ['INITIATED'], { voice_status: 'ANSWERED' })) {
        return { handled: true };
      }
      await timeline(ctx.recovery.id, 'VOICE_ANSWERED', at);
    } else if (type.includes('machine') && type.includes('detection')) {
      if (TERMINAL_STATES.has(ctx.attempt.state) || SPEECH_STATES.has(ctx.attempt.state)
          || TRANSFER_STATES.has(ctx.attempt.state)) return { handled: true };
      const result = String(payload.result || payload.answering_machine_detection_result || '').toLowerCase();
      const branch = amdBranch(result);
      const answeredAt = ctx.attempt.answered_at ? Date.parse(ctx.attempt.answered_at) : null;
      const detectionLatency = answeredAt ? Math.max(0, Date.parse(at) - answeredAt) : null;
      const greetingAlreadyEnded = ctx.attempt.state === 'GREETING_END_DETECTED';
      if (!await transitionAttempt(ctx.attempt.id, ['ANSWERED', 'GREETING_END_DETECTED'], {
        state: branch === 'human' ? 'HUMAN_DETECTED'
          : branch === 'machine' ? 'MACHINE_DETECTED'
            : branch === 'undeliverable' ? 'FAX_OR_SILENCE' : 'NOT_SURE',
        amd_result: result || 'unknown', amd_decided_at: at,
        human_answer_detection_latency_ms: detectionLatency,
        ...(!['human', 'machine'].includes(branch) ? { completed_at: at } : {})
      })) return { handled: true };
      if (branch === 'human') {
        if (!await transitionRecovery(ctx.recovery.id, ['ANSWERED', 'GREETING_END_DETECTED'], { voice_status: 'HUMAN_DETECTED' })) {
          return { handled: true };
        }
        await timeline(ctx.recovery.id, 'VOICE_HUMAN_DETECTED', at, { result, detection_latency_ms: detectionLatency });
        if (ctx.attempt.human_answer_mode === 'PRERECORDED') {
          try {
            await commands.transcribe(ctx.callControlID, commandID(), { env });
          } catch {
            await fail(ctx, 'FAILED', 'voice_transcription_failed', at, ['HUMAN_DETECTED']);
            try { await commands.hangup(ctx.callControlID, commandID(), { env }); } catch {}
            return { handled: true };
          }
          await speak(ctx, 'human', commandID());
        } else if (ctx.attempt.human_answer_mode === 'TRANSFER_ONLY') {
          await transfer(ctx, event);
        } else {
          await commands.hangup(ctx.callControlID, commandID(), { env });
        }
      } else if (branch === 'machine') {
        if (!await transitionRecovery(ctx.recovery.id, ['ANSWERED', 'GREETING_END_DETECTED'], { voice_status: 'MACHINE_DETECTED' })) {
          return { handled: true };
        }
        await timeline(ctx.recovery.id, 'VOICE_MACHINE_DETECTED', at, { result });
        if (result.includes('beep') || greetingAlreadyEnded) await speak(ctx, 'machine', commandID());
        else scheduleMachineSpeechFallback(ctx);
      } else {
        const state = branch === 'undeliverable' ? 'FAX_OR_SILENCE' : 'NOT_SURE';
        await transitionRecovery(ctx.recovery.id, ['ANSWERED'], { voice_status: state, voice_completed_at: at });
        try { await commands.hangup(ctx.callControlID, commandID(), { env }); } catch {}
      }
    } else if (type.includes('greeting.ended')) {
      if (TERMINAL_STATES.has(ctx.attempt.state) || SPEECH_STATES.has(ctx.attempt.state)
          || TRANSFER_STATES.has(ctx.attempt.state)) return { handled: true };
      // Premium AMD can deliver greeting-ended before detection-ended. Keep
      // that fact in the durable state and wait for the classification; the
      // later machine event will then start speech immediately.
      if (ctx.attempt.state === 'ANSWERED') {
        if (!await transitionAttempt(ctx.attempt.id, ['ANSWERED'], {
          state: 'GREETING_END_DETECTED'
        })) return { handled: true };
        if (!await transitionRecovery(ctx.recovery.id, ['ANSWERED'], {
          voice_status: 'GREETING_END_DETECTED'
        })) return { handled: true };
        await timeline(ctx.recovery.id, 'VOICE_GREETING_END_DETECTED', at, {
          result: payload.result || null, pending_detection: true
        });
        return { handled: true };
      }
      if (!await transitionAttempt(ctx.attempt.id, ['MACHINE_DETECTED'], {
        state: 'GREETING_END_DETECTED'
      })) return { handled: true };
      if (!await transitionRecovery(ctx.recovery.id, ['MACHINE_DETECTED'], {
        voice_status: 'GREETING_END_DETECTED'
      })) return { handled: true };
      await timeline(ctx.recovery.id, 'VOICE_GREETING_END_DETECTED', at, { result: payload.result || null });
      await speak(ctx, 'machine', commandID());
    } else if (type === 'call.speak.started') {
      if (TERMINAL_STATES.has(ctx.attempt.state)) return { handled: true };
      const answeredAt = ctx.attempt.answered_at ? Date.parse(ctx.attempt.answered_at) : null;
      const firstAudioLatency = answeredAt ? Math.max(0, Date.parse(at) - answeredAt) : null;
      await patchAttempt(ctx.attempt.id, { first_audio_at: at, human_answer_first_audio_latency_ms: firstAudioLatency });
      await timeline(ctx.recovery.id, 'VOICE_FIRST_AUDIO', at, { latency_ms: firstAudioLatency });
    } else if (type === 'call.speak.ended') {
      if (!['VOICEMAIL_PLAYING', 'HUMAN_MESSAGE_PLAYING'].includes(ctx.attempt.state)) {
        return { handled: true };
      }
      const voicemail = ctx.attempt.state === 'VOICEMAIL_PLAYING';
      const state = voicemail ? 'VOICEMAIL_PLAYED' : 'HUMAN_MESSAGE_PLAYED';
      if (!await transitionAttempt(ctx.attempt.id, [ctx.attempt.state], { state, completed_at: at,
        ...(voicemail ? { voicemail_played_at: at } : { human_message_played_at: at }) })) {
        return { handled: true };
      }
      if (!await transitionRecovery(ctx.recovery.id, [ctx.attempt.state], {
        voice_status: state, voice_completed_at: at
      })) return { handled: true };
      await timeline(ctx.recovery.id, `VOICE_${state}`, at);
      try { await commands.hangup(ctx.callControlID, commandID(), { env }); } catch {}
    } else if (type === 'call.dtmf.received') {
      const digit = String(payload.digit || payload.dtmf || '');
      if (digit === '9') await suppress(ctx, 'dtmf_9', event);
      else if (digit === '#') await transfer(ctx, event);
    } else if (type === 'call.transcription') {
      const data = payload.transcription_data || {};
      if (data.is_final === true && isSpokenOptOut(data.transcript)) await suppress(ctx, 'spoken_stop', event);
      // Deliberately do not persist the transcript.
    } else if (type === 'call.bridged' || type === 'call.transfer.completed') {
      if (['VOICE_OPT_OUT_DTMF', 'VOICE_OPT_OUT_SPOKEN', 'CANCELLED_PURCHASED', 'TRANSFER_CONNECTED']
        .includes(ctx.attempt.state)) return { handled: true };
      if (!await transitionAttempt(ctx.attempt.id, ['TRANSFER_REQUESTED', 'TRANSFER_INITIATED', 'TRANSFER_RINGING'], {
        state: 'TRANSFER_CONNECTED', transfer_connected_at: at
      })) return { handled: true };
      if (!await transitionRecovery(ctx.recovery.id, ['TRANSFER_REQUESTED', 'TRANSFER_INITIATED', 'TRANSFER_RINGING'], {
        voice_status: 'TRANSFER_CONNECTED', voice_transfer_connected_at: at
      })) return { handled: true };
      await timeline(ctx.recovery.id, 'VOICE_TRANSFER_CONNECTED', at);
    } else if (type === 'call.hangup') {
      await patchAttempt(ctx.attempt.id, { completed_at: at });
      await patchRecovery(ctx.recovery.id, { voice_completed_at: at });
      await timeline(ctx.recovery.id, 'VOICE_CALL_ENDED', at, { cause: payload.hangup_cause || null });
    }
    return { handled: true };
  }

  return { handle, decodeClientState };
}

module.exports = { createVoiceEventHandler, decodeClientState };
