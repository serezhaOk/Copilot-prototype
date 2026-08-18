/* ---------------------------------------------------------------------------
   Движок: привязывает позицию скролла к времени видео и показывает контент
   на «остановках». Настройки — в js/timeline.js, здесь трогать ничего не нужно.
   --------------------------------------------------------------------------- */

(function () {
  'use strict';

  var cfg      = window.TIMELINE;
  var video    = document.getElementById('bg-video');
  var track    = document.getElementById('scroll-track');
  var overlays = document.getElementById('overlays');
  var progress = document.getElementById('progress').firstElementChild;
  var hint     = document.getElementById('hint');
  var missing  = document.getElementById('missing');
  var hud      = document.getElementById('hud');

  var stops = (cfg.stops || []).slice().sort(function (a, b) { return a.at - b.at; });

  var duration   = cfg.video.fallbackDuration || 10;
  var videoReady = false;
  var segments   = [];
  var totalScroll = 0;
  var vh = window.innerHeight;

  var targetTime  = 0;   // время видео, которое требует текущий скролл
  var currentTime = 0;   // сглаженное время, которое реально выставляем видео
  var activeStop  = -1;
  var segmentInfo = '—';

  /* ---------- 1. Разметка контента из конфига ---------- */

  var panels = stops.map(function (stop, i) {
    var el = document.createElement('section');
    el.className = 'panel panel--' + (stop.align || 'center');
    el.style.setProperty('--panel-width', (stop.width || 720) + 'px');
    el.setAttribute('data-index', String(i));

    if (stop.image) {
      var img = document.createElement('img');
      img.className = 'panel__image';
      img.src = stop.image;
      img.alt = stop.title || '';
      img.loading = i < 2 ? 'eager' : 'lazy';
      img.decoding = 'async';
      el.appendChild(img);
    }

    if (stop.title || stop.text) {
      var box = document.createElement('div');
      box.className = 'panel__copy';
      if (stop.title) {
        var h = document.createElement('h2');
        h.className = 'panel__title';
        h.textContent = stop.title;
        box.appendChild(h);
      }
      if (stop.text) {
        var p = document.createElement('p');
        p.className = 'panel__text';
        p.textContent = stop.text;
        box.appendChild(p);
      }
      el.appendChild(box);
    }

    overlays.appendChild(el);
    return el;
  });

  /* ---------- 2. Раскладка таймлайна по скроллу ---------- */

  // Скролл делится на отрезки двух типов:
  //   play — видео едет от одной секунды к другой
  //   hold — видео стоит, на экране контент
  function layout() {
    vh = window.innerHeight;
    var pps = cfg.scroll.screensPerSecond * vh; // пикселей скролла на секунду видео
    var segs = [];
    var y = 0;
    var t = 0;

    stops.forEach(function (stop, i) {
      var at = Math.max(0, Math.min(stop.at, duration));
      if (at > t) {
        var len = (at - t) * pps;
        segs.push({ type: 'play', start: y, len: len, from: t, to: at });
        y += len;
        t = at;
      }
      var hold = (stop.hold == null ? 1 : stop.hold) * vh;
      segs.push({ type: 'hold', start: y, len: hold, from: t, to: t, index: i });
      y += hold;
    });

    if (duration > t) {
      var tail = (duration - t) * pps;
      segs.push({ type: 'play', start: y, len: tail, from: t, to: duration });
      y += tail;
    }

    y += (cfg.scroll.endPad || 0) * vh;

    segments = segs;
    totalScroll = y;
    // Высота дорожки = длина таймлайна + один экран, чтобы максимум scrollY == totalScroll
    track.style.height = (totalScroll + vh) + 'px';
    renderHudMarks();
  }

  /* ---------- 3. Скролл -> время видео + прозрачность панелей ---------- */

  function resolve(scrollY) {
    var y = Math.max(0, Math.min(scrollY, totalScroll));
    var seg = segments[segments.length - 1];

    for (var i = 0; i < segments.length; i++) {
      var s = segments[i];
      if (y < s.start + s.len || i === segments.length - 1) { seg = s; break; }
    }
    if (!seg) return;

    var local = seg.len > 0 ? (y - seg.start) / seg.len : 1;
    local = Math.max(0, Math.min(1, local));

    if (seg.type === 'play') {
      targetTime = seg.from + (seg.to - seg.from) * local;
      activeStop = -1;
      segmentInfo = 'play ' + seg.from.toFixed(2) + ' → ' + seg.to.toFixed(2);
    } else {
      targetTime = seg.from;
      activeStop = seg.index;
      segmentInfo = 'hold @ ' + seg.from.toFixed(2) + ' (#' + (seg.index + 1) + ')';
    }

    // Прозрачность каждой панели считаем от её собственного hold-отрезка
    for (var j = 0; j < segments.length; j++) {
      var h = segments[j];
      if (h.type !== 'hold') continue;
      var p = panels[h.index];
      if (!p) continue;

      var opacity = 0;
      if (y >= h.start && y <= h.start + h.len) {
        var lp = h.len > 0 ? (y - h.start) / h.len : 1;
        var f = cfg.scroll.fade || 0.25;
        if (lp < f)            opacity = lp / f;
        else if (lp > 1 - f)   opacity = (1 - lp) / f;
        else                   opacity = 1;
      }
      opacity = Math.max(0, Math.min(1, opacity));

      p.style.opacity = opacity.toFixed(3);
      p.style.transform = 'translate3d(0,' + ((1 - opacity) * 28).toFixed(1) + 'px,0)';
      p.style.visibility = opacity < 0.01 ? 'hidden' : 'visible';
    }

    var ratio = totalScroll > 0 ? y / totalScroll : 0;
    progress.style.transform = 'scaleX(' + ratio.toFixed(4) + ')';
    hint.style.opacity = y < vh * 0.35 ? String(1 - y / (vh * 0.35)) : '0';
  }

  /* ---------- 4. Цикл отрисовки ---------- */

  var lastSeek = -1;

  function frame() {
    resolve(window.scrollY || window.pageYOffset || 0);

    var k = cfg.scroll.smoothing || 0.15;
    currentTime += (targetTime - currentTime) * k;
    if (Math.abs(targetTime - currentTime) < 0.004) currentTime = targetTime;

    if (videoReady && Math.abs(currentTime - lastSeek) > 1 / 90) {
      lastSeek = currentTime;
      try { video.currentTime = currentTime; } catch (e) { /* видео ещё не готово */ }
    }

    updateHud();
    requestAnimationFrame(frame);
  }

  /* ---------- 5. Загрузка видео ---------- */

  video.addEventListener('loadedmetadata', function () {
    if (isFinite(video.duration) && video.duration > 0) {
      duration = video.duration;
    }
    videoReady = true;
    missing.hidden = true;
    document.body.classList.add('has-video');
    layout();
    resolve(window.scrollY || 0);
  });

  video.addEventListener('error', showMissing);

  function showMissing() {
    videoReady = false;
    missing.hidden = false;
    document.getElementById('missing-path').textContent = cfg.video.src;
  }

  if (cfg.video.src) {
    video.src = cfg.video.src;
    video.load();
  } else {
    showMissing();
  }

  // iOS не рисует кадры у видео, которое ни разу не проигрывалось.
  // Пинаем его один раз на первом касании/клике.
  function primeVideo() {
    if (!videoReady) return;
    var p = video.play();
    if (p && p.then) p.then(function () { video.pause(); }).catch(function () {});
    else { try { video.pause(); } catch (e) {} }
    window.removeEventListener('touchstart', primeVideo);
    window.removeEventListener('click', primeVideo);
    window.removeEventListener('scroll', primeVideo);
  }
  window.addEventListener('touchstart', primeVideo, { passive: true });
  window.addEventListener('click', primeVideo);
  window.addEventListener('scroll', primeVideo, { passive: true, once: false });

  /* ---------- 6. Отладочная панель ---------- */

  var hudOn = false;
  var captured = [];

  var hudTime = document.getElementById('hud-time');
  var hudDur  = document.getElementById('hud-duration');
  var hudScr  = document.getElementById('hud-scroll');
  var hudProg = document.getElementById('hud-progress');
  var hudSeg  = document.getElementById('hud-segment');
  var hudStop = document.getElementById('hud-stop');
  var hudMarks = document.getElementById('hud-marks');

  function updateHud() {
    if (!hudOn) return;
    var y = window.scrollY || 0;
    hudTime.textContent = currentTime.toFixed(2);
    hudDur.textContent  = duration.toFixed(2);
    hudScr.textContent  = Math.round(y) + ' / ' + Math.round(totalScroll);
    hudProg.textContent = (totalScroll ? Math.round((y / totalScroll) * 100) : 0) + '%';
    hudSeg.textContent  = segmentInfo;
    hudStop.textContent = activeStop >= 0 ? '#' + (activeStop + 1) : '—';
  }

  function renderHudMarks() {
    if (!hudMarks) return;
    hudMarks.innerHTML = captured.length
      ? '<b>Записанные тайминги:</b><br>' + captured.map(function (t, i) {
          return '{ at: ' + t.toFixed(2) + ', hold: 1.2, image: \'assets/images/' +
                 String(i + 1).padStart(2, '0') + '.png\' },';
        }).join('<br>')
      : '';
  }

  document.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var key = e.key.toLowerCase();

    if (key === 'd') {
      hudOn = !hudOn;
      hud.hidden = !hudOn;
    }
    if (key === 't') {
      captured.push(currentTime);
      captured.sort(function (a, b) { return a - b; });
      hudOn = true;
      hud.hidden = false;
      renderHudMarks();
      console.log('timing captured:', currentTime.toFixed(2));
    }
    if (key === 'g') {
      document.body.classList.toggle('show-grid');
    }
  });

  /* ---------- 7. Старт ---------- */

  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      layout();
      resolve(window.scrollY || 0);
    }, 120);
  });

  // Страница всегда открывается с самого начала
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  window.scrollTo(0, 0);

  layout();
  resolve(0);
  requestAnimationFrame(frame);
})();
