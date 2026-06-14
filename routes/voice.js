const router = require('express').Router();
const { supabase } = require('../db');

// GET /api/voice/token — returns SIP credentials for WebRTC SDK
// Protected by requireAuth at mount point in server.js
router.get('/token', async (req, res) => {
  try {
    res.json({
      login: process.env.TELNYX_SIP_USERNAME,
      password: process.env.TELNYX_SIP_PASSWORD,
      callerNumber: process.env.TELNYX_PHONE_NUMBER
    });
  } catch (err) {
    console.error('[VOICE] Token error:', err.message);
    res.status(500).json({ error: 'Could not get voice credentials' });
  }
});

// GET /api/voice/logs?phone=&page=1
router.get('/logs', async (req, res) => {
  const { phone, page = 1 } = req.query;
  const limit = 50;
  const offset = (parseInt(page) - 1) * limit;

  let query = supabase
    .from('call_logs')
    .select('*')
    .order('started_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (phone) query = query.eq('contact_phone', decodeURIComponent(phone));

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// GET /api/voice/logs/:id
router.get('/logs/:id', async (req, res) => {
  const { data } = await supabase
    .from('call_logs')
    .select('*')
    .eq('id', req.params.id)
    .single();
  res.json(data || null);
});

// POST /api/voice/logs — client-side fallback when Telnyx webhook doesn't fire
router.post('/logs', async (req, res) => {
  const { call_control_id, direction, contact_phone, from_number, to_number,
          duration_seconds, status, started_at, ended_at } = req.body;

  if (!contact_phone) return res.status(400).json({ error: 'contact_phone required' });

  const { error } = await supabase.from('call_logs').upsert({
    call_control_id: call_control_id || `client-${Date.now()}`,
    direction: direction || 'outbound',
    contact_phone,
    from_number: from_number || null,
    to_number: to_number || null,
    duration_seconds: duration_seconds || 0,
    status: status || 'completed',
    started_at: started_at || new Date().toISOString(),
    ended_at: ended_at || new Date().toISOString(),
    answered_at: duration_seconds > 0 ? (ended_at || new Date().toISOString()) : null
  }, { onConflict: 'call_control_id' });

  if (error) {
    console.error('[VOICE] Log save error:', error.message);
    return res.status(500).json({ error: error.message });
  }
  res.json({ ok: true });
});

// POST /api/voice/sip-ready — app fires this when TelnyxRTC registers (telnyx.ready event).
// Transfers immediately if music is already playing; if speak is still in progress (stage 1),
// POST /api/voice/recording/start
router.post('/recording/start', async (req, res) => {
  const { call_control_id } = req.body;
  if (!call_control_id) return res.status(400).json({ error: 'call_control_id required' });

  try {
    const response = await fetch(
      `https://api.telnyx.com/v2/calls/${call_control_id}/actions/record_start`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ format: 'mp3', channels: 'dual', play_beep: true })
      }
    );
    if (!response.ok) {
      const err = await response.json();
      return res.status(400).json({ error: err?.errors?.[0]?.detail || 'Recording start failed' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/voice/recording/stop
router.post('/recording/stop', async (req, res) => {
  const { call_control_id } = req.body;
  if (!call_control_id) return res.status(400).json({ error: 'call_control_id required' });

  try {
    await fetch(
      `https://api.telnyx.com/v2/calls/${call_control_id}/actions/record_stop`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({})
      }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
