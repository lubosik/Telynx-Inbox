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

    const ping = setInterval(() => {
      try { res.write(':ping\n\n'); } catch { clearInterval(ping); }
    }, 25000);

    req.on('close', () => {
      clearInterval(ping);
      sseClients.delete(res);
    });
  });

  return router;
};
