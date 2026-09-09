/* «Верните мой 2007» — минимальный клиентский слой. Всё содержимое уже в HTML. */
(function () {
  'use strict';
  var BASE = (document.querySelector('link[rel=canonical]') || {}).href || location.href;

  function goal(name, params) {
    try {
      if (window.ym && window.ym.a) { var id = window.ym.a[0] && window.ym.a[0][0]; if (id) window.ym(id, 'reachGoal', name, params); }
      if (window.gtag) window.gtag('event', name, params || {});
    } catch (e) {}
  }

  /* ── Поиск ─────────────────────────────────────────────────────── */
  var bar = document.getElementById('searchbar');
  Array.prototype.forEach.call(document.querySelectorAll('[data-search-toggle]'), function (b) {
    b.addEventListener('click', function () {
      if (!bar) return;
      var open = bar.hidden;
      bar.hidden = !open;
      document.querySelectorAll('[data-search-toggle][aria-expanded]').forEach(function (t) {
        t.setAttribute('aria-expanded', String(open));
      });
      if (open) { var i = bar.querySelector('input'); if (i) i.focus(); }
    });
  });

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
  var video = document.querySelector('[data-video]');
  if (video) {
    var play = video.querySelector('[data-play]');
    play.addEventListener('click', function () {
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
      goal('video_play', { article: location.pathname });
    });
    var out = video.querySelector('[data-yt-out]');
    if (out) out.addEventListener('click', function () { goal('youtube_click', { article: location.pathname }); });
  }

  /* ── Дочитывание ───────────────────────────────────────────────── */
  var body = document.querySelector('.body');
  if (body && 'IntersectionObserver' in window) {
    var end = document.createElement('div');
    body.appendChild(end);
    var io = new IntersectionObserver(function (es) {
      if (es.some(function (e) { return e.isIntersecting; })) { goal('read_end', { article: location.pathname }); io.disconnect(); }
    });
    io.observe(end);
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

  /* ── Страница поиска ───────────────────────────────────────────── */
  var results = document.querySelector('[data-search-results]');
  if (results) {
    var q = new URLSearchParams(location.search).get('q') || '';
    var input = document.querySelector('[data-search-input]');
    if (input) input.value = q;
    var title = document.querySelector('[data-search-title]');
    var lead = document.querySelector('[data-search-lead]');
    var empty = document.querySelector('[data-search-empty]');
    if (!q) return;
    if (title) title.textContent = '«' + q + '»';
    var base = document.body.getAttribute('data-base') || '';
    fetch(new URL('search-index.json', new URL('../', BASE)).href).then(function (r) { return r.json(); }).then(function (items) {
      var needle = q.toLowerCase().trim();
      var found = items.filter(function (a) {
        return (a.title + ' ' + a.excerpt + ' ' + a.tags.join(' ') + ' ' + a.category).toLowerCase().indexOf(needle) >= 0;
      });
      if (lead) lead.textContent = 'Найдено материалов: ' + found.length;
      if (!found.length) { if (empty) empty.hidden = false; return; }
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
      goal('search', { query: q, results: found.length });
    }).catch(function () { if (empty) empty.hidden = false; });
  }
})();
