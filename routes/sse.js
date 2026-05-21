module.exports = (sseClients) => {
  const router = require('express').Router();

  router.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    sseClients.add(res);
    res.write('data: {"type":"connected"}\n\n');

    // Ping every 15s — Railway drops idle connections at 30s
    const ping = setInterval(() => {
      try { res.write(':ping\n\n'); } catch { clearInterval(ping); }
    }, 15000);

    req.on('close', () => {
      clearInterval(ping);
      sseClients.delete(res);
    });
  });

  return router;
};
