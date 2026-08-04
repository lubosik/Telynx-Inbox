'use strict';

function isInternalSIPLog(log) {
  return /^sip:/i.test(String(log?.to_number || '').trim());
}

function finalCallStatus({ direction, currentStatus, answeredAt }) {
  // A native-client outcome may reach the backend just before the Telnyx
  // hangup webhook. Never overwrite that stronger evidence.
  if (currentStatus === 'completed') return 'completed';
  if (answeredAt) return 'completed';
  return direction === 'inbound' ? 'missed' : 'failed';
}

function answeredAtFromDuration(endedAt, durationSeconds) {
  const endMs = Date.parse(endedAt || '');
  const seconds = Number(durationSeconds);
  if (!Number.isFinite(endMs) || !Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(endMs - Math.floor(seconds) * 1000).toISOString();
}

module.exports = { isInternalSIPLog, finalCallStatus, answeredAtFromDuration };
