'use strict';
/**
 * routes/upload.js — POST /api/upload
 *
 * Accepts a base64-encoded image from the composer, stores it in the public
 * `mms-media` Supabase Storage bucket, and returns the public URL for use as
 * a Telnyx media_url. The frontend downscales/re-encodes to JPEG before
 * uploading, so files arriving here should already be well under the limit.
 *
 * Body: { filename, contentType, data } — data is raw base64 (no data: prefix)
 */

const crypto = require('crypto');
const { supabase } = require('../db');
const { BUCKET, extFor } = require('../lib/mms-media');

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_BYTES = 1024 * 1024; // 1MB hard cap — carrier-safe target is ~600KB total

const router = require('express').Router();

router.post('/', async (req, res) => {
  try {
    const { contentType, data } = req.body || {};

    if (!data || typeof data !== 'string') {
      return res.status(400).json({ error: 'data (base64) required' });
    }
    const type = (contentType || '').toLowerCase().split(';')[0];
    if (!ALLOWED_TYPES.has(type)) {
      return res.status(400).json({ error: `Unsupported type ${type} — use JPEG, PNG, GIF or WebP` });
    }

    let buf;
    try {
      buf = Buffer.from(data, 'base64');
    } catch {
      return res.status(400).json({ error: 'Invalid base64 data' });
    }
    if (!buf.length) return res.status(400).json({ error: 'Empty file' });
    if (buf.length > MAX_BYTES) {
      return res.status(413).json({ error: `Image too large (${Math.round(buf.length / 1024)}KB, max ${MAX_BYTES / 1024}KB)` });
    }

    const path = `outbound/${crypto.randomUUID()}.${extFor(type)}`;
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(path, buf, { contentType: type });
    if (error) {
      console.error('[UPLOAD] Storage error:', error.message);
      return res.status(500).json({ error: 'Upload failed' });
    }

    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
    console.log(`[UPLOAD] Stored ${path} (${buf.length} bytes)`);
    res.json({ url: pub.publicUrl, content_type: type, size: buf.length });
  } catch (err) {
    console.error('[UPLOAD] Error:', err.message);
    res.status(500).json({ error: 'Upload failed' });
  }
});

module.exports = router;
