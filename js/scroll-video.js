/* ---------------------------------------------------------------------------
   Движок прототипа: позиция скролла управляет временем видео, на заданных
   интервалах поверх кадра появляются ассеты.

   Настройки — в js/timeline.js. Здесь трогать ничего не нужно.
   --------------------------------------------------------------------------- */

(function () {
  'use strict';

  var cfg      = window.TIMELINE;
  var video    = document.getElementById('bg-video');
  var frame    = document.getElementById('frame');
  var track    = document.getElementById('scroll-track');
  var overlays = document.getElementById('overlays');
  var header   = document.getElementById('header');
  var hint     = document.getElementById('hint');
  var missing  = document.getElementById('missing');
  var hud      = document.getElementById('hud');
  var progressEl = document.getElementById('progress');
  var progressBar = progressEl.firstElementChild;

  var FPS = cfg.video.fps || 30;
  var DESIGN_W = cfg.design.width;
  var DESIGN_H = cfg.design.height;

  /* ---------- Тайминги вида '07_20' → секунды ---------- */

  // Принимает число (секунды) или строку 'СС_КК' / 'ММ_СС_КК' / '7.5'
  function parseTime(value) {
    if (typeof value === 'number') return value;
    if (value == null) return 0;

    var s = String(value).trim().replace(/[:.\-\s]/g, '_');
    var parts = s.split('_').filter(function (x) { return x !== ''; });

    if (parts.length === 1) return parseFloat(parts[0]) || 0;
    if (parts.length === 2) {
      return (parseInt(parts[0], 10) || 0) + (parseInt(parts[1], 10) || 0) / FPS;
    }
    // ММ_СС_КК
    return (parseInt(parts[0], 10) || 0) * 60 +
           (parseInt(parts[1], 10) || 0) +
           (parseInt(parts[2], 10) || 0) / FPS;
  }

  // Обратно: секунды → 'СС_КК' (для отладочной панели)
  function formatTime(sec) {
    var s = Math.floor(sec);
    var f = Math.round((sec - s) * FPS);
    if (f >= FPS) { s += 1; f -= FPS; }
    return (s < 10 ? '0' : '') + s + '_' + (f < 10 ? '0' : '') + f;
  }

  /* ---------- Подготовка остановок ---------- */

  var stops = (cfg.stops || []).map(function (raw, i) {
    var from = parseTime(raw.from);
    var to   = raw.to == null ? from : parseTime(raw.to);
    return {
      index: i,
      name: raw.name || ('stop-' + (i + 1)),
      image: raw.image || null,
      from: from,
      to: Math.max(from, to),
      freeze: !!raw.freeze,
      pin: raw.pin == null ? cfg.scroll.pinScreens : raw.pin,
      lead: raw.lead == null ? null : raw.lead
    };
  }).sort(function (a, b) { return a.from - b.from; });

  var duration    = cfg.video.fallbackDuration || 10;
  var videoReady  = false;
  var segments    = [];
  var totalScroll = 0;
  var vh = window.innerHeight;

  var targetTime  = 0;
  var currentTime = 0;
  var activeStop  = -1;
  var segmentInfo = '—';
  var frameScale  = 1;

  /* ---------- Разметка ассетов ---------- */

  var panels = stops.map(function (stop) {
    var el = document.createElement('div');
    el.className = 'panel';
    el.setAttribute('data-name', stop.name);

    if (stop.image) {
      var img = document.createElement('img');
      img.className = 'panel__image';
      // В именах файлов есть пробелы и тире — обязательно кодируем путь
      img.src = encodeURI(stop.image);
      img.alt = stop.name;
      img.draggable = false;
      // Первые два ассета грузим сразу, остальные — лениво
      img.loading = stop.index < 2 ? 'eager' : 'lazy';
      img.decoding = 'async';
      el.appendChild(img);
    }

    overlays.appendChild(el);
    return el;
  });

  /* ---------- Статичная шапка ---------- */

  if (cfg.header && cfg.header.image) {
    var headerImg = document.createElement('img');
    headerImg.className = 'header__image';
    headerImg.src = encodeURI(cfg.header.image);
    headerImg.alt = 'header';
    headerImg.draggable = false;
    headerImg.decoding = 'async';
    header.appendChild(headerImg);
  } else {
    header.remove();
  }

  /* ---------- Масштаб кадра под окно ---------- */

  function fitFrame() {
    var w = window.innerWidth;
    var h = window.innerHeight;
    var sx = w / DESIGN_W;
    var sy = h / DESIGN_H;

    frameScale = cfg.design.fit === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy);

    frame.style.width  = DESIGN_W + 'px';
    frame.style.height = DESIGN_H + 'px';
    frame.style.transform = 'translate(-50%, -50%) scale(' + frameScale + ')';
  }

  /* ---------- Раскладка таймлайна по скроллу ---------- */

  // Сколько скролла занимает въезд ассета в кадр (он же выезд).
  // В режиме slide это ровно высота кадра на экране: ассет едет с той же
  // скоростью, с какой крутится колесо, как на обычной странице.
  function revealLength() {
    if (cfg.scroll.reveal === 'fade') {
      return (cfg.scroll.fadeScreens == null ? 0.4 : cfg.scroll.fadeScreens) * vh;
    }
    var ratio = cfg.scroll.slideRatio == null ? 1 : cfg.scroll.slideRatio;
    return DESIGN_H * frameScale * ratio;
  }

  // Скролл делится на отрезки двух типов:
  //   play — переход между остановками, видео идёт быстро, ассета нет
  //   hold — остановка: видео ползёт по своему интервалу, ассет въезжает,
  //          стоит и уезжает
  function layout() {
    vh = window.innerHeight;
    var pps = cfg.scroll.screensPerSecond * vh;
    var reveal = revealLength();
    var segs = [];
    var y = 0;
    var t = 0;
    var lastIndex = stops.length - 1;

    stops.forEach(function (stop, i) {
      var from = Math.min(stop.from, duration);
      var to   = Math.min(stop.to, duration);

      if (from > t) {
        // Обычно длина перехода пропорциональна куску видео. Но если в этом
        // куске ролик стоит на месте, пропорция даёт экраны пустого скролла —
        // тогда длину задаём вручную через lead.
        var len = stop.lead == null ? (from - t) * pps : stop.lead * vh;
        segs.push({ type: 'play', start: y, len: len, from: t, to: from });
        y += len;
      }

      // Первый ассет уже на месте в самом верху страницы — въезжать неоткуда.
      // Последний, если упирается в конец ролика, остаётся внизу и не уезжает.
      var enterLen = y <= 0 ? 0 : reveal;
      var exitLen  = (i === lastIndex && duration - to <= 0.05) ? 0 : reveal;
      var pinLen   = stop.pin * vh;
      var holdLen  = enterLen + pinLen + exitLen;

      segs.push({
        type: 'hold',
        start: y,
        len: holdLen,
        from: from,
        to: stop.freeze ? from : to,
        index: stop.index,
        stop: stop,
        enterLen: enterLen,
        pinLen: pinLen,
        exitLen: exitLen
      });
      y += holdLen;
      t = to;
    });

    if (duration - t > 0.05) {
      // Хвост после последней остановки: там ролик уже просто угасает,
      // поэтому его длину можно задать напрямую, а не по секундам
      var tail = cfg.scroll.tailScreens == null
        ? (duration - t) * pps
        : cfg.scroll.tailScreens * vh;
      segs.push({ type: 'play', start: y, len: tail, from: t, to: duration });
      y += tail;
    }

    y += (cfg.scroll.endPad || 0) * vh;

    segments = segs;
    totalScroll = y;
    track.style.height = (totalScroll + vh) + 'px';
    renderHudMarks();
  }

  /* ---------- Скролл → время видео и прозрачность ассетов ---------- */

  function resolve(scrollY) {
    var y = Math.max(0, Math.min(scrollY, totalScroll));
    var seg = segments[segments.length - 1];

    for (var i = 0; i < segments.length; i++) {
      if (y < segments[i].start + segments[i].len) { seg = segments[i]; break; }
    }
    if (!seg) return;

    var local = seg.len > 0 ? (y - seg.start) / seg.len : 1;
    local = Math.max(0, Math.min(1, local));

    targetTime = seg.from + (seg.to - seg.from) * local;

    if (seg.type === 'play') {
      activeStop = -1;
      segmentInfo = 'play ' + formatTime(seg.from) + ' → ' + formatTime(seg.to);
    } else {
      activeStop = seg.index;
      segmentInfo = 'hold ' + formatTime(seg.from) + ' → ' + formatTime(seg.to) +
                    ' (' + seg.stop.name + ')';
    }

    var slide = cfg.scroll.reveal !== 'fade';

    for (var j = 0; j < segments.length; j++) {
      var h = segments[j];
      if (h.type !== 'hold') continue;
      var p = panels[h.index];
      if (!p) continue;

      // phase: -1 ассет целиком под кадром, 0 на месте, +1 ушёл над кадром
      var phase = -1;
      var inside = y >= h.start && y <= h.start + h.len;

      if (inside) {
        var into = y - h.start;
        if (h.enterLen > 0 && into < h.enterLen) {
          phase = into / h.enterLen - 1;
        } else if (h.exitLen > 0 && into > h.enterLen + h.pinLen) {
          phase = (into - h.enterLen - h.pinLen) / h.exitLen;
        } else {
          phase = 0;
        }
      }

      if (slide) {
        // Едет по вертикали ровно как обычный контент при скролле:
        // снизу вверх, мимо кадра и дальше вверх
        p.style.transform = 'translate3d(0,' + (-phase * DESIGN_H).toFixed(1) + 'px,0)';
        p.style.opacity = '1';
      } else {
        p.style.transform = 'none';
        p.style.opacity = (1 - Math.min(1, Math.abs(phase))).toFixed(3);
      }

      p.style.visibility = inside ? 'visible' : 'hidden';
    }

    var ratio = totalScroll > 0 ? y / totalScroll : 0;
    progressBar.style.transform = 'scaleX(' + ratio.toFixed(4) + ')';

    if (hint) {
      hint.style.opacity = y < vh * 0.4 ? String(Math.max(0, 1 - y / (vh * 0.4))) : '0';
    }
  }

  /* ---------- Цикл отрисовки ---------- */

  var lastSeek = -1;

  function tick() {
    resolve(window.scrollY || window.pageYOffset || 0);

    var k = cfg.scroll.smoothing || 0.15;
    currentTime += (targetTime - currentTime) * k;
    if (Math.abs(targetTime - currentTime) < 0.004) currentTime = targetTime;

    if (videoReady && Math.abs(currentTime - lastSeek) > 1 / (FPS * 3)) {
      lastSeek = currentTime;
      try { video.currentTime = currentTime; } catch (e) { /* видео ещё не готово */ }
    }

    updateHud();
    requestAnimationFrame(tick);
  }

  /* ---------- Загрузка видео ---------- */

  video.addEventListener('loadedmetadata', function () {
    if (isFinite(video.duration) && video.duration > 0) duration = video.duration;
    videoReady = true;
    missing.hidden = true;
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
    video.src = encodeURI(cfg.video.src);
    video.load();
  } else {
    showMissing();
  }

  // iOS не отдаёт кадры у видео, которое ни разу не проигрывалось —
  // пинаем его один раз при первом действии пользователя
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
  window.addEventListener('scroll', primeVideo, { passive: true });

  /* ---------- Отладочная панель ---------- */

  var hudOn = false;
  var captured = [];

  var el = {
    time:  document.getElementById('hud-time'),
    tc:    document.getElementById('hud-tc'),
    dur:   document.getElementById('hud-duration'),
    scr:   document.getElementById('hud-scroll'),
    prog:  document.getElementById('hud-progress'),
    scale: document.getElementById('hud-scale'),
    seg:   document.getElementById('hud-segment'),
    stop:  document.getElementById('hud-stop'),
    marks: document.getElementById('hud-marks')
  };

  function updateHud() {
    if (!hudOn) return;
    var y = window.scrollY || 0;
    el.time.textContent  = currentTime.toFixed(2);
    el.tc.textContent    = formatTime(currentTime);
    el.dur.textContent   = duration.toFixed(2);
    el.scr.textContent   = Math.round(y) + ' / ' + Math.round(totalScroll);
    el.prog.textContent  = (totalScroll ? Math.round((y / totalScroll) * 100) : 0) + '%';
    el.scale.textContent = frameScale.toFixed(3);
    el.seg.textContent   = segmentInfo;
    el.stop.textContent  = activeStop >= 0 ? stops[activeStop].name : '—';
  }

  function renderHudMarks() {
    if (!el.marks) return;
    el.marks.innerHTML = captured.length
      ? '<b>Записано:</b><br>' + captured.map(function (t) {
          return "'" + formatTime(t) + "'  (" + t.toFixed(2) + ' с)';
        }).join('<br>')
      : '';
  }

  document.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var key = e.key.toLowerCase();

    if (key === 'd') { hudOn = !hudOn; hud.hidden = !hudOn; }
    if (key === 't') {
      captured.push(currentTime);
      captured.sort(function (a, b) { return a - b; });
      hudOn = true; hud.hidden = false;
      renderHudMarks();
      console.log('тайминг:', formatTime(currentTime), '=', currentTime.toFixed(2), 'с');
    }
    if (key === 'g') document.body.classList.toggle('show-grid');
    if (key === 'h') document.body.classList.toggle('hide-assets');
  });

  /* ---------- Старт ---------- */

  if (!cfg.ui || cfg.ui.hint === false) {
    hint.remove();
    hint = null;
  }
  if (!cfg.ui || cfg.ui.progress === false) {
    progressEl.style.display = 'none';
  }

  var resizeTimer;
  window.addEventListener('resize', function () {
    fitFrame();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      layout();
      resolve(window.scrollY || 0);
    }, 100);
  });

  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  window.scrollTo(0, 0);

  fitFrame();
  layout();
  resolve(0);
  requestAnimationFrame(tick);
})();
