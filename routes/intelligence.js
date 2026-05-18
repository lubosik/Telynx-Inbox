const router = require('express').Router();
const { supabase } = require('../db');
const { analyseConversation, generateCampaignBrief } = require('../intelligence');
const { sendSMS } = require('../telnyx');

router.get('/campaigns/overview', async (req, res) => {
  try {
    const brief = await generateCampaignBrief();
    res.json(brief);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/campaigns/all', async (req, res) => {
  const { status } = req.query;
  let query = supabase.from('sms_campaign_suggestions').select('*')
    .order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);
  const { data } = await query;
  res.json(data || []);
});

router.post('/campaigns/:id/dismiss', async (req, res) => {
  await supabase.from('sms_campaign_suggestions')
    .update({ status: 'dismissed' }).eq('id', req.params.id);
  res.json({ success: true });
});

router.post('/campaigns/:id/send', async (req, res) => {
  const { data: suggestion } = await supabase
    .from('sms_campaign_suggestions').select('*').eq('id', req.params.id).single();
  if (!suggestion) return res.status(404).json({ error: 'Not found' });
  try {
    await sendSMS(suggestion.contact_phone, suggestion.suggested_message);
    await supabase.from('sms_campaign_suggestions')
      .update({ status: 'sent' }).eq('id', req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/analyse/:phone', async (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  try {
    const result = await analyseConversation(phone);
    res.json({ success: true, profile: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:phone', async (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  const { data: profile } = await supabase
    .from('sms_customer_profiles').select('*').eq('contact_phone', phone).maybeSingle();
  const { data: suggestions } = await supabase
    .from('sms_campaign_suggestions').select('*')
    .eq('contact_phone', phone).eq('status', 'pending').order('created_at', { ascending: false });
  res.json({ profile: profile || null, suggestions: suggestions || [] });
});

module.exports = router;
