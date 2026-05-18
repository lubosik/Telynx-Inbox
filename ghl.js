const GHL_BASE = 'https://services.leadconnectorhq.com';

function ghlHeaders() {
  return {
    'Authorization': `Bearer ${process.env.GHL_AGENCY_TOKEN}`,
    'Content-Type': 'application/json',
    'Version': '2021-04-15'
  };
}

async function searchContactByPhone(phone) {
  try {
    const url = `${GHL_BASE}/contacts/search?locationId=${process.env.GHL_LOCATION_ID}&phone=${encodeURIComponent(phone)}`;
    const res = await fetch(url, { headers: ghlHeaders() });
    if (!res.ok) {
      console.error('GHL search failed:', res.status, await res.text());
      return null;
    }
    const data = await res.json();
    return data?.contacts?.[0] || null;
  } catch (err) {
    console.error('GHL searchContactByPhone error:', err.message);
    return null;
  }
}

async function createContact(phone, name = '') {
  try {
    const res = await fetch(`${GHL_BASE}/contacts`, {
      method: 'POST',
      headers: ghlHeaders(),
      body: JSON.stringify({
        locationId: process.env.GHL_LOCATION_ID,
        phone,
        firstName: name || 'SMS Customer',
        source: 'Vici SMS Inbox'
      })
    });
    if (!res.ok) {
      console.error('GHL createContact failed:', res.status, await res.text());
      return null;
    }
    const data = await res.json();
    return data?.contact?.id || null;
  } catch (err) {
    console.error('GHL createContact error:', err.message);
    return null;
  }
}

async function upsertContact(phone, name = '') {
  const existing = await searchContactByPhone(phone);
  if (existing) return { contactId: existing.id, isNew: false };
  const id = await createContact(phone, name);
  return { contactId: id, isNew: true };
}

async function addInboundMessage(contactId, body) {
  try {
    const res = await fetch(`${GHL_BASE}/conversations/messages/inbound`, {
      method: 'POST',
      headers: ghlHeaders(),
      body: JSON.stringify({
        type: 'SMS',
        contactId,
        locationId: process.env.GHL_LOCATION_ID,
        message: body,
        direction: 'inbound'
      })
    });
    if (!res.ok) {
      console.error('GHL addInboundMessage failed:', res.status, await res.text());
      return null;
    }
    const data = await res.json();
    return { messageId: data?.messageId, conversationId: data?.conversationId };
  } catch (err) {
    console.error('GHL addInboundMessage error:', err.message);
    return null;
  }
}

async function addOutboundMessage(contactId, body) {
  try {
    const res = await fetch(`${GHL_BASE}/conversations/messages`, {
      method: 'POST',
      headers: ghlHeaders(),
      body: JSON.stringify({
        type: 'SMS',
        contactId,
        locationId: process.env.GHL_LOCATION_ID,
        message: body
      })
    });
    if (!res.ok) {
      console.error('GHL addOutboundMessage failed:', res.status, await res.text());
      return null;
    }
    const data = await res.json();
    return { messageId: data?.messageId, conversationId: data?.conversationId };
  } catch (err) {
    console.error('GHL addOutboundMessage error:', err.message);
    return null;
  }
}

async function addContactTags(contactId, tags) {
  try {
    const res = await fetch(`${GHL_BASE}/contacts/${contactId}/tags`, {
      method: 'POST',
      headers: ghlHeaders(),
      body: JSON.stringify({ tags })
    });
    if (!res.ok) console.error('GHL addContactTags failed:', res.status);
  } catch (err) {
    console.error('GHL addContactTags error:', err.message);
  }
}

async function addContactNote(contactId, noteText) {
  try {
    const res = await fetch(`${GHL_BASE}/contacts/${contactId}/notes`, {
      method: 'POST',
      headers: ghlHeaders(),
      body: JSON.stringify({ body: noteText })
    });
    if (!res.ok) console.error('GHL addContactNote failed:', res.status);
  } catch (err) {
    console.error('GHL addContactNote error:', err.message);
  }
}

module.exports = {
  searchContactByPhone,
  upsertContact,
  addInboundMessage,
  addOutboundMessage,
  addContactTags,
  addContactNote
};
