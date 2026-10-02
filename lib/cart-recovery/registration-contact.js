'use strict';

// A completed Vici registration is a customer identity event, not permission
// to send SMS. This bridge creates one inbox contact per phone without touching
// consent, DND, last-message activity, or a pre-existing customer's details.
function normalEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function customerConflict(contact, customerID, email) {
  if (!contact) return false;
  if (contact.woo_customer_id != null && String(contact.woo_customer_id) !== customerID) return true;
  if (contact.woo_customer_id == null && normalEmail(contact.email) !== email) return true;
  return false;
}

async function syncRegistrationContact(client, event, identity) {
  if (event?.event_type !== 'consent.updated' || !event.phone || !/^\d{1,24}$/.test(event.customer_id || '') ||
      identity?.ambiguous === true || (identity?.contact_phone && identity.contact_phone !== event.phone)) {
    return { status: 'skipped' };
  }
  const customerID = event.customer_id;
  const email = normalEmail(event.customer_email);
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { status: 'email_missing' };

  const [byPhone, byCustomer] = await Promise.all([
    client.from('sms_contacts').select('id,phone,email,woo_customer_id').eq('phone', event.phone).maybeSingle(),
    client.from('sms_contacts').select('id,phone,email,woo_customer_id').eq('woo_customer_id', customerID).limit(2)
  ]);
  if (byPhone.error || byCustomer.error) throw new Error('Registration contact lookup failed.');
  if ((byCustomer.data || []).some(row => row.phone !== event.phone) || (byCustomer.data || []).length > 1 ||
      customerConflict(byPhone.data, customerID, email)) return { status: 'identity_conflict' };

  let contact = byPhone.data;
  if (!contact) {
    const firstName = String(event.customer_first_name || '').trim().slice(0, 80);
    const { data, error } = await client.from('sms_contacts').insert({
      phone: event.phone, email, name: firstName || null, first_name: firstName || null,
      woo_customer_id: Number(customerID), source: 'vici_registration'
    }).select('id,phone,email,woo_customer_id').single();
    if (error) {
      // A simultaneous Woo customer webhook may have inserted the same phone.
      // Re-read it; never upsert over a row whose owner we have not checked.
      if (error.code !== '23505') throw new Error('Registration contact could not be created.');
      const concurrent = await client.from('sms_contacts')
        .select('id,phone,email,woo_customer_id').eq('phone', event.phone).maybeSingle();
      if (concurrent.error) throw new Error('Registration contact conflict could not be checked.');
      contact = concurrent.data;
      if (!contact || customerConflict(contact, customerID, email)) return { status: 'identity_conflict' };
    } else contact = data;
  }

  if (contact?.woo_customer_id == null) {
    const linked = await client.from('sms_contacts').update({ woo_customer_id: Number(customerID) })
      .eq('id', contact.id).is('woo_customer_id', null).select('id,phone,email,woo_customer_id');
    if (linked.error) throw new Error('Registration contact owner could not be saved.');
    if (linked.data?.[0]) contact = linked.data[0];
    else {
      const current = await client.from('sms_contacts')
        .select('id,phone,email,woo_customer_id').eq('id', contact.id).maybeSingle();
      if (current.error || customerConflict(current.data, customerID, email)) return { status: 'identity_conflict' };
      contact = current.data;
    }
  }

  // A previously created identity can have a blank phone. Fill it only when
  // the exact WordPress ID and an existing, non-conflicting inbox contact agree.
  if (identity?.identity_id && contact && !identity.contact_phone) {
    const updated = await client.from('luko_customer_identities').update({
      contact_phone: event.phone, luko_contact_linked: true, resolved_by: 'wordpress_user_id'
    }).eq('id', identity.identity_id).eq('wordpress_user_id', customerID)
      .is('contact_phone', null).select('id');
    if (updated.error) throw new Error('Registration identity link could not be saved.');
  } else if (identity?.identity_id && contact && identity.contact_phone === event.phone &&
             identity.luko_contact_linked !== true) {
    const updated = await client.from('luko_customer_identities')
      .update({ luko_contact_linked: true })
      .eq('id', identity.identity_id).eq('wordpress_user_id', customerID)
      .eq('contact_phone', event.phone);
    if (updated.error) throw new Error('Registration identity link could not be saved.');
  }
  return { status: byPhone.data ? 'existing' : 'created', contactID: contact?.id || null };
}

module.exports = { customerConflict, syncRegistrationContact };
