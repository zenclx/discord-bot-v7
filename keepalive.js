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

module.exports = server;
