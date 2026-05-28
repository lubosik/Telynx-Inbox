'use strict';
// Singleton SSE broadcaster — initialised once in server.js, imported anywhere that needs it
let _broadcast = null;
function setBroadcast(fn) { _broadcast = fn; }
function broadcast(event) { if (_broadcast) _broadcast(event); }
module.exports = { setBroadcast, broadcast };
