'use strict';

let service = null;
function setCartRecoveryService(value) { service = value; }
async function markDelivery(event) { return service ? service.markDelivery(event) : false; }
async function handleInboundReply(event) { return service ? service.handleInboundReply(event) : { attached: false }; }
async function handleOptOut(event) { return service ? service.handleOptOut(event) : false; }

module.exports = { setCartRecoveryService, markDelivery, handleInboundReply, handleOptOut };
