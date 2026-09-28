'use strict';

function cleanupError(message, status) { return Object.assign(new Error(message), { status }); }

async function hideFailedInboxMessage({ client, id, phone }) {
  const messageID = Number(id);
  if (!Number.isSafeInteger(messageID) || messageID < 1 || !/^\+[1-9]\d{7,14}$/.test(phone || '')) {
    throw cleanupError('Choose a saved failed message in this conversation to delete.', 400);
  }
  const { error } = await client.rpc('hide_failed_inbox_message', { p_id: messageID, p_phone: phone });
  if (error) {
    if (error.code === 'P0002') throw cleanupError('This message was not found in this conversation.', 404);
    if (/message_not_failed/.test(error.message || '')) {
      throw cleanupError('Only an outbound message confirmed as failed can be deleted here. Delivered messages stay in the conversation.', 409);
    }
    throw cleanupError('The failed message could not be removed. Please try again or ask an administrator to check the inbox cleanup database update.', 503);
  }
  return { hidden: true, messageID };
}

module.exports = { hideFailedInboxMessage };
