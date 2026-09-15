'use strict';

let service = null;
function setCartRecoveryService(value) { service = value; }
async function markDelivery(event) { return service ? service.markDelivery(event) : false; }

module.exports = { setCartRecoveryService, markDelivery };
