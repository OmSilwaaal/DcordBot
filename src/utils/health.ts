import http from 'node:http';
import { log } from './logger.js';

export function startHealthServer(port: number, status: () => Record<string, unknown>): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptimeSec: Math.round(process.uptime()), ...status() }, null, 2));
    } else {
      res.writeHead(404).end();
    }
  });
  server.on('error', (e) => log.warn('[health] server error', e));
  server.listen(port, () => log.info(`[health] http://localhost:${port}/health`));
  return server;
}
