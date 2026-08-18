#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Локальный сервер для прототипа. Без зависимостей.

       node scripts/serve.js          → http://localhost:8000
       node scripts/serve.js 3000     → другой порт

   Зачем свой, а не `python3 -m http.server`: питоновский не умеет Range-запросы,
   а без них браузер не может перематывать видео — оно намертво стоит на нулевой
   секунде. Этот умеет.
   --------------------------------------------------------------------------- */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const url  = require('url');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2]) || 8000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.mov':  'video/quicktime',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.woff2':'font/woff2',
  '.woff': 'font/woff',
  '.md':   'text/markdown; charset=utf-8'
};

http.createServer((req, res) => {
  let pathname = decodeURIComponent(url.parse(req.url).pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';

  const file = path.join(ROOT, path.normalize(pathname));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }

  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404: ' + pathname);
      return;
    }

    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;

    // Range — то, ради чего этот сервер и написан
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end   = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;

      if (isNaN(start) || isNaN(end) || start > end || end >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        res.end();
        return;
      }

      res.writeHead(206, {
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Cache-Control': 'no-cache'
      });
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(file).pipe(res);
  });
}).listen(PORT, () => {
  console.log(`Прототип: http://localhost:${PORT}`);
  console.log('Остановить: Ctrl+C');
});
