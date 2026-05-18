require('dotenv').config();
const { supabase } = require('./db');

const BASE = 'https://services.leadconnectorhq.com';
const LOCATION_ID = process.env.GHL_LOCATION_ID;

function ghlHeaders() {
  return {
    'Authorization': `Bearer ${process.env.GHL_AGENCY_TOKEN}`,
    'Content-Type': 'application/json',
    'Version': '2021-04-15'
  };
}

function isValidPhone(phone) {
  if (!phone) return false;
  const digits = phone.replace(/\D/g, '');
  // Must be 10-15 digits to be a real phone number
  return digits.length >= 10 && digits.length <= 15;
}

async function fetchAllContacts() {
  const contacts = [];
  let startAfter = null;
  let startAfterId = null;

  while (true) {
    let url = `${BASE}/contacts/?locationId=${LOCATION_ID}&limit=100`;
    if (startAfter && startAfterId) {
      url += `&startAfter=${startAfter}&startAfterId=${startAfterId}`;
    }

    const r = await fetch(url, { headers: ghlHeaders() });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(`Contacts fetch failed (${r.status}): ${err.message || r.statusText}`);
    }
    const d = await r.json();
    const batch = d.contacts || [];
    if (batch.length === 0) break;

    contacts.push(...batch);
    process.stdout.write(`\r  Fetched ${contacts.length} / ${d.meta?.total || '?'} contacts...`);

    if (!d.meta?.nextPageUrl) break;
    startAfter = d.meta.startAfter;
    startAfterId = d.meta.startAfterId;
    await new Promise(r => setTimeout(r, 150));
  }

  console.log('');
  return contacts;
}

async function fetchAllConversations() {
  const convos = [];
  let page = 1;

  while (true) {
    const r = await fetch(
      `${BASE}/conversations/search?locationId=${LOCATION_ID}&limit=100&page=${page}`,
      { headers: ghlHeaders() }
    );
    if (!r.ok) break;
    const d = await r.json();
    const batch = d.conversations || [];
    convos.push(...batch);
    if (batch.length < 100 || !d.nextPage) break;
    page++;
    await new Promise(r => setTimeout(r, 150));
  }

  return convos;
}

async function fetchMessagesForConversation(conversationId) {
  const r = await fetch(
    `${BASE}/conversations/${conversationId}/messages?limit=100`,
    { headers: ghlHeaders() }
  );
  if (!r.ok) return [];
  const d = await r.json();
  // GHL wraps messages: { messages: { messages: [...], nextPage, lastMessageId } }
  const inner = d.messages;
  if (!inner) return [];
  if (Array.isArray(inner)) return inner;
  if (Array.isArray(inner.messages)) return inner.messages;
  return [];
}

function mapGHLDirection(dir) {
  if (typeof dir === 'number') return dir === 1 ? 'inbound' : 'outbound';
  return String(dir).toLowerCase() === 'inbound' ? 'inbound' : 'outbound';
}

function isSMSMessage(msg) {
  // GHL type: 1=SMS, 2=Email, 3=Note, 20=Custom SMS
  const t = msg.type;
  if (!t) return true;
  return t === 1 || t === 20 || msg.messageType === 'TYPE_SMS' || msg.messageType === 'TYPE_CUSTOM_SMS';
}

async function runSync() {
  console.log('Starting GHL → Supabase sync...');
  let contactsSynced = 0;
  let messagesSynced = 0;
  const errors = [];

  try {
    // 1. Sync all contacts that have a valid phone number
    console.log('Fetching GHL contacts...');
    const allContacts = await fetchAllContacts();
    const phoneContacts = allContacts.filter(c => isValidPhone(c.phone));
    console.log(`${allContacts.length} total contacts | ${phoneContacts.length} have valid phone numbers`);

    const upserts = phoneContacts.map(c => ({
      phone: c.phone,
      name: [c.firstName, c.lastName].filter(Boolean).join(' ') || null,
      ghl_contact_id: c.id,
      first_seen: c.dateAdded || new Date().toISOString(),
      last_seen: c.dateUpdated || c.dateAdded || new Date().toISOString()
    }));

    // Batch upsert contacts in groups of 50
    for (let i = 0; i < upserts.length; i += 50) {
      const batch = upserts.slice(i, i + 50);
      const { error } = await supabase.from('sms_contacts').upsert(batch, { onConflict: 'phone' });
      if (error) errors.push({ context: 'contacts batch', error: error.message });
      else contactsSynced += batch.length;
    }
    console.log(`Synced ${contactsSynced} contacts to Supabase`);

    // Build phone lookup by GHL contactId
    const phoneByGhlId = {};
    phoneContacts.forEach(c => { phoneByGhlId[c.id] = c.phone; });

    // 2. Sync all SMS conversations and their messages
    console.log('Fetching GHL conversations...');
    const allConvos = await fetchAllConversations();
    const smsConvos = allConvos.filter(c =>
      c.lastMessageType === 'TYPE_SMS' ||
      c.lastMessageType === 'TYPE_CUSTOM_SMS' ||
      c.type === 'SMS'
    );
    console.log(`${allConvos.length} total conversations | ${smsConvos.length} are SMS`);

    for (const conv of smsConvos) {
      const phone = phoneByGhlId[conv.contactId];
      if (!phone) continue;

      try {
        const msgs = await fetchMessagesForConversation(conv.id);
        const smsMsgs = msgs.filter(isSMSMessage);

        for (const msg of smsMsgs) {
          const body = msg.body || msg.message || msg.text;
          if (!body) continue;

          const { error } = await supabase.from('sms_messages').upsert({
            telnyx_message_id: msg.id || `ghl-${conv.id}-${msg.dateAdded}`,
            contact_phone: phone,
            direction: mapGHLDirection(msg.direction),
            body,
            status: 'delivered',
            ghl_contact_id: conv.contactId,
            ghl_conversation_id: conv.id,
            ghl_message_id: msg.id,
            created_at: msg.dateAdded || new Date().toISOString()
          }, { onConflict: 'telnyx_message_id' });

          if (!error) messagesSynced++;
        }

        // Update contact's last_seen to latest message timestamp
        if (smsMsgs.length > 0) {
          const lastMsg = smsMsgs[smsMsgs.length - 1];
          await supabase.from('sms_contacts')
            .update({ last_seen: lastMsg.dateAdded || new Date().toISOString() })
            .eq('phone', phone);
        }

        await new Promise(r => setTimeout(r, 100));
      } catch (err) {
        errors.push({ conv: conv.id, phone, error: err.message });
      }
    }

    console.log(`Synced ${messagesSynced} messages from ${smsConvos.length} SMS conversations`);

  } catch (err) {
    console.error('Sync error:', err.message);
    return { success: false, error: err.message };
  }

  const result = {
    success: true,
    contacts_synced: contactsSynced,
    messages_synced: messagesSynced,
    errors: errors.length,
    ...(errors.length > 0 && { error_details: errors })
  };

  console.log('Sync complete:', result);
  return result;
}

module.exports = { runSync };

if (require.main === module) {
  runSync().then(r => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.success ? 0 : 1);
  });
}
