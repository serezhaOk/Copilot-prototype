#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Собирает папку dist/ для выкладки на хостинг.

       node scripts/build-dist.js

   Что делает:
   - копирует только то, что нужно браузеру (исходник видео и доки не берёт)
   - переименовывает ассеты в ASCII-безопасные имена и правит пути в конфиге:
     в репозитории имена файлов с пробелами и длинным тире, для людей это
     удобно, но на хостинге такие пути — лишний риск
   - кладёт _headers с кэшированием для Cloudflare Pages
   --------------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

function rm(p) { fs.rmSync(p, { recursive: true, force: true }); }
function mkdir(p) { fs.mkdirSync(p, { recursive: true }); }
function copy(from, to) { mkdir(path.dirname(to)); fs.copyFileSync(from, to); }

// '01. framework. 00_00 – 03_00.png' -> '01-framework-00_00-03_00.png'
function slug(name) {
  const ext = path.extname(name);
  return path.basename(name, ext)
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') + ext.toLowerCase();
}

rm(DIST);
mkdir(DIST);

// 1. Статика как есть
for (const f of ['index.html', 'css/style.css', 'js/scroll-video.js']) {
  copy(path.join(ROOT, f), path.join(DIST, f));
}

// 2. Видео
const video = 'assets/video/main.mp4';
if (!fs.existsSync(path.join(ROOT, video))) {
  console.error('Нет ' + video + '. Сначала прогони scripts/encode-video.sh');
  process.exit(1);
}
copy(path.join(ROOT, video), path.join(DIST, video));

// 3. Ассеты с переименованием
const IMG = 'assets/images';
const map = new Map();
for (const name of fs.readdirSync(path.join(ROOT, IMG))) {
  if (!/\.(png|jpe?g|webp|avif)$/i.test(name)) continue;
  const to = slug(name);
  map.set(`${IMG}/${name}`, `${IMG}/${to}`);
  copy(path.join(ROOT, IMG, name), path.join(DIST, IMG, to));
}

// 4. Конфиг с переписанными путями
let cfg = fs.readFileSync(path.join(ROOT, 'js/timeline.js'), 'utf8');
for (const [from, to] of map) {
  if (!cfg.includes(from)) continue;
  cfg = cfg.split(from).join(to);
}
mkdir(path.join(DIST, 'js'));
fs.writeFileSync(path.join(DIST, 'js/timeline.js'), cfg);

// Проверяем, что в конфиге не осталось путей к несуществующим файлам
const missing = [...cfg.matchAll(/'(assets\/[^']+)'/g)]
  .map(m => m[1])
  .filter(p => !fs.existsSync(path.join(DIST, p)));
if (missing.length) {
  console.error('В сборке нет файлов, на которые ссылается конфиг:');
  missing.forEach(p => console.error('  ' + p));
  process.exit(1);
}

// 5. Заголовки для Cloudflare Pages
fs.writeFileSync(path.join(DIST, '_headers'), `# Ассеты и видео версионируются вручную, можно кэшировать надолго
/assets/*
  Cache-Control: public, max-age=604800

# Разметку и код держим свежими, чтобы правки долетали сразу
/
  Cache-Control: public, max-age=0, must-revalidate
/index.html
  Cache-Control: public, max-age=0, must-revalidate
/js/*
  Cache-Control: public, max-age=0, must-revalidate
/css/*
  Cache-Control: public, max-age=0, must-revalidate
`);

// Отчёт
let total = 0, biggest = { name: '', size: 0 };
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    const size = fs.statSync(p).size;
    total += size;
    if (size > biggest.size) biggest = { name: path.relative(DIST, p), size };
  }
})(DIST);

const mb = n => (n / 1024 / 1024).toFixed(1) + ' МБ';
console.log('Готово: dist/');
console.log('  файлов больше всего весит:', biggest.name, mb(biggest.size));
console.log('  всего:', mb(total));

const LIMIT = 25 * 1024 * 1024;
if (biggest.size > LIMIT) {
  console.error(`\nСамый большой файл больше 25 МиБ — Cloudflare Pages его не примет.`);
  console.error('Перекодируй видео полегче:  CRF=25 ./scripts/encode-video.sh assets/video/source/copilot-main-video.mp4');
  process.exit(1);
}
