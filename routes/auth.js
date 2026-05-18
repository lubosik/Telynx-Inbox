const router = require('express').Router();

router.post('/login', (req, res) => {
  const { password } = req.body;
  if (password === process.env.INBOX_PASSWORD) {
    req.session.authenticated = true;
    req.session.save(() => res.json({ success: true }));
  } else {
    res.status(401).json({ error: 'Incorrect password' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

router.get('/check', (req, res) => {
  res.json({ authenticated: !!req.session?.authenticated });
});

module.exports = router;
