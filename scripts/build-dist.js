#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Собирает папку dist/ для выкладки на хостинг.

       node scripts/build-dist.js

   Что делает:
   - берёт только то, что нужно браузеру; исходник видео и доки не уезжают
   - проверяет, что main.mp4 собран из того исходника, который лежит в репо
   - подмешивает в имена ассетов хэш содержимого, чтобы новая версия видео
     или картинки долетала до людей сразу, а не через неделю из кэша
   - правит пути в конфиге под новые имена
   - кладёт _headers с кэшированием для Cloudflare Pages
   --------------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const LIMIT = 25 * 1024 * 1024; // потолок Cloudflare Pages на файл

const rm = p => fs.rmSync(p, { recursive: true, force: true });
const mkdir = p => fs.mkdirSync(p, { recursive: true });
const copy = (from, to) => { mkdir(path.dirname(to)); fs.copyFileSync(from, to); };
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const mb = n => (n / 1024 / 1024).toFixed(1) + ' МБ';

function fail(title, lines) {
  console.error('\n' + title);
  lines.forEach(l => console.error('  ' + l));
  console.error('');
  process.exit(1);
}

/* --- 1. Видео должно быть собрано из текущего исходника --------------------- */

const VIDEO = 'assets/video/main.mp4';
const SOURCE = 'assets/video/source/copilot-main-video.mp4';
const STAMP = 'assets/video/main.source-sha.txt';

if (!fs.existsSync(path.join(ROOT, VIDEO))) {
  fail('Нет ' + VIDEO, [
    'Сначала перекодируй исходник:',
    './scripts/encode-video.sh ' + SOURCE
  ]);
}

if (fs.existsSync(path.join(ROOT, SOURCE))) {
  const now = sha(path.join(ROOT, SOURCE));
  const was = fs.existsSync(path.join(ROOT, STAMP))
    ? fs.readFileSync(path.join(ROOT, STAMP), 'utf8').trim()
    : null;

  if (was !== now) {
    fail('Исходник видео поменялся, а main.mp4 остался прежним.', [
      'Если выложить как есть, на сайте окажется старое видео.',
      '',
      'Перекодировать:  ./scripts/encode-video.sh ' + SOURCE,
      '',
      'На GitHub это делает само: Actions прогоняет перекодирование',
      'и коммитит main.mp4 обратно. Дождись, пока экшен закончит,',
      'и Cloudflare пересоберёт сайт следующей сборкой.'
    ]);
  }
}

/* --- 2. Статика как есть ---------------------------------------------------- */

rm(DIST);
mkdir(DIST);

for (const f of ['index.html', 'css/style.css', 'js/scroll-video.js']) {
  copy(path.join(ROOT, f), path.join(DIST, f));
}

/* --- 3. Ассеты: безопасные имена и хэш содержимого -------------------------- */

// '01. framework. 00_00 – 03_00.png' -> '01-framework-00_00-03_00.3f9a1c22.png'
// Имена в репозитории с пробелами и длинным тире — людям удобно, хостингам
// не всегда. Хэш в имени делает кэширование безопасным: поменялся файл —
// поменялся адрес, и браузер обязан скачать новый.
function distName(file) {
  const ext = path.extname(file).toLowerCase();
  const slug = path.basename(file, path.extname(file))
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `${slug}.${sha(file).slice(0, 8)}${ext}`;
}

const map = new Map();

const IMG = 'assets/images';
for (const name of fs.readdirSync(path.join(ROOT, IMG))) {
  if (!/\.(png|jpe?g|webp|avif)$/i.test(name)) continue;
  const from = path.join(ROOT, IMG, name);
  const to = `${IMG}/${distName(from)}`;
  map.set(`${IMG}/${name}`, to);
  copy(from, path.join(DIST, to));
}

const videoTo = `assets/video/${distName(path.join(ROOT, VIDEO))}`;
map.set(VIDEO, videoTo);
copy(path.join(ROOT, VIDEO), path.join(DIST, videoTo));

/* --- 4. Конфиг с переписанными путями --------------------------------------- */

let cfg = fs.readFileSync(path.join(ROOT, 'js/timeline.js'), 'utf8');
for (const [from, to] of map) cfg = cfg.split(from).join(to);
mkdir(path.join(DIST, 'js'));
fs.writeFileSync(path.join(DIST, 'js/timeline.js'), cfg);

const missing = [...cfg.matchAll(/'(assets\/[^']+)'/g)]
  .map(m => m[1])
  .filter(p => !fs.existsSync(path.join(DIST, p)));
if (missing.length) {
  fail('В сборке нет файлов, на которые ссылается конфиг:', missing);
}

/* --- 5. Заголовки ----------------------------------------------------------- */

fs.writeFileSync(path.join(DIST, '_headers'), `# В именах ассетов зашит хэш содержимого: поменялся файл — поменялся адрес.
# Поэтому их можно кэшировать навсегда, обновления всё равно долетают сразу.
/assets/*
  Cache-Control: public, max-age=31536000, immutable

# Разметка и код адресов не меняют, их держим свежими
/
  Cache-Control: public, max-age=0, must-revalidate
/index.html
  Cache-Control: public, max-age=0, must-revalidate
/js/*
  Cache-Control: public, max-age=0, must-revalidate
/css/*
  Cache-Control: public, max-age=0, must-revalidate
`);

/* --- 6. Отчёт --------------------------------------------------------------- */

let total = 0;
let biggest = { name: '', size: 0 };
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    const size = fs.statSync(p).size;
    total += size;
    if (size > biggest.size) biggest = { name: path.relative(DIST, p), size };
  }
})(DIST);

console.log('Готово: dist/');
console.log('  видео:  ' + videoTo);
console.log('  тяжелее всего: ' + biggest.name + '  ' + mb(biggest.size));
console.log('  всего:  ' + mb(total));

if (biggest.size > LIMIT) {
  fail('Файл больше 25 МиБ — Cloudflare Pages его не примет.', [
    'Перекодируй видео полегче:',
    'CRF=25 ./scripts/encode-video.sh ' + SOURCE
  ]);
}
