'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL ||= 'https://unit-test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'unit-test-service-key';

const {
  archiveCallRecording,
  privateCallLog,
  signedRecordingURL,
  validRecordingID
} = require('../lib/private-recordings');

function storageClient(capture) {
  return {
    storage: {
      from(bucket) {
        capture.bucket = bucket;
        return {
          async upload(path, body, options) {
            Object.assign(capture, { path, body, options });
            return { error: null };
          },
          async createSignedUrl(path, seconds) {
            Object.assign(capture, { path, seconds });
            return { data: { signedUrl: 'https://private.example/signed' }, error: null };
          }
        };
      }
    }
  };
}

test('archives a Telnyx recording into the private bucket without retaining its provider URL', async () => {
  const capture = {};
  const calls = [];
  const fetchImpl = async url => {
    calls.push(String(url));
    if (calls.length === 1) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: {
          id: 'recording-1',
          download_urls: { mp3: 'https://s3.amazonaws.com/private/provider-link' }
        } })
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => '4' },
      arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer
    };
  };

  const fields = await archiveCallRecording('recording-1', {
    client: storageClient(capture),
    fetchImpl,
    env: { TELNYX_API_KEY: 'test-key', CALL_RECORDING_RETENTION_DAYS: '30' }
  });

  assert.equal(calls[0], 'https://api.telnyx.com/v2/recordings/recording-1');
  assert.equal(capture.bucket, 'call-recordings');
  assert.equal(capture.path, 'recordings/recording-1.mp3');
  assert.equal(capture.options.contentType, 'audio/mpeg');
  assert.equal(fields.recording_url_mp3, null);
  assert.equal(fields.recording_storage_path, 'recordings/recording-1.mp3');
  assert.ok(fields.recording_expires_at);
});

test('call-log JSON hides storage and provider URLs behind authenticated playback', () => {
  const value = privateCallLog({
    id: 42,
    contact_phone: '+15555550100',
    recording_id: 'provider-recording-secret',
    recording_storage_path: 'recordings/secret.mp3',
    recording_url_mp3: 'https://provider.example/temporary-secret',
    recording_url_wav: 'https://provider.example/temporary-secret.wav'
  });
  assert.equal(value.recording_url_mp3, '/api/voice/recordings/42');
  assert.equal(value.recording_url, '/api/voice/recordings/42');
  assert.equal(value.recording_available, true);
  assert.equal('recording_storage_path' in value, false);
  assert.equal('recording_id' in value, false);
  assert.equal(JSON.stringify(value).includes('provider.example'), false);
});

test('private playback creates a short-lived signed URL and rejects unsafe ids', async () => {
  const capture = {};
  const url = await signedRecordingURL('recordings/recording-1.mp3', {
    client: storageClient(capture),
    env: { CALL_RECORDING_SIGNED_URL_SECONDS: '60' }
  });
  assert.equal(url, 'https://private.example/signed');
  assert.equal(capture.seconds, 60);
  assert.equal(validRecordingID('recording-1'), true);
  assert.equal(validRecordingID('../secret'), false);
  await assert.rejects(
    () => signedRecordingURL('recordings/../secret.mp3', { client: storageClient({}) }),
    /invalid private recording path/
  );
});
