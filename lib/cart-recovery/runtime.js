'use strict';

let service = null;
function setCartRecoveryService(value) { service = value; }
async function markDelivery(event) { return service ? service.markDelivery(event) : false; }
async function handleInboundReply(event) { return service ? service.handleInboundReply(event) : { attached: false }; }
async function handleOptOut(event) { return service ? service.handleOptOut(event) : false; }
async function reconcileWooOrder(event) { return service ? service.reconcileWooOrder(event) : { reconciled: false }; }

module.exports = { setCartRecoveryService, markDelivery, handleInboundReply, handleOptOut, reconcileWooOrder };
