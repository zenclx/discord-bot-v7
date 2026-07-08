const http = require('http');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, uptime: Math.round(process.uptime()) }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is alive');
});

server.listen(PORT, () => {
  console.log(`Keep-alive server running on port ${PORT}`);
});

const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_URL) {
  console.log(`Self-ping enabled: will ping ${RENDER_URL}/health every 4 minutes`);
  const https = require('https');
  setInterval(() => {
    https.get(`${RENDER_URL}/health`, res => {
      console.log(`Self-ping: ${res.statusCode}`);
    }).on('error', err => {
      console.error(`Self-ping failed: ${err.message}`);
    });
  }, 4 * 60 * 1000);
} else {
  console.warn('RENDER_EXTERNAL_URL not set — self-ping disabled. Bot may sleep on Render free tier.');
}

module.exports = server;
