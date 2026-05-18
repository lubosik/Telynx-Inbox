/**
 * GHL → Supabase history sync
 *
 * Requires GHL PIT token with scopes:
 *   contacts.readonly
 *   conversations.readonly
 *   conversations/message.readonly
 *
 * Run: node sync-ghl.js
 * Or POST /api/sync/ghl (from the inbox UI)
 */

require('dotenv').config();
const { supabase } = require('./db');

const BASE = 'https://services.leadconnectorhq.com';
const LOCATION_ID = process.env.GHL_LOCATION_ID;
let _locationToken = null;
let _tokenExpiry = 0;

async function getLocationToken() {
  if (_locationToken && Date.now() < _tokenExpiry) return _locationToken;

  const r = await fetch(`${BASE}/oauth/locationToken`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GHL_AGENCY_TOKEN}`,
      'Content-Type': 'application/json',
      'Version': '2021-07-28'
    },
    body: JSON.stringify({
      companyId: process.env.GHL_COMPANY_ID,
      locationId: LOCATION_ID
    })
  });

  if (!r.ok) {
    const err = await r.json();
    throw new Error(`GHL location token failed (${r.status}): ${err.message}. ` +
      `Your PIT token needs: contacts.readonly, conversations.readonly, conversations/message.readonly`);
  }

  const d = await r.json();
  _locationToken = d.access_token || d.accessToken;
  _tokenExpiry = Date.now() + (55 * 60 * 1000);
  return _locationToken;
}

function ghlHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Version': '2021-04-15'
  };
}

async function fetchAllContacts() {
  const token = await getLocationToken();
  const contacts = [];
  let page = 1;

  while (true) {
    const r = await fetch(
      `${BASE}/contacts/search?locationId=${LOCATION_ID}&limit=100&page=${page}`,
      { headers: ghlHeaders(token) }
    );
    if (!r.ok) {
      const err = await r.json();
      throw new Error(`Contacts fetch failed: ${err.message}`);
    }
    const d = await r.json();
    const batch = d.contacts || [];
    if (batch.length === 0) break;
    contacts.push(...batch);
    console.log(`  Fetched ${contacts.length} contacts so far...`);
    if (batch.length < 100) break;
    page++;
    await new Promise(r => setTimeout(r, 100));
  }

  return contacts;
}

async function fetchConversationsForContact(contactId, token) {
  const r = await fetch(
    `${BASE}/conversations/search?locationId=${LOCATION_ID}&contactId=${contactId}&limit=20`,
    { headers: ghlHeaders(token) }
  );
  if (!r.ok) return [];
  const d = await r.json();
  return d.conversations || [];
}

async function fetchMessagesForConversation(conversationId, token) {
  const messages = [];
  let lastId = null;

  while (true) {
    const url = lastId
      ? `${BASE}/conversations/${conversationId}/messages?limit=50&lastMessageId=${lastId}`
      : `${BASE}/conversations/${conversationId}/messages?limit=50`;

    const r = await fetch(url, { headers: ghlHeaders(token) });
    if (!r.ok) break;
    const d = await r.json();
    const batch = d.messages || d.lastMessageBody ? [] : [];
    const msgs = d.messages || [];
    if (msgs.length === 0) break;
    messages.push(...msgs);
    if (msgs.length < 50) break;
    lastId = msgs[msgs.length - 1].id;
    await new Promise(r => setTimeout(r, 100));
  }

  return messages;
}

function mapGHLDirection(ghlDirection) {
  // GHL: 0 = outbound, 1 = inbound (or strings 'outbound'/'inbound')
  if (typeof ghlDirection === 'number') return ghlDirection === 1 ? 'inbound' : 'outbound';
  return ghlDirection === 'inbound' ? 'inbound' : 'outbound';
}

async function syncContact(ghlContact) {
  const phone = ghlContact.phone;
  if (!phone) return { skipped: true };

  // Upsert contact
  await supabase.from('sms_contacts').upsert({
    phone,
    name: [ghlContact.firstName, ghlContact.lastName].filter(Boolean).join(' ') || null,
    ghl_contact_id: ghlContact.id,
    first_seen: ghlContact.dateAdded || new Date().toISOString(),
    last_seen: ghlContact.dateUpdated || new Date().toISOString()
  }, { onConflict: 'phone' });

  return { phone, ghlId: ghlContact.id };
}

async function syncMessages(phone, ghlContactId, ghlMessages) {
  if (!ghlMessages.length) return 0;

  let synced = 0;
  for (const msg of ghlMessages) {
    // Only sync SMS messages
    if (msg.type && msg.type !== 'SMS' && msg.type !== 10 && msg.type !== 1) continue;

    const body = msg.body || msg.message || msg.text;
    if (!body) continue;

    const direction = mapGHLDirection(msg.direction);
    const createdAt = msg.dateAdded || msg.createdAt || msg.timestamp || new Date().toISOString();

    const { error } = await supabase.from('sms_messages').upsert({
      telnyx_message_id: msg.id || `ghl-${ghlContactId}-${msg.dateAdded}`,
      contact_phone: phone,
      direction,
      body,
      status: 'delivered',
      ghl_contact_id: ghlContactId,
      ghl_message_id: msg.id,
      created_at: createdAt
    }, { onConflict: 'telnyx_message_id' });

    if (!error) synced++;
  }

  return synced;
}

async function runSync() {
  console.log('Starting GHL → Supabase sync...');

  let totalContacts = 0;
  let totalMessages = 0;
  let errors = [];

  try {
    const token = await getLocationToken();
    console.log('Got GHL location token OK');

    const contacts = await fetchAllContacts();
    console.log(`Found ${contacts.length} GHL contacts`);

    for (const c of contacts) {
      if (!c.phone) continue;

      try {
        const { phone, ghlId } = await syncContact(c);
        totalContacts++;

        // Get conversations for this contact
        const convos = await fetchConversationsForContact(c.id, token);
        for (const conv of convos) {
          if (conv.lastMessageType !== 'TYPE_SMS' && conv.type !== 'SMS' && conv.channel !== 'sms') continue;

          const msgs = await fetchMessagesForConversation(conv.id, token);
          const synced = await syncMessages(phone, ghlId, msgs);
          totalMessages += synced;
          if (msgs.length > 0) {
            await new Promise(r => setTimeout(r, 100));
          }
        }
      } catch (err) {
        errors.push({ phone: c.phone, error: err.message });
      }
    }

    // Update last_seen and unread_count from messages
    await supabase.rpc('refresh_contact_stats').catch(() => {});

  } catch (err) {
    console.error('Sync failed:', err.message);
    return { success: false, error: err.message };
  }

  const result = {
    success: true,
    contacts_synced: totalContacts,
    messages_synced: totalMessages,
    errors: errors.length,
    error_details: errors
  };

  console.log('Sync complete:', result);
  return result;
}

module.exports = { runSync };

// Run directly if called as script
if (require.main === module) {
  runSync().then(r => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.success ? 0 : 1);
  });
}
