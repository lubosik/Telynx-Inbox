const { supabase } = require('./db');
const ghl = require('./ghl');

const SYSTEM_PROMPT = `You are an AI analyst for Vici Peptides, a US research peptide e-commerce store.
Vici sells: BPC-157, TB-500, Semaglutide, Tirzepatide, CJC-1295, Ipamorelin,
AOD-9604, GHK-Cu, PT-141, Melanotan II, Hexarelin, GHRP-6, Semax, Selank.

Analyse the SMS conversation and return ONLY a valid JSON object.
No markdown. No backticks. No explanation. Just the raw JSON.

{
  "inferred_interests": ["product names mentioned or implied"],
  "order_signals": ["phrases showing purchase intent"],
  "restock_interests": ["products they want when back in stock"],
  "sentiment": "positive OR neutral OR negative",
  "raw_summary": "2-3 sentence plain English customer summary",
  "campaign_recommendations": [
    {
      "type": "restock_alert OR targeted_offer OR win_back OR upsell OR educational",
      "reason": "why this campaign suits this customer",
      "suggested_message": "ready to send SMS under 160 chars, natural tone"
    }
  ]
}`;

async function analyseConversation(phone) {
  const { data: messages } = await supabase
    .from('sms_messages')
    .select('direction, body, created_at')
    .eq('contact_phone', phone)
    .order('created_at', { ascending: true });

  if (!messages || messages.length === 0) return null;

  const conversation = messages
    .map(m => `${m.direction === 'inbound' ? 'Customer' : 'Vici'}: ${m.body}`)
    .join('\n');

  let parsed;
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.APP_URL || 'https://vici-sms.railway.app',
        'X-Title': 'Vici SMS Intelligence'
      },
      body: JSON.stringify({
        model: process.env.OPENROUTER_MODEL || 'anthropic/claude-3.5-haiku',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Conversation:\n${conversation}` }
        ],
        max_tokens: 1000,
        temperature: 0.3
      })
    });
    const data = await response.json();
    const raw = data.choices[0].message.content;
    const clean = raw.replace(/```json|```/g, '').trim();
    parsed = JSON.parse(clean);
  } catch (err) {
    console.error('OpenRouter analysis failed:', err.message);
    return null;
  }

  const { data: contact } = await supabase
    .from('sms_contacts')
    .select('ghl_contact_id')
    .eq('phone', phone)
    .single();

  await supabase.from('sms_customer_profiles').upsert({
    contact_phone: phone,
    ghl_contact_id: contact?.ghl_contact_id,
    inferred_interests: parsed.inferred_interests || [],
    order_signals: parsed.order_signals || [],
    restock_interests: parsed.restock_interests || [],
    campaign_recommendations: parsed.campaign_recommendations || [],
    sentiment: parsed.sentiment || 'neutral',
    raw_summary: parsed.raw_summary || '',
    last_analysed: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }, { onConflict: 'contact_phone' });

  if (contact?.ghl_contact_id) {
    await ghl.addContactNote(contact.ghl_contact_id,
      `AI Summary: ${parsed.raw_summary}`);
    if (parsed.inferred_interests?.length > 0) {
      const tags = parsed.inferred_interests
        .map(p => `interested-${p.toLowerCase().replace(/[^a-z0-9]/g, '-')}`);
      await ghl.addContactTags(contact.ghl_contact_id, tags);
    }
  }

  if (parsed.campaign_recommendations?.length > 0) {
    const suggestions = parsed.campaign_recommendations.map(r => ({
      contact_phone: phone,
      suggestion_type: r.type,
      suggestion_text: r.reason,
      suggested_message: r.suggested_message,
      status: 'pending'
    }));
    await supabase.from('sms_campaign_suggestions').insert(suggestions);
  }

  await supabase.from('sms_messages')
    .update({ ai_processed: true })
    .eq('contact_phone', phone);

  return parsed;
}

async function generateCampaignBrief() {
  const { data: suggestions } = await supabase
    .from('sms_campaign_suggestions')
    .select('*')
    .eq('status', 'pending');

  if (!suggestions || suggestions.length === 0) {
    return { total_contacts: 0, by_type: {}, overall_insight: 'No pending campaign suggestions.' };
  }

  const byType = {};
  suggestions.forEach(s => {
    if (!byType[s.suggestion_type]) byType[s.suggestion_type] = [];
    byType[s.suggestion_type].push(s);
  });

  const uniquePhones = [...new Set(suggestions.map(s => s.contact_phone))];

  let overallInsight = '';
  try {
    const summaries = suggestions.slice(0, 20).map(s =>
      `${s.contact_phone}: ${s.suggestion_type} — ${s.suggestion_text}`
    ).join('\n');

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.APP_URL || '',
        'X-Title': 'Vici SMS Intelligence'
      },
      body: JSON.stringify({
        model: process.env.OPENROUTER_MODEL || 'anthropic/claude-3.5-haiku',
        messages: [{
          role: 'user',
          content: `You are an analyst for Vici Peptides. Based on these customer signals,
write a 2-3 sentence insight about what customers are currently asking for and what
campaigns would perform best right now. Be specific and actionable.\n\n${summaries}`
        }],
        max_tokens: 300,
        temperature: 0.5
      })
    });
    const data = await response.json();
    overallInsight = data.choices[0].message.content;
  } catch (err) {
    console.error('Campaign brief OpenRouter call failed:', err.message);
  }

  return {
    total_contacts: uniquePhones.length,
    total_suggestions: suggestions.length,
    by_type: Object.entries(byType).reduce((acc, [type, items]) => {
      acc[type] = {
        count: items.length,
        contacts: [...new Set(items.map(i => i.contact_phone))],
        sample_message: items[0]?.suggested_message || ''
      };
      return acc;
    }, {}),
    overall_insight: overallInsight
  };
}

module.exports = { analyseConversation, generateCampaignBrief };
