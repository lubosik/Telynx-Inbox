'use strict';
/**
 * lib/mms-media.js — inbound MMS media handling
 *
 * Telnyx inbound media URLs expire after 30 days (and may require API-key auth
 * depending on which doc you read), so we download each attachment at webhook
 * time and re-host it in the public `mms-media` Supabase Storage bucket.
 * If the download or upload fails we fall back to storing the original
 * Telnyx URL — a 30-day picture beats a dropped one.
 */

const { supabase } = require('../db');

const BUCKET = 'mms-media';
const MAX_INBOUND_BYTES = 5 * 1024 * 1024; // 5MB safety cap per attachment

const EXT_BY_TYPE = {
  'image/jpeg': 'jpg',
  'image/png':  'png',
  'image/gif':  'gif',
  'image/webp': 'webp',
  'image/bmp':  'bmp',
  'video/mp4':  'mp4',
  'video/3gpp': '3gp',
  'text/vcard': 'vcf'
};

function extFor(contentType) {
  return EXT_BY_TYPE[(contentType || '').toLowerCase().split(';')[0]] || 'bin';
}

// Plain GET first; Telnyx docs conflict on whether inbound media URLs need
// auth, so fall back to an API-key-authenticated GET before giving up.
async function fetchTelnyxMedia(url) {
  let res = await fetch(url);
  if (!res.ok) {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` }
    });
  }
  if (!res.ok) throw new Error(`media fetch ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_INBOUND_BYTES) throw new Error(`media too large (${buf.length} bytes)`);
  return buf;
}

/**
 * Downloads each inbound media item and re-hosts it in Supabase Storage.
 * Returns [{ url, content_type }] — our public URL when re-hosting worked,
 * the original Telnyx URL otherwise. Never throws.
 */
async function rehostInboundMedia(messageId, media) {
  const items = Array.isArray(media) ? media : [];
  const out = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item?.url) continue;
    const contentType = item.content_type || 'application/octet-stream';

    try {
      const buf = await fetchTelnyxMedia(item.url);
      const path = `inbound/${messageId}-${i}.${extFor(contentType)}`;

      const { error } = await supabase.storage
        .from(BUCKET)
        .upload(path, buf, { contentType, upsert: true });
      if (error) throw new Error(error.message);

      const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
      out.push({ url: data.publicUrl, content_type: contentType });
      console.log(`[MMS] Re-hosted inbound media ${i} for ${messageId} (${buf.length} bytes)`);
    } catch (err) {
      console.error(`[MMS] Re-host failed for ${messageId} item ${i}: ${err.message} — keeping Telnyx URL`);
      out.push({ url: item.url, content_type: contentType });
    }
  }

  return out;
}

module.exports = { rehostInboundMedia, BUCKET, extFor };
