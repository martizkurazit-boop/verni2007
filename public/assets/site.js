/* «Верните мой 2007» — минимальный клиентский слой. Всё содержимое уже в HTML. */
(function () {
  'use strict';
  var BASE = (document.querySelector('link[rel=canonical]') || {}).href || location.href;

  function goal(name, params) {
    try {
      // Номер счётчика берём из переменной, а не из очереди ym.a: после загрузки
      // tag.js подменяет ym собой, и очередь пропадает вместе с номером.
      if (window.ym && window.__YM_ID) window.ym(window.__YM_ID, 'reachGoal', name, params);
      if (window.gtag) window.gtag('event', name, params || {});
    } catch (e) {}
  }

  /* ── Светлая и тёмная тема ──────────────────────────────────────
     Три состояния: выбор читателя, системная настройка и светлая по
     умолчанию. Выбор запоминается в этом браузере; сама тема ставится
     ещё до отрисовки скриптом в <head>, иначе тёмная страница моргает
     белым при каждом переходе. */
  var THEME_KEY = 'vm2007:theme';
  function systemDark() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  function currentTheme() {
    var set = document.documentElement.getAttribute('data-theme');
    return set === 'dark' || set === 'light' ? set : (systemDark() ? 'dark' : 'light');
  }
  function applyTheme(name) {
    document.documentElement.setAttribute('data-theme', name);
    var meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.setAttribute('content', name === 'dark' ? '#0F0F0F' : '#FFFFFF');
    try { localStorage.setItem(THEME_KEY, name); } catch (e) {}
  }
  Array.prototype.forEach.call(document.querySelectorAll('[data-theme-toggle]'), function (b) {
    b.addEventListener('click', function () {
      var next = currentTheme() === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      goal('theme_switch', { theme: next });
    });
  });

  /* ── Поиск ───────────────────────────────────────────────────────
     Имя переменной здесь не случайно длинное: var не ограничен блоком,
     и короткое bar ниже по файлу уже перетирало эту ссылку — на странице
     статьи кнопка поиска переставала работать. */
  var searchBar = document.getElementById('searchbar');
  Array.prototype.forEach.call(document.querySelectorAll('[data-search-toggle]'), function (b) {
    b.addEventListener('click', function () {
      if (!searchBar) return;
      var open = searchBar.hidden;
      searchBar.hidden = !open;
      document.querySelectorAll('[data-search-toggle][aria-expanded]').forEach(function (t) {
        t.setAttribute('aria-expanded', String(open));
      });
      if (open) { var field = searchBar.querySelector('input'); if (field) field.focus(); }
    });
  });

  /* ── Переходы на канал из шапки и футера ───────────────────────── */
  // Это тот же бизнес-результат, что и ссылка под видео, поэтому цель одна,
  // а место перехода уходит параметром — в отчёте видно, что сработало.
  var PLACES = [['data-yt-header', 'header'], ['data-yt-footer', 'footer'],
    ['data-yt-end', 'article-end'], ['data-yt-sticky', 'article-sticky'],
    ['data-yt-about', 'about'], ['data-yt-contacts', 'contacts']];
  PLACES.forEach(function (pair) {
    Array.prototype.forEach.call(document.querySelectorAll('[' + pair[0] + ']'), function (a) {
      a.addEventListener('click', function () { goal('youtube_click', { place: pair[1] }); });
    });
  });

  /* ── Переходы в Telegram ────────────────────────────────────────
     Связь с редакцией — тоже результат: считаем отдельной целью, а место
     клика (футер, страница контактов, «о проекте») уходит параметром. */
  Array.prototype.forEach.call(document.querySelectorAll('[data-tg]'), function (a) {
    a.addEventListener('click', function () {
      goal('telegram_click', { place: a.getAttribute('data-tg-place') || '' });
    });
  });

  /* ── Липкая плашка «Смотреть выпуск» ────────────────────────────
     Появляется, когда видео уехало вверх, и прячется у карточки выпуска в конце:
     две одинаковые кнопки на экране раздражают. Закрытая плашка не возвращается
     до конца сессии — навязчивость вредит больше, чем недобор кликов. */
  var sticky = document.querySelector('[data-yt-sticky]');
  if (sticky) {
    var videoBox = document.querySelector('[data-place="article-top"]') || document.querySelector('[data-video]');
    var endCard = document.querySelector('[data-yt-end]');
    var key = 'vm2007:sticky-off:' + location.pathname;
    var closed = false;
    try { closed = sessionStorage.getItem(key) === '1'; } catch (e) {}
    sticky.hidden = false;
    var ticking = false;
    var update = function () {
      ticking = false;
      if (closed) { sticky.classList.remove('show'); return; }
      var passedVideo = !videoBox || videoBox.getBoundingClientRect().bottom < 0;
      var endNear = endCard && endCard.getBoundingClientRect().top < window.innerHeight + 120;
      sticky.classList.toggle('show', passedVideo && !endNear);
    };
    window.addEventListener('scroll', function () {
      if (!ticking) { ticking = true; window.requestAnimationFrame(update); }
    }, { passive: true });
    window.addEventListener('resize', update);
    $close(sticky, function () {
      closed = true;
      sticky.classList.remove('show');
      try { sessionStorage.setItem(key, '1'); } catch (e) {}
    });
    update();
  }
  function $close(bar, fn) {
    var x = bar.querySelector('[data-yt-sticky-close]');
    if (!x) return;
    x.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      fn();
    });
  }

  /* ── Оглавление: свёрнуто на телефоне ──────────────────────────── */
  var toc = document.querySelector('[data-toc]');
  if (toc) {
    var tocBtn = toc.querySelector('[data-toc-toggle]');
    var tocList = toc.querySelector('ol');
    var setToc = function (open) {
      tocList.hidden = !open;
      tocBtn.setAttribute('aria-expanded', String(open));
      tocBtn.querySelector('.sign').textContent = open ? '−' : '+';
    };
    setToc(window.innerWidth >= 860);
    tocBtn.addEventListener('click', function () { setToc(tocList.hidden); });
  }

  /* ── Видео: грузится только по клику ───────────────────────────── */
  // Проигрывателей на странице может быть два: свой выпуск статьи вверху и
  // предложенный в конце, поэтому обходим все.
  Array.prototype.forEach.call(document.querySelectorAll('[data-video]'), function (video) {
    var play = video.querySelector('[data-play]');
    var place = video.getAttribute('data-place') || 'article-top';
    if (play) play.addEventListener('click', function () {
      var id = video.getAttribute('data-id');
      var box = document.createElement('div');
      box.className = 'video-frame';
      var f = document.createElement('iframe');
      f.src = 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(id) + '?rel=0&autoplay=1';
      f.title = 'Видео к статье';
      f.allow = 'accelerometer; clipboard-write; encrypted-media; picture-in-picture; fullscreen';
      f.setAttribute('allowfullscreen', '');
      box.appendChild(f);
      play.replaceWith(box);
      goal('video_play', { article: location.pathname, place: place });
    });
    var out = video.querySelector('[data-yt-out]');
    if (out) out.addEventListener('click', function () { goal('youtube_click', { article: location.pathname, place: place }); });
  });

  /* ── Дочитывание ───────────────────────────────────────────────── */
  /* Считаем по положению метки в конце текста, а не через IntersectionObserver:
     при прыжке в самый низ (клавиша End, быстрый флик) метка не успевает
     побывать в кадре, и наблюдатель молчит. Проверка по координате ловит и это. */
  var body = document.querySelector('.body');
  if (body) {
    var endMark = document.createElement('div');
    body.appendChild(endMark);
    var fired = false, ticking = false;
    var check = function () {
      ticking = false;
      if (fired) return;
      var r = endMark.getBoundingClientRect();
      if (r.top <= window.innerHeight) {
        fired = true;
        goal('read_end', { article: location.pathname });
        window.removeEventListener('scroll', onScroll);
      }
    };
    var onScroll = function () {
      if (!ticking) { ticking = true; window.requestAnimationFrame(check); }
    };
    // Только по прокрутке: статью, целиком поместившуюся на экран, дочитыванием не считаем.
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  /* ── Запоминаем ленту, чтобы вернуться в ту же точку ───────────── */
  var feed = document.querySelector('[data-feed]');
  try {
    if (feed) {
      var save = function () { sessionStorage.setItem('vm2007:feed', JSON.stringify({ url: location.href, y: window.scrollY })); };
      window.addEventListener('pagehide', save);
      document.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('a[href*="/articles/"]')) save(); });
      var st = JSON.parse(sessionStorage.getItem('vm2007:feed') || 'null');
      if (st && st.url === location.href && st.y > 0 && !location.hash) {
        if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
        window.addEventListener('load', function () { window.scrollTo(0, st.y); });
      }
    }
    var back = document.querySelector('[data-back-to-feed]');
    if (back) {
      var prev = JSON.parse(sessionStorage.getItem('vm2007:feed') || 'null');
      if (prev && prev.url) back.href = prev.url;
    }
  } catch (e) {}

  /* ── «Показать ещё»: без JS остаётся обычной ссылкой на /page/N ── */
  var more = document.querySelector('[data-more]');
  if (more && feed && window.fetch) {
    more.addEventListener('click', function (e) {
      e.preventDefault();
      var href = more.getAttribute('href');
      more.textContent = 'Загружаем…';
      fetch(href).then(function (r) { return r.text(); }).then(function (html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var next = doc.querySelector('[data-feed]');
        if (next) Array.prototype.forEach.call(next.children, function (c) { feed.appendChild(c); });
        var nextMore = doc.querySelector('[data-more]');
        var status = doc.querySelector('[data-status]');
        var cur = document.querySelector('[data-status]');
        if (status && cur) cur.textContent = status.textContent;
        if (nextMore) { more.setAttribute('href', nextMore.getAttribute('href')); more.textContent = 'Показать ещё'; }
        else more.remove();
        history.replaceState(null, '', href);
      }).catch(function () { location.href = href; });
    });
  }

  /* ── Полоса прогресса чтения ────────────────────────────────────── */
  var progress = document.querySelector('[data-progress]');
  var articleBody = document.querySelector('.article');
  if (progress && articleBody) {
    progress.hidden = false;
    var progressFill = progress.firstElementChild, pTicking = false;
    var drawProgress = function () {
      pTicking = false;
      var box = articleBody.getBoundingClientRect();
      var total = box.height - window.innerHeight;
      var done = total > 0 ? Math.min(1, Math.max(0, -box.top / total)) : 0;
      progressFill.style.width = (done * 100).toFixed(1) + '%';
    };
    window.addEventListener('scroll', function () {
      if (!pTicking) { pTicking = true; window.requestAnimationFrame(drawProgress); }
    }, { passive: true });
    window.addEventListener('resize', drawProgress);
    drawProgress();
  }

  /* ── Кнопка «наверх» ────────────────────────────────────────────── */
  var toTop = document.querySelector('[data-to-top]');
  if (toTop) {
    var tTicking = false;
    var toggleTop = function () {
      tTicking = false;
      toTop.hidden = window.scrollY < window.innerHeight * 1.5;
    };
    window.addEventListener('scroll', function () {
      if (!tTicking) { tTicking = true; window.requestAnimationFrame(toggleTop); }
    }, { passive: true });
    toTop.addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    toggleTop();
  }

  /* ── Подсветка активного пункта оглавления ──────────────────────── */
  var tocLinks = Array.prototype.slice.call(document.querySelectorAll('.toc a[href^="#"]'));
  if (tocLinks.length) {
    var heads = tocLinks.map(function (a) {
      return document.getElementById(decodeURIComponent(a.getAttribute('href').slice(1)));
    });
    var hTicking = false;
    var markToc = function () {
      hTicking = false;
      var best = 0;
      heads.forEach(function (h, i) { if (h && h.getBoundingClientRect().top < 140) best = i; });
      tocLinks.forEach(function (a, i) { a.classList.toggle('on', i === best); });
    };
    window.addEventListener('scroll', function () {
      if (!hTicking) { hTicking = true; window.requestAnimationFrame(markToc); }
    }, { passive: true });
    markToc();
  }

  /* ── Поделиться и «читать позже» ────────────────────────────────── */
  // Список отложенного живёт только в этом браузере: без регистрации, без сервера.
  var SAVED_KEY = 'vm2007:saved';
  function readSaved() {
    try { return JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'); } catch (e) { return []; }
  }
  function writeSaved(list) {
    try { localStorage.setItem(SAVED_KEY, JSON.stringify(list.slice(0, 200))); } catch (e) {}
  }

  var shareBox = document.querySelector('[data-share]');
  if (shareBox) {
    var copyBtn = shareBox.querySelector('[data-share-copy]');
    copyBtn.addEventListener('click', function () {
      var done = function () {
        var was = copyBtn.textContent;
        copyBtn.textContent = 'Ссылка скопирована';
        setTimeout(function () { copyBtn.textContent = was; }, 2000);
      };
      if (navigator.clipboard) navigator.clipboard.writeText(location.href).then(done, done);
      else done();
      goal('share', { place: 'copy' });
    });
    shareBox.querySelectorAll('[data-share-tg],[data-share-vk]').forEach(function (a) {
      a.addEventListener('click', function () {
        goal('share', { place: a.hasAttribute('data-share-tg') ? 'telegram' : 'vk' });
      });
    });

    var saveBtn = shareBox.querySelector('[data-save]');
    var here = location.pathname;
    var mark = function () {
      var on = readSaved().some(function (x) { return x.href === here; });
      saveBtn.setAttribute('aria-pressed', String(on));
      saveBtn.textContent = on ? '✓ В списке «позже»' : 'Читать позже';
    };
    saveBtn.addEventListener('click', function () {
      var list = readSaved();
      var i = list.findIndex(function (x) { return x.href === here; });
      if (i >= 0) list.splice(i, 1);
      else list.unshift({ href: here, title: shareBox.getAttribute('data-title'), at: Date.now() });
      writeSaved(list);
      mark();
      if (i < 0) goal('save_later', { article: here });
    });
    mark();
  }

  /* ── Страница «Читать позже» ────────────────────────────────────── */
  var savedList = document.querySelector('[data-saved-list]');
  if (savedList) {
    var items = readSaved();
    var empty = document.querySelector('[data-saved-empty]');
    if (!items.length) { if (empty) empty.hidden = false; }
    else {
      fetch(new URL('search-index.json', new URL('../', BASE)).href)
        .then(function (r) { return r.json(); })
        .then(function (all) {
          var byHref = {};
          all.forEach(function (a) { byHref[a.href] = a; });
          var html = items.map(function (it) {
            var a = byHref[it.href];
            if (!a) return '';
            return '<article class="card">'
              + '<a class="cover" href="' + a.href + '" tabindex="-1" aria-hidden="true">'
              + (a.cover ? '<img src="' + a.cover + '" alt="" width="1600" height="900" loading="lazy" decoding="async">'
                         : '<span class="ph">Обложка 16:9</span>')
              + (a.video ? '<span class="badge-video">▶ Есть видео</span>' : '') + '</a>'
              + '<div class="card-body"><div class="card-meta"><span class="kicker">' + a.category
              + '</span><span class="readtime">' + a.read + '</span></div>'
              + '<h2><a href="' + a.href + '">' + a.title + '</a></h2><p>' + a.excerpt + '</p>'
              + '<a class="read-more" href="' + a.href + '">Читать →</a></div></article>';
          }).join('');
          savedList.innerHTML = html;
          // Статью могли удалить или переименовать — тогда список пуст, хотя записи есть.
          if (!html && empty) empty.hidden = false;
        })
        .catch(function () { if (empty) empty.hidden = false; });
    }
  }

  /* ── Страница поиска ───────────────────────────────────────────── */
  var results = document.querySelector('[data-search-results]');
  var query = new URLSearchParams(location.search).get('q') || '';
  if (results && query) {
    var input = document.querySelector('[data-search-input]');
    if (input) input.value = query;
    var qTitle = document.querySelector('[data-search-title]');
    var qLead = document.querySelector('[data-search-lead]');
    var qEmpty = document.querySelector('[data-search-empty]');
    if (qTitle) qTitle.textContent = '«' + query + '»';
    fetch(new URL('search-index.json', new URL('../', BASE)).href).then(function (r) { return r.json(); }).then(function (items) {
      var needle = query.toLowerCase().trim();
      var found = items.filter(function (a) {
        return (a.title + ' ' + a.excerpt + ' ' + a.tags.join(' ') + ' ' + a.category).toLowerCase().indexOf(needle) >= 0;
      });
      if (qLead) qLead.textContent = 'Найдено материалов: ' + found.length;
      if (!found.length) { if (qEmpty) qEmpty.hidden = false; return; }
      results.innerHTML = found.map(function (a) {
        return '<article class="card">'
          + '<a class="cover" href="' + a.href + '" tabindex="-1" aria-hidden="true">'
          + (a.cover ? '<img src="' + a.cover + '" alt="" width="1600" height="900" loading="lazy" decoding="async">'
                     : '<span class="ph">Обложка 16:9</span>')
          + (a.video ? '<span class="badge-video">▶ Есть видео</span>' : '') + '</a>'
          + '<div class="card-body"><div class="card-meta">'
          + '<span class="kicker">' + a.category + '</span><span class="readtime">' + a.read + '</span></div>'
          + '<h2><a href="' + a.href + '">' + a.title + '</a></h2><p>' + a.excerpt + '</p>'
          + '<a class="read-more" href="' + a.href + '">Читать →</a></div></article>';
      }).join('');
      goal('search', { query: query, results: found.length });
    }).catch(function () { if (qEmpty) qEmpty.hidden = false; });
  }
})();
