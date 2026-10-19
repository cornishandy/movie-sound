import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
};

export function createBridgeServer() {
  return http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method not allowed');
      return;
    }
    let pathname;
    // A malformed target ("//", "//[") or escape ("/%"), or a NUL byte, used to throw and take the server down.
    try { pathname = decodeURIComponent(new URL(req.url || '/', `http://${HOST}`).pathname); } catch { pathname = null; }
    if (pathname === null || pathname.includes('\0')) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad request');
      return;
    }
    if (pathname === '/') pathname = '/index.html';
    const file = path.resolve(ROOT, '.' + pathname);
    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        // The page is only ever a tab of its own; no other site may frame it.
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "frame-ancestors 'none'"
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  });
}

export function startBridgeServer(port = Number(process.env.BRIDGE_PORT || 8791)) {
  const server = createBridgeServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      const addr = server.address();
      resolve({ server, host: HOST, port: addr.port, url: `http://${HOST}:${addr.port}/` });
    });
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startBridgeServer().then(({ server, url }) => {
    console.log(`Movie DSP bridge listening at ${url}`);
    // Optional lifetime (bin/movie-audio sets 12 h when it runs the server itself). An open page keeps playing after.
    const hours = Number(process.env.BRIDGE_EXIT_AFTER_HOURS);
    if (hours > 0) setTimeout(() => server.close(() => process.exit(0)), hours * 3600 * 1000).unref();
  }).catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
