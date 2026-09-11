/* Админка «Верните мой 2007».
   Хранилище — сам репозиторий GitHub: статьи (JSON) и картинки коммитятся через GitHub API,
   после чего GitHub Actions пересобирает статический сайт. localStorage хранит только токен. */
(function () {
  'use strict';

  /* Админку нельзя открывать внутри чужой страницы: невидимый фрейм поверх
     чужой кнопки — классический способ заставить нажать «Удалить» чужими
     руками. Запретить фреймы заголовком на GitHub Pages негде, поэтому
     проверяем сами. */
  if (window.top !== window.self) {
    document.documentElement.innerHTML = '<body style="background:#0A0A0A;color:#E8E8E8;'
      + 'font:600 15px system-ui,sans-serif;padding:40px">Админка открыта внутри чужой страницы '
      + 'и остановлена. Откройте её в отдельной вкладке.</body>';
    return;
  }

  var CFG = window.VM2007 || {};
  var API = 'https://api.github.com';
  var VAULT_KEY = 'vm2007:vault';   // {v, login, salt, iv, data} — токен под паролем
  var OLD_TOKEN_KEY = 'vm2007:token';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var state = {
    token: '', user: '', articles: [], site: null, siteSha: '', filter: 'all',
    draft: null, editingPath: null, editingSha: null, originalSlug: null, originalStatus: null,
    pendingCover: null, chunks: [], dirty: false,
    // Загруженные в этой сессии картинки: на сайте они появятся только после
    // пересборки, а показать их нужно сразу. Ключ — путь вида /uploads/файл.webp.
    localPreviews: {},
  };

  /* ── Мелочи ─────────────────────────────────────────────────────── */
  function toast(msg, isError, link) {
    var t = document.createElement('div');
    t.className = 'toast' + (isError ? ' err' : '');
    t.textContent = msg;
    if (link) {
      t.appendChild(document.createTextNode(' '));
      var a = document.createElement('a');
      a.href = link.href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = link.text;
      a.addEventListener('click', function (e) { e.stopPropagation(); });
      t.appendChild(a);
    }
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, isError ? 14000 : 3500);
    t.addEventListener('click', function () { t.remove(); });
  }
  function progress(p) { $('#progress').style.width = (p ? p + '%' : '0'); }
  /* Адрес картинки для показа в админке: свежезагруженная берётся из памяти,
     остальные — с сайта. */
  function mediaUrl(src) {
    if (!src) return '';
    var path = src.charAt(0) === '/' ? src : '/uploads/' + src;
    return state.localPreviews[path] || (CFG.base || '') + path;
  }

  var TRANSLIT = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',
    п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
  function slugify(s) {
    return String(s || '').toLowerCase().split('').map(function (c) { return TRANSLIT[c] !== undefined ? TRANSLIT[c] : c; })
      .join('').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  var MONTHS = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  function ruDate(iso) {
    if (!iso) return '';
    var d = new Date(iso + 'T00:00:00Z');
    return isNaN(d) ? iso : d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }
  function youtubeId(link) {
    var m = String(link || '').match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{6,})/);
    return m ? m[1] : '';
  }
  function b64utf8(str) {
    var bytes = new TextEncoder().encode(str), bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64bytes(buf) {
    var bytes = new Uint8Array(buf), bin = '', CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(bin);
  }

  /* ── Сейф с токеном ─────────────────────────────────────────────────
     Пароль не хранится и никуда не отправляется: из него выводится ключ,
     которым шифруется токен GitHub. Расшифровать сейф без пароля нельзя,
     а сам токен в открытом виде не попадает ни в localStorage, ни в репозиторий. */
  var enc = new TextEncoder(), dec = new TextDecoder();
  function b64(buf) {
    var bytes = new Uint8Array(buf), bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function unb64(str) {
    var bin = atob(str), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  function deriveKey(pass, salt) {
    return crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey'])
      .then(function (km) {
        return crypto.subtle.deriveKey(
          { name: 'PBKDF2', salt: salt, iterations: 210000, hash: 'SHA-256' },
          km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      });
  }
  function sealToken(login, pass, token) {
    var salt = crypto.getRandomValues(new Uint8Array(16));
    var iv = crypto.getRandomValues(new Uint8Array(12));
    return deriveKey(pass, salt)
      .then(function (key) { return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, enc.encode(token)); })
      .then(function (ct) {
        localStorage.setItem(VAULT_KEY, JSON.stringify({
          v: 1, login: login, salt: b64(salt), iv: b64(iv), data: b64(ct),
        }));
      });
  }
  function openVault(login, pass) {
    var vault = readVault();
    if (!vault) return Promise.reject(new Error('Вход на этом устройстве не настроен.'));
    if (String(login).trim().toLowerCase() !== String(vault.login).toLowerCase()) {
      return Promise.reject(new Error('Неверный логин или пароль.'));
    }
    return deriveKey(pass, unb64(vault.salt))
      .then(function (key) {
        return crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(vault.iv) }, key, unb64(vault.data));
      })
      .then(function (buf) { return dec.decode(buf); })
      // Неверный пароль ломает проверку целостности AES-GCM — отличить его от
      // порчи данных нельзя, да и не нужно: сообщение одно.
      .catch(function () { throw new Error('Неверный логин или пароль.'); });
  }
  function readVault() {
    try {
      var raw = localStorage.getItem(VAULT_KEY);
      if (!raw) return null;
      var v = JSON.parse(raw);
      return (v && v.salt && v.iv && v.data && v.login) ? v : null;
    } catch (e) { return null; }
  }

  /* ── GitHub API ─────────────────────────────────────────────────── */
  function gh(path, opts) {
    opts = opts || {};
    var headers = Object.assign({
      Authorization: 'Bearer ' + state.token,
      Accept: opts.raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    }, opts.headers || {});
    if (opts.body) headers['Content-Type'] = 'application/json';
    return fetch(API + path, { method: opts.method || 'GET', headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined })
      .then(function (r) {
        if (r.status === 404 && opts.allow404) return null;
        if (!r.ok) return r.text().then(function (t) {
          var msg = t;
          try { msg = JSON.parse(t).message || t; } catch (e) {}
          // 403 на запись почти всегда значит одно: у токена нет права Contents: write.
          // Пишем по-человечески, что именно чинить, — иначе фраза от GitHub ни о чём.
          if (r.status === 403 && /not accessible by personal access token/i.test(msg)) {
            throw new Error('У токена нет прав на запись в репозиторий. Откройте на GitHub '
              + 'Settings → Developer settings → Personal access tokens → Fine-grained tokens, '
              + 'проверьте у токена: Repository access — «Only select repositories» и выбран '
              + CFG.repo + '; Permissions → Repository permissions → Contents: Read and write. '
              + 'Если стоит «Public Repositories (read-only)» — выпустите новый токен и войдите заново '
              + 'через «Забыли пароль или меняете токен».');
          }
          if (r.status === 401) {
            throw new Error('GitHub не принял токен: он отозван или истёк. '
              + 'Выпустите новый и войдите заново через «Забыли пароль или меняете токен».');
          }
          throw new Error('GitHub ' + r.status + ': ' + msg);
        });
        if (r.status === 204) return null;
        return opts.raw ? r.text() : r.json();
      });
  }
  var repoPath = function (p) { return '/repos/' + CFG.repo + p; };
  var contentPath = function (rel) { return (CFG.contentPath || 'content') + '/' + rel; };

  /* Один атомарный коммит на несколько файлов (Git Data API).
     Две защиты от столкновений:
     1. Очередь. Записи идут строго по одной: параллельные вызовы (сохранение статьи
        и загрузка картинки, два быстрых клика) читали одно состояние ветки и
        отменяли друг друга.
     2. Повтор. Ветка могла уехать и снаружи — из другой вкладки или от меня же;
        плюс GitHub отдаёт ссылку на ветку с задержкой. Тогда коммит пересобирается
        поверх свежего состояния. */
  var writeQueue = Promise.resolve();
  function commitFiles(files, message, deletions) {
    var run = function () { return commitOnce(files, message, deletions, 0); };
    // Ошибка одной записи не должна ломать очередь для следующих.
    var result = writeQueue.then(run, run);
    writeQueue = result.catch(function () {});
    return result;
  }

  function commitOnce(files, message, deletions, attempt) {
    var branch = CFG.branch || 'main';
    var headSha, treeSha;
    return gh(repoPath('/git/ref/heads/' + branch + '?_=' + Date.now()))
      .then(function (ref) { headSha = ref.object.sha; return gh(repoPath('/git/commits/' + headSha)); })
      .then(function (c) {
        treeSha = c.tree.sha;
        return Promise.all(files.map(function (f) {
          return gh(repoPath('/git/blobs'), { method: 'POST',
            body: { content: f.base64 || b64utf8(f.content), encoding: 'base64' } })
            .then(function (b) { return { path: f.path, mode: '100644', type: 'blob', sha: b.sha }; });
        }));
      })
      .then(function (entries) {
        (deletions || []).forEach(function (p) { entries.push({ path: p, mode: '100644', type: 'blob', sha: null }); });
        return gh(repoPath('/git/trees'), { method: 'POST', body: { base_tree: treeSha, tree: entries } });
      })
      .then(function (tree) {
        return gh(repoPath('/git/commits'), { method: 'POST', body: { message: message, tree: tree.sha, parents: [headSha] } });
      })
      .then(function (commit) {
        return gh(repoPath('/git/refs/heads/' + branch), { method: 'PATCH', body: { sha: commit.sha } });
      })
      .catch(function (e) {
        var collision = /fast forward|is at .* but expected|reference already exists/i.test(e.message);
        if (collision && attempt < 6) {
          // Пауза растёт: 0.6с, 1.2с, 2.4с… — GitHub успевает отдать свежую ветку.
          var wait = Math.min(600 * Math.pow(2, attempt), 6000);
          return new Promise(function (r) { setTimeout(r, wait); })
            .then(function () { return commitOnce(files, message, deletions, attempt + 1); });
        }
        if (collision) {
          throw new Error('Репозиторий изменился во время сохранения, и шесть попыток подряд не помогли. '
            + 'Скорее всего, открыта вторая вкладка админки — закройте её и нажмите сохранение ещё раз. '
            + 'Ничего не потеряно: текст остался в форме.');
        }
        throw e;
      });
  }

  /* ── Загрузка контента ──────────────────────────────────────────── */
  function loadAll() {
    progress(20);
    return gh(repoPath('/contents/' + contentPath('site.json') + '?ref=' + (CFG.branch || 'main')), { raw: true })
      .then(function (text) {
        state.site = JSON.parse(text);
        progress(45);
        return gh(repoPath('/contents/' + contentPath('articles') + '?ref=' + (CFG.branch || 'main')), { allow404: true });
      })
      .then(function (list) {
        var files = (list || []).filter(function (f) { return /\.json$/.test(f.name); });
        return Promise.all(files.map(function (f) {
          return gh(repoPath('/contents/' + f.path + '?ref=' + (CFG.branch || 'main')), { raw: true })
            .then(function (text) { return { path: f.path, sha: f.sha, data: JSON.parse(text) }; });
        }));
      })
      .then(function (items) {
        state.articles = items.sort(function (a, b) {
          return String(b.data.publishedAt || '').localeCompare(String(a.data.publishedAt || ''));
        });
        progress(100);
        setTimeout(function () { progress(0); }, 400);
      });
  }

  /* ── Экран входа ──────────────────────────────────────────────────
     Два режима: обычный вход логином и паролем и первая настройка
     на устройстве, где вместе с паролем сохраняется токен GitHub. */
  function showLogin(message) {
    $('#app').hidden = true;
    $('#screen-login').hidden = false;
    $('#login-repo').textContent = CFG.repo || '(репозиторий не задан)';
    var vault = readVault();
    $('#form-unlock').hidden = !vault;
    $('#form-setup').hidden = !!vault;
    if (vault) $('#u-login').value = vault.login;
    var err = $(vault ? '#u-error' : '#s-error');
    err.hidden = !message;
    err.textContent = message || '';
    var first = $(vault ? '#u-pass' : '#s-login');
    if (first) first.focus();
  }

  $('#form-unlock').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = $('button[type=submit]', this);
    btn.disabled = true;
    openVault($('#u-login').value, $('#u-pass').value)
      .then(function (token) { return enter(token); })
      .catch(function (err) { showLogin(err.message); })
      .then(function () { btn.disabled = false; $('#u-pass').value = ''; });
  });

  $('#form-setup').addEventListener('submit', function (e) {
    e.preventDefault();
    var login = $('#s-login').value.trim();
    var pass = $('#s-pass').value;
    var pass2 = $('#s-pass2').value;
    var token = $('#s-token').value.trim();
    if (!login) return showLogin('Придумайте логин.');
    if (pass.length < 8) return showLogin('Пароль короче восьми символов — так не годится.');
    if (pass !== pass2) return showLogin('Пароли не совпадают.');
    if (!token) return showLogin('Вставьте токен GitHub.');
    var btn = $('button[type=submit]', this);
    btn.disabled = true;
    // Сначала проверяем токен у GitHub, и только рабочий кладём в сейф.
    enter(token)
      .then(function () {
        return sealToken(login, pass, token).then(function () {
          try { localStorage.removeItem(OLD_TOKEN_KEY); sessionStorage.removeItem(OLD_TOKEN_KEY); } catch (e) {}
          toast('Вход настроен. Дальше — только логин и пароль.');
        });
      })
      .catch(function (err) { showLogin(err.message); })
      .then(function () {
        btn.disabled = false;
        $('#s-pass').value = $('#s-pass2').value = $('#s-token').value = '';
      });
  });

  $('#u-reset').addEventListener('click', function () {
    if (!confirm('Сохранённый доступ будет удалён, и вход настраивается заново — понадобится токен GitHub. Продолжить?')) return;
    try { localStorage.removeItem(VAULT_KEY); } catch (e) {}
    showLogin('');
  });

  $('#logout').addEventListener('click', function () {
    state.token = '';
    location.reload();
  });

  /* Проверка токена у GitHub и загрузка контента. Токен живёт только в памяти
     вкладки: после перезагрузки страницы пароль спрашивается снова. */
  function enter(token) {
    if (!CFG.repo) return Promise.reject(new Error('В config.js не задан репозиторий. Соберите сайт заново.'));
    state.token = token;
    progress(10);
    return gh('/user')
      .then(function (u) { state.user = u.login; return gh(repoPath('')); })
      .then(function (repo) {
        if (repo.permissions && repo.permissions.push === false) {
          throw new Error('У токена нет прав на запись (Contents: Read and write).');
        }
        $('#screen-login').hidden = true;
        $('#app').hidden = false;
        $('#whoami').textContent = state.user + ' · ' + CFG.repo;
        return loadAll().then(function () { route('list'); });
      })
      .catch(function (e) {
        progress(0);
        state.token = '';
        throw e;
      });
  }

  /* ── Роутинг экранов ────────────────────────────────────────────── */
  function route(name) {
    ['list', 'editor', 'auto', 'stats'].forEach(function (s) { $('#screen-' + s).hidden = s !== name; });
    $$('.btn.tab[data-tab]').forEach(function (b) {
      b.setAttribute('aria-selected', String(b.dataset.tab === (name === 'editor' ? 'list' : name)));
    });
    if (name === 'list') renderList();
    if (name === 'auto') renderAuto();
    if (name === 'stats') renderStats();
    window.scrollTo(0, 0);
  }
  $$('.btn.tab[data-tab]').forEach(function (b) {
    b.addEventListener('click', function () { route(b.dataset.tab); });
  });
  $('#back-to-list').addEventListener('click', function () {
    if (state.dirty && !confirm('Несохранённые изменения пропадут. Выйти?')) return;
    state.dirty = false; route('list');
  });

  /* ── Список статей ──────────────────────────────────────────────── */
  $$('[data-filter]').forEach(function (b) {
    b.addEventListener('click', function () {
      state.filter = b.dataset.filter;
      $$('[data-filter]').forEach(function (x) { x.classList.toggle('on', x === b); });
      renderList();
    });
  });

  function catTitle(id) {
    var c = (state.site.categories || []).find(function (x) { return x.id === id; });
    return c ? c.title : id;
  }

  function renderList() {
    var box = $('#articles');
    var items = state.articles.filter(function (a) {
      return state.filter === 'all' || a.data.status === state.filter;
    });
    box.innerHTML = items.length ? items.map(function (a, i) {
      var d = a.data;
      var cover = mediaUrl(d.cover && d.cover.src);
      return '<div class="item" data-idx="' + i + '">'
        + (cover ? '<img class="thumb" src="' + esc(cover) + '" alt="">' : '<div class="thumb"></div>')
        + '<div class="main"><div class="row" style="gap:8px">'
        + '<span class="kick">' + esc(catTitle(d.category)) + '</span>'
        + (d.youtubeUrl ? '<span class="pill">Видео</span>' : '')
        + (d.demo ? '<span class="pill" style="background:#383838;color:#E8E8E8">Демо</span>' : '')
        + '</div><div class="t">' + esc(d.title) + '</div>'
        + '<div class="u">/articles/' + esc(d.slug) + '</div></div>'
        + '<div class="status ' + (d.status === 'published' ? 'pub' : 'draft') + '">'
        + (d.status === 'published' ? 'Опубликовано' : 'Черновик') + '</div>'
        + '<div class="date">' + esc(ruDate(d.publishedAt)) + '</div>'
        + '<div class="row" style="gap:8px">'
        + '<button class="btn sm" data-edit="' + esc(d.slug) + '">Править</button>'
        + '<button class="btn sm" data-toggle="' + esc(d.slug) + '">'
        + (d.status === 'published' ? 'Снять' : 'Опубликовать') + '</button></div></div>';
    }).join('') : '<div class="item"><div class="main"><div class="t">Пока пусто</div>'
      + '<div class="u">Нажмите «+ Новая статья», чтобы создать первый материал.</div></div></div>';

    $$('[data-edit]', box).forEach(function (b) {
      b.addEventListener('click', function () { openEditor(findArticle(b.dataset.edit)); });
    });
    $$('[data-toggle]', box).forEach(function (b) {
      b.addEventListener('click', function () { toggleStatus(findArticle(b.dataset.toggle)); });
    });
    renderCategories();
  }
  function findArticle(slug) {
    return state.articles.find(function (a) { return a.data.slug === slug; });
  }

  function renderCategories() {
    var box = $('#categories');
    box.innerHTML = (state.site.categories || []).map(function (c) {
      var count = state.articles.filter(function (a) { return a.data.category === c.id && a.data.status === 'published'; }).length;
      return '<div class="r" data-cat="' + esc(c.id) + '">'
        + '<span style="font-weight:800;font-size:14px;text-transform:uppercase;color:#fff;min-width:140px">' + esc(c.title) + '</span>'
        + '<span class="hint" style="flex:1 1 auto">' + count + ' опубликованных</span>'
        + '<input type="text" data-cat-desc="' + esc(c.id) + '" value="' + esc(c.description || '') + '" '
        + 'placeholder="Описание раздела" style="flex:2 1 260px;height:38px;font-size:13px;font-weight:500">'
        + '<button class="btn sm ' + (c.enabled !== false ? 'on' : '') + '" data-cat-toggle="' + esc(c.id) + '">'
        + (c.enabled !== false ? 'Включена' : 'Выключена') + '</button></div>';
    }).join('') + '<div class="r"><button class="btn sm primary" id="save-cats">Сохранить категории</button>'
      + '<span class="hint">Изменения уедут в репозиторий и сайт пересоберётся.</span></div>';

    $$('[data-cat-toggle]', box).forEach(function (b) {
      b.addEventListener('click', function () {
        var c = state.site.categories.find(function (x) { return x.id === b.dataset.catToggle; });
        c.enabled = c.enabled === false;
        renderCategories();
      });
    });
    $('#save-cats').addEventListener('click', function () {
      $$('[data-cat-desc]', box).forEach(function (i) {
        var c = state.site.categories.find(function (x) { return x.id === i.dataset.catDesc; });
        if (c) c.description = i.value.trim();
      });
      saveSite('Категории: обновлены настройки разделов').then(function () { toast('Категории сохранены. Сайт пересобирается.'); });
    });
  }

  function saveSite(message) {
    return commitFiles([{ path: contentPath('site.json'), content: JSON.stringify(state.site, null, 2) + '\n' }], message)
      .catch(function (e) { toast(e.message, true); throw e; });
  }

  function toggleStatus(item) {
    var d = item.data;
    var next = d.status === 'published' ? 'draft' : 'published';
    d.status = next;
    d.updatedAt = new Date().toISOString().slice(0, 10);
    commitFiles([{ path: item.path, content: JSON.stringify(d, null, 2) + '\n' }],
      (next === 'published' ? 'Публикация' : 'Снятие с публикации') + ': ' + d.title)
      .then(function () { toast(next === 'published' ? 'Опубликовано. Сайт пересобирается (~1 минута).' : 'Снято с публикации.'); renderList(); })
      .catch(function (e) { d.status = next === 'published' ? 'draft' : 'published'; toast(e.message, true); });
  }

  /* ── Редактор ───────────────────────────────────────────────────── */
  var FOCUS = ['0% 0%','50% 0%','100% 0%','0% 50%','50% 50%','100% 50%','0% 100%','50% 100%','100% 100%'];
  var ROLES = [['h2','H2'],['h3','H3'],['p','Абзац'],['quote','Цитата'],['list','Список'],['image','Фото'],['rule','Разделитель']];

  function emptyDraft() {
    return { slug: '', title: '', excerpt: '', lead: '', category: (state.site.categories[0] || {}).id,
      tags: [], youtubeUrl: '', cover: { src: '', alt: '', focus: '50% 50%' }, ogImage: '',
      author: state.site.author || 'Редакция', publishedAt: new Date().toISOString().slice(0, 10),
      status: 'draft', seoTitle: '', seoDescription: '', body: [{ type: 'p', text: '' }],
      sources: [], related: [], aliases: [], faq: [], demo: false };
  }

  $('#new-article').addEventListener('click', function () { openEditor(null); });

  function openEditor(item) {
    state.draft = item ? JSON.parse(JSON.stringify(item.data)) : emptyDraft();
    state.editingPath = item ? item.path : null;
    state.editingSha = item ? item.sha : null;
    state.originalSlug = item ? item.data.slug : null;
    state.originalStatus = item ? item.data.status : null;
    state.pendingCover = null;
    state.dirty = false;
    fillEditor();
    route('editor');
  }

  function fillEditor() {
    var d = state.draft;
    $('#editor-title').textContent = state.editingPath ? d.title || 'Без названия' : 'Новая статья.';
    $('#publish').textContent = d.status === 'published' ? 'Обновить' : 'Опубликовать';
    $('#delete-article').disabled = !state.editingPath;
    $('#f-title').value = d.title || '';
    $('#f-slug').value = d.slug || '';
    $('#f-excerpt').value = d.excerpt || '';
    $('#f-lead').value = d.lead || '';
    $('#f-tags').value = (d.tags || []).join(', ');
    $('#f-aliases').value = (d.aliases || []).join(', ');
    $('#f-youtube').value = d.youtubeUrl || '';
    $('#f-author').value = d.author || '';
    $('#f-date').value = d.publishedAt || '';
    $('#f-seo-title').value = d.seoTitle || '';
    $('#f-seo-desc').value = d.seoDescription || '';
    $('#f-og').value = d.ogImage || '';
    $('#f-cover-alt').value = (d.cover && d.cover.alt) || '';
    $('#f-sources').value = (d.sources || []).join('\n');
    $('#f-faq').value = (d.faq || []).map(function (f) { return f.q + '\n' + f.a; }).join('\n\n');
    var demo = $('#f-demo');
    demo.setAttribute('aria-pressed', String(!!d.demo));
    $('.box', demo).textContent = d.demo ? '✓' : '';
    $('#editor-note').hidden = true;
    renderCover();
    renderFocus();
    renderCatChoices();
    renderRelated();
    renderBlocks();
    updateHints();
  }

  function bind(sel, key, transform) {
    $(sel).addEventListener('input', function () {
      var v = transform ? transform(this.value) : this.value;
      if (key.indexOf('.') > 0) {
        var parts = key.split('.');
        state.draft[parts[0]] = state.draft[parts[0]] || {};
        state.draft[parts[0]][parts[1]] = v;
      } else state.draft[key] = v;
      state.dirty = true;
      updateHints();
    });
  }
  bind('#f-title', 'title');
  bind('#f-excerpt', 'excerpt');
  bind('#f-lead', 'lead');
  bind('#f-youtube', 'youtubeUrl');
  bind('#f-author', 'author');
  bind('#f-date', 'publishedAt');
  bind('#f-seo-title', 'seoTitle');
  bind('#f-seo-desc', 'seoDescription');
  bind('#f-og', 'ogImage');
  bind('#f-cover-alt', 'cover.alt');
  bind('#f-tags', 'tags', function (v) { return v.split(',').map(function (t) { return t.trim(); }).filter(Boolean); });
  bind('#f-aliases', 'aliases', function (v) { return v.split(',').map(function (t) { return t.trim(); }).filter(Boolean); });
  bind('#f-faq', 'faq', parseFaq);
  bind('#f-sources', 'sources', function (v) { return v.split('\n').map(function (t) { return t.trim(); }).filter(Boolean); });
  $('#f-demo').addEventListener('click', function () {
    state.draft.demo = !state.draft.demo;
    this.setAttribute('aria-pressed', String(!!state.draft.demo));
    $('.box', this).textContent = state.draft.demo ? '✓' : '';
    state.dirty = true;
  });
  $('#f-slug').addEventListener('input', function () {
    var v = this.value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
    this.value = v; state.draft.slug = v; state.dirty = true; updateHints();
  });
  $('#f-title').addEventListener('blur', function () {
    if (!state.draft.slug && this.value) { state.draft.slug = slugify(this.value); $('#f-slug').value = state.draft.slug; updateHints(); }
  });

  function updateHints() {
    var d = state.draft;
    var st = $('#f-seo-title').value.length, sd = $('#f-seo-desc').value.length;
    var th = $('#seo-title-hint'); th.textContent = 'Символов: ' + st + (st > 60 ? ' — длиннее 60, в выдаче обрежется' : ' из 60');
    th.className = 'hint' + (st > 60 ? ' warn' : '');
    var dh = $('#seo-desc-hint'); dh.textContent = 'Символов: ' + sd + (sd > 160 ? ' — длиннее 160, в выдаче обрежется' : ' из 160');
    dh.className = 'hint' + (sd > 160 ? ' warn' : '');
    $('#snippet-url').textContent = (CFG.siteUrl || '').replace(/^https?:\/\//, '') + ' › articles › ' + (d.slug || '…');
    $('#snippet-title').textContent = d.seoTitle || d.title || 'Заголовок статьи';
    $('#snippet-desc').textContent = d.seoDescription || d.excerpt || 'Краткое описание материала.';
    var yt = $('#yt-hint'), id = youtubeId(d.youtubeUrl);
    if (!d.youtubeUrl) { yt.textContent = 'Пусто — блок видео на странице не появится.'; yt.className = 'hint'; }
    else if (id) { yt.textContent = 'Ролик распознан: ' + id; yt.className = 'hint'; }
    else { yt.textContent = 'Не похоже на ссылку YouTube.'; yt.className = 'hint warn'; }
    var words = (d.lead + ' ' + (d.body || []).map(blockText).join(' ')).split(/\s+/).filter(Boolean).length;
    var chars = (d.body || []).map(blockText).join(' ').length;
    $('#content-stats').textContent = 'Символов: ' + chars + ' · примерное время чтения '
      + Math.max(1, Math.round(words / 180)) + ' мин';
    renderChecklist();
    if (state.originalSlug && state.originalStatus === 'published' && d.slug !== state.originalSlug) {
      $('#editor-note').hidden = false;
      $('#editor-note').textContent = 'Адрес меняется: со старого /articles/' + state.originalSlug + ' будет поставлен редирект.';
    }
  }
  /* Чек-лист готовности: то, что легко забыть и что потом дорого исправлять.
     Строгие пункты — про SEO и читателя, мягкие — про удобство. */
  function renderChecklist() {
    var d = state.draft;
    if (!d) return;
    var body = d.body || [];
    var text = body.map(blockText).join(' ');
    var h2 = body.filter(function (b) { return b.type === 'h2'; }).length;
    var images = body.filter(function (b) { return b.type === 'image' && b.src; });
    var noAlt = images.filter(function (b) { return !(b.alt || '').trim(); }).length;
    var chars = text.length;
    var seoDesc = (d.seoDescription || '').trim();
    var checks = [
      { hard: true, ok: !!(d.title || '').trim(), text: 'Заголовок' },
      { hard: true, ok: !!(d.slug || '').trim(), text: 'Адрес статьи' },
      { hard: true, ok: !!(d.excerpt || '').trim(), text: 'Краткий анонс — из него собирается карточка в ленте' },
      { hard: true, ok: !!(d.lead || '').trim(), text: 'Лид под заголовком' },
      { hard: true, ok: h2 >= 2,
        text: h2 ? 'Подзаголовков H2: ' + h2 + ' — нужно хотя бы два'
                 : 'Ни одного подзаголовка H2: нет оглавления, и для поиска текст выглядит однородной простынёй' },
      { hard: true, ok: chars >= 1500,
        text: 'Объём текста: ' + chars + ' знаков' + (chars < 1500 ? ' — короткие статьи поиск считает слабыми' : '') },
      { hard: true, ok: !!(d.cover && d.cover.src), text: 'Обложка' },
      { hard: true, ok: !(d.cover && d.cover.src) || !!(d.cover.alt || '').trim(), text: 'Alt-текст обложки' },
      { hard: true, ok: noAlt === 0,
        text: noAlt ? 'Без alt-текста картинок: ' + noAlt : 'У всех картинок есть alt-текст' },
      { hard: true, ok: seoDesc.length > 0 && seoDesc.length <= 160,
        text: !seoDesc ? 'SEO-описание пустое — в выдаче Google допишет своё'
                       : 'SEO-описание: ' + seoDesc.length + ' знаков' + (seoDesc.length > 160 ? ' — обрежется' : '') },
      { hard: false, ok: (d.tags || []).length >= 2,
        text: 'Теги: ' + (d.tags || []).length + ' — по ним собираются подборки и хабы по эпохам' },
      { hard: false, ok: (d.aliases || []).length > 0,
        text: 'Имена для автоссылок — без них другие статьи не сошлются на эту' },
      { hard: false, ok: !!(d.youtubeUrl || '').trim(), text: 'Ссылка на выпуск YouTube' },
      { hard: false, ok: (d.faq || []).length > 0, text: 'Частые вопросы — занимают больше места в выдаче' },
      { hard: false, ok: images.length > 0, text: 'Хотя бы одна картинка в тексте' },
    ];
    var bad = checks.filter(function (c) { return c.hard && !c.ok; }).length;
    $('#checklist').innerHTML = checks.map(function (c) {
      var cls = c.ok ? 'ok' : (c.hard ? 'bad' : 'soft');
      return '<li class="' + cls + '"><span class="mark">' + (c.ok ? '✓' : '✕') + '</span>'
        + '<span>' + esc(c.text) + '</span></li>';
    }).join('');
    var head = $('#checklist-card').querySelector('.sec');
    head.textContent = bad ? 'Готовность: не хватает ' + bad : 'Готовность: всё на месте';
    head.style.color = bad ? 'var(--danger)' : 'var(--accent)';
  }

  function blockText(b) {
    if (!b) return '';
    if (b.type === 'list') return (b.items || []).join(' ');
    return b.text || b.caption || '';
  }

  /* Категории и связанные */
  function renderCatChoices() {
    $('#cat-choices').innerHTML = (state.site.categories || []).map(function (c) {
      return '<button class="btn sm' + (c.id === state.draft.category ? ' on' : '') + '" data-cat="' + esc(c.id) + '">'
        + esc(c.title) + (c.enabled === false ? ' (выкл.)' : '') + '</button>';
    }).join('');
    $$('[data-cat]', $('#cat-choices')).forEach(function (b) {
      b.addEventListener('click', function () { state.draft.category = b.dataset.cat; state.dirty = true; renderCatChoices(); });
    });
  }
  function renderRelated() {
    var others = state.articles.filter(function (a) { return a.data.slug !== state.draft.slug; });
    $('#related-choices').innerHTML = others.length ? others.map(function (a) {
      var on = (state.draft.related || []).indexOf(a.data.slug) >= 0;
      return '<button class="check" aria-pressed="' + on + '" data-rel="' + esc(a.data.slug) + '">'
        + '<span class="box">' + (on ? '✓' : '') + '</span><span>' + esc(a.data.title) + '</span></button>';
    }).join('') : '<span class="hint">Других материалов пока нет — рекомендации появятся, '
      + 'как только в разделе будет больше одной опубликованной статьи.</span>';
    $$('[data-rel]', $('#related-choices')).forEach(function (b) {
      b.addEventListener('click', function () {
        var s = b.dataset.rel, list = state.draft.related || (state.draft.related = []);
        var i = list.indexOf(s);
        if (i >= 0) list.splice(i, 1); else list.push(s);
        state.dirty = true; renderRelated();
      });
    });
  }

  /* Обложка */
  function renderCover() {
    var img = $('#cover-img'), cap = $('#cover-cap');
    var src = state.pendingCover ? state.pendingCover.preview : mediaUrl(state.draft.cover && state.draft.cover.src);
    var note = $('#cover-note');
    if (src) {
      img.src = src; img.hidden = false; cap.textContent = '';
      note.hidden = false;
      note.textContent = state.pendingCover
        ? 'Новая обложка обрезана в 16:9 — загрузится в репозиторий при сохранении.'
        : 'Обложка: ' + state.draft.cover.src;
    } else {
      img.hidden = true; img.removeAttribute('src'); note.hidden = true;
      cap.textContent = 'Перетащите обложку 16:9 или нажмите, чтобы выбрать файл';
    }
  }
  function renderFocus() {
    var cur = (state.draft.cover && state.draft.cover.focus) || '50% 50%';
    $('#focus-grid').innerHTML = FOCUS.map(function (f) {
      return '<button type="button" data-focus="' + f + '" aria-pressed="' + (f === cur) + '" aria-label="Фокус ' + f + '"></button>';
    }).join('');
    $$('[data-focus]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.draft.cover = state.draft.cover || {};
        state.draft.cover.focus = b.dataset.focus;
        state.dirty = true;
        renderFocus();
        if (state.pendingCover) reprocessCover();
      });
    });
  }
  $('#cover-clear').addEventListener('click', function () {
    state.pendingCover = null;
    state.draft.cover = { src: '', alt: $('#f-cover-alt').value, focus: (state.draft.cover || {}).focus || '50% 50%' };
    state.dirty = true; renderCover();
  });
  $('#cover-drop').addEventListener('click', function () { $('#cover-file').click(); });
  $('#cover-file').addEventListener('change', function () { if (this.files[0]) ingestCover(this.files[0]); this.value = ''; });
  ['dragenter', 'dragover'].forEach(function (ev) {
    $('#cover-drop').addEventListener(ev, function (e) { e.preventDefault(); this.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    $('#cover-drop').addEventListener(ev, function (e) { e.preventDefault(); this.classList.remove('over'); });
  });
  $('#cover-drop').addEventListener('drop', function (e) {
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) ingestCover(f);
  });

  var OK_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/avif'];
  function ingestCover(file) {
    if (OK_TYPES.indexOf(file.type) < 0) return toast('Нужен PNG, JPEG, WebP или AVIF.', true);
    if (file.size > 15 * 1024 * 1024) return toast('Файл больше 15 МБ — уменьшите его.', true);
    createImageBitmap(file).then(function (bmp) {
      if (bmp.width < 800) toast('Ширина меньше 800 px — на больших экранах будет мыло.', true);
      state.pendingCover = { bitmap: bmp, name: file.name };
      return reprocessCover();
    }).catch(function () { toast('Не удалось прочитать изображение.', true); });
  }
  /* Кадрирование строго 16:9 по точке фокуса, без искажения пропорций, три размера в WebP. */
  function reprocessCover() {
    var pc = state.pendingCover;
    if (!pc) return Promise.resolve();
    var bmp = pc.bitmap;
    var focus = ((state.draft.cover || {}).focus || '50% 50%').split(' ').map(function (x) { return parseFloat(x) / 100; });
    var srcRatio = bmp.width / bmp.height, target = 16 / 9, sx = 0, sy = 0, sw = bmp.width, sh = bmp.height;
    if (srcRatio > target) { sw = bmp.height * target; sx = (bmp.width - sw) * focus[0]; }
    else { sh = bmp.width / target; sy = (bmp.height - sh) * focus[1]; }
    var widths = [1600, 1000, 600].filter(function (w, i) { return i === 0 || w <= bmp.width; });
    return Promise.all(widths.map(function (w) {
      var c = document.createElement('canvas');
      c.width = w; c.height = Math.round(w * 9 / 16);
      c.getContext('2d').drawImage(bmp, sx, sy, sw, sh, 0, 0, c.width, c.height);
      return new Promise(function (res) { c.toBlob(function (b) { res({ w: w, blob: b }); }, 'image/webp', 0.85); });
    })).then(function (variants) {
      pc.variants = variants;
      pc.preview = URL.createObjectURL(variants[0].blob);
      state.dirty = true;
      renderCover();
    });
  }

  /* ── Блочный редактор ─────────────────────────────────────────────
     Статья хранится плоским списком блоков — так её ждёт сборка. Но в редакторе
     она показывается разделами: раздел начинается с заголовка H2 и держит всё,
     что идёт до следующего. Разделы не хранятся отдельно, а вычисляются из списка,
     поэтому уже написанные статьи открываются как есть, без переделки. */
  function sections() {
    var body = state.draft.body || [];
    var secs = [];
    body.forEach(function (b, i) {
      if (b.type === 'h2' || !secs.length) secs.push({ from: i, to: i, titled: b.type === 'h2' });
      else secs[secs.length - 1].to = i;
    });
    return secs;
  }

  function renderBlocks() {
    var box = $('#blocks');
    var body = state.draft.body || [];
    var secs = sections();
    var num = 0;
    box.innerHTML = secs.map(function (sec, si) {
      var label = sec.titled ? 'Раздел ' + (++num) : 'Вступление';
      var blocks = '';
      for (var i = sec.from; i <= sec.to; i++) blocks += blockHTML(body[i], i);
      return '<section class="artsec" data-sec="' + si + '">'
        + '<div class="artsec-bar"><span class="artsec-n">' + label + '</span>'
        + '<span class="spacer">'
        + (si > 0 ? '<button class="rolebtn" data-sec-up title="Раздел выше">↑</button>' : '')
        + (si < secs.length - 1 ? '<button class="rolebtn" data-sec-down title="Раздел ниже">↓</button>' : '')
        + '<button class="rolebtn" data-sec-del style="color:#FF3B30">Убрать раздел</button>'
        + '</span></div>'
        + blocks
        + '<div class="artsec-add">'
        + [['p', '+ абзац'], ['image', '+ фото'], ['quote', '+ цитата'],
           ['list', '+ список'], ['h3', '+ подзаголовок'], ['rule', '+ разделитель']]
          .map(function (r) { return '<button class="rolebtn" data-sec-add="' + r[0] + '">' + r[1] + '</button>'; }).join('')
        + '</div></section>';
    }).join('') || '<p class="hint">Статья пустая. Нажмите «+ Новый раздел» — появятся заголовок, абзац и место под фото.</p>';

    $$('.block', box).forEach(wireBlock);
    $$('.artsec', box).forEach(wireSection);
    updateHints();
  }

  function newBlock(type) {
    if (type === 'list') return { type: 'list', items: [] };
    if (type === 'image') return { type: 'image', src: '', alt: '', caption: '' };
    if (type === 'rule') return { type: 'rule' };
    return { type: type, text: '' };
  }

  function wireSection(el) {
    var si = +el.dataset.sec;
    var secs = sections();
    var sec = secs[si];
    if (!sec) return;
    var body = state.draft.body;

    $$('[data-sec-add]', el).forEach(function (b) {
      b.addEventListener('click', function () {
        // Новый блок встаёт в конец своего раздела, а не в конец статьи.
        body.splice(sec.to + 1, 0, newBlock(b.dataset.secAdd));
        state.dirty = true;
        renderBlocks();
        focusBlock(sec.to + 1);
      });
    });

    var up = $('[data-sec-up]', el);
    if (up) up.addEventListener('click', function () {
      var prev = secs[si - 1];
      var moved = body.splice(sec.from, sec.to - sec.from + 1);
      body.splice.apply(body, [prev.from, 0].concat(moved));
      state.dirty = true; renderBlocks();
    });

    var down = $('[data-sec-down]', el);
    if (down) down.addEventListener('click', function () {
      var next = secs[si + 1];
      var moved = body.splice(sec.from, sec.to - sec.from + 1);
      // После выреза следующий раздел сдвинулся влево ровно на длину вырезанного.
      var at = next.to - moved.length + 1;
      body.splice.apply(body, [at, 0].concat(moved));
      state.dirty = true; renderBlocks();
    });

    $('[data-sec-del]', el).addEventListener('click', function () {
      var count = sec.to - sec.from + 1;
      if (!confirm('Удалить раздел целиком? Внутри блоков: ' + count + '.')) return;
      body.splice(sec.from, count);
      state.dirty = true; renderBlocks();
    });
  }

  function focusBlock(index) {
    var el = $('.block[data-i="' + index + '"]');
    if (!el) return;
    var f = $('[data-text]', el) || $('[data-img-alt]', el);
    if (f) f.focus();
    el.scrollIntoView({ block: 'center' });
  }

  function blockHTML(b, i) {
    var value = b.type === 'list' ? (b.items || []).join('\n') : (b.text || '');
    var inner;
    if (b.type === 'rule') inner = '<div class="hint">Горизонтальный разделитель</div>';
    else if (b.type === 'image') {
      var src = mediaUrl(b.src);
      inner = '<div class="imgbox">'
        + (src ? '<img src="' + esc(src) + '" alt="" data-shot'
              + ' onerror="this.hidden=true;this.nextElementSibling.hidden=false">'
              + '<span class="imgwait" hidden>Файл загружен. На сайте появится после сборки, через минуту.</span>'
            : '<img alt="" style="background:#171717">')
        + '<div class="stack" style="gap:8px;flex:1 1 220px">'
        + '<input type="text" data-img-src placeholder="/uploads/файл-1600.webp" value="' + esc(b.src || '') + '">'
        + '<input type="text" data-img-alt placeholder="Alt-текст (обязателен)" value="' + esc(b.alt || '') + '">'
        + '<input type="text" data-img-cap placeholder="Подпись под фото" value="' + esc(b.caption || '') + '">'
        + '<button class="btn sm" data-img-upload>Загрузить файл</button></div></div>';
    } else {
      inner = '<textarea rows="' + (b.type === 'p' ? 4 : 2) + '" data-text placeholder="'
        + (b.type === 'list' ? 'По одному пункту в строке' : 'Текст блока') + '">' + esc(value) + '</textarea>';
    }
    return '<div class="block" data-role="' + b.type + '" data-i="' + i + '">'
      + '<div class="block-bar">'
      + ROLES.map(function (r) {
        return '<button class="rolebtn" data-role-set="' + r[0] + '" aria-pressed="' + (r[0] === b.type) + '">' + r[1] + '</button>';
      }).join('')
      + '<span class="spacer"><button class="rolebtn" data-up title="Выше">↑</button>'
      + '<button class="rolebtn" data-down title="Ниже">↓</button>'
      + '<button class="rolebtn" data-del style="color:#FF3B30">Убрать</button></span></div>'
      + inner + '</div>';
  }
  function wireBlock(el) {
    var i = +el.dataset.i, b = state.draft.body[i];
    $$('[data-role-set]', el).forEach(function (r) {
      r.addEventListener('click', function () {
        var to = r.dataset.roleSet, text = blockText(b);
        var nb = { type: to };
        if (to === 'list') nb.items = text.split('\n').map(function (t) { return t.trim(); }).filter(Boolean);
        else if (to === 'image') { nb.src = b.src || ''; nb.alt = b.alt || ''; nb.caption = b.caption || text; }
        else if (to !== 'rule') nb.text = text;
        state.draft.body[i] = nb; state.dirty = true; renderBlocks();
      });
    });
    var ta = $('[data-text]', el);
    if (ta) ta.addEventListener('input', function () {
      if (b.type === 'list') b.items = this.value.split('\n').map(function (t) { return t.trim(); }).filter(Boolean);
      else b.text = this.value;
      state.dirty = true; updateHints();
    });
    var src = $('[data-img-src]', el), alt = $('[data-img-alt]', el), cap = $('[data-img-cap]', el);
    if (src) src.addEventListener('input', function () { b.src = this.value.trim(); state.dirty = true; });
    if (alt) alt.addEventListener('input', function () { b.alt = this.value; state.dirty = true; });
    if (cap) cap.addEventListener('input', function () { b.caption = this.value; state.dirty = true; });
    var up = $('[data-img-upload]', el);
    if (up) up.addEventListener('click', function () { uploadInlineImage(i); });
    $('[data-up]', el).addEventListener('click', function () {
      if (i === 0) return;
      var body = state.draft.body;
      body.splice(i - 1, 0, body.splice(i, 1)[0]); state.dirty = true; renderBlocks();
    });
    $('[data-down]', el).addEventListener('click', function () {
      var body = state.draft.body;
      if (i >= body.length - 1) return;
      body.splice(i + 1, 0, body.splice(i, 1)[0]); state.dirty = true; renderBlocks();
    });
    $('[data-del]', el).addEventListener('click', function () {
      state.draft.body.splice(i, 1); state.dirty = true; renderBlocks();
    });
  }
  // «+ Новый раздел» — три блока сразу: заголовок, абзац и место под фото.
  $('#add-section').addEventListener('click', function () {
    var at = state.draft.body.length;
    state.draft.body.push(newBlock('h2'), newBlock('p'), newBlock('image'));
    state.dirty = true;
    renderBlocks();
    focusBlock(at);
  });

  $$('[data-add]').forEach(function (b) {
    b.addEventListener('click', function () {
      var at = state.draft.body.length;
      state.draft.body.push(newBlock(b.dataset.add));
      state.dirty = true;
      renderBlocks();
      focusBlock(at);
    });
  });

  function uploadInlineImage(index) {
    var input = document.createElement('input');
    input.type = 'file'; input.accept = OK_TYPES.join(',');
    input.addEventListener('change', function () {
      var f = this.files[0];
      if (!f) return;
      var dims = null;
      createImageBitmap(f).then(function (bmp) {
        // Картинки в тексте не кадрируем: форма кадра — решение автора.
        // Только уменьшаем, чтобы страница не тащила мегабайты.
        var max = 1600;
        var scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(bmp.width * scale));
        c.height = Math.max(1, Math.round(bmp.height * scale));
        c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
        dims = { w: c.width, h: c.height };
        return new Promise(function (res) { c.toBlob(res, 'image/webp', 0.85); });
      }).then(function (blob) {
        var name = (state.draft.slug || 'img') + '-' + Date.now() + '-1600.webp';
        toast('Загружаем изображение…');
        return blob.arrayBuffer().then(function (buf) {
          return commitFiles([{ path: contentPath('uploads/' + name), base64: b64bytes(buf) }],
            'Загрузка изображения: ' + name);
        }).then(function () {
          var path = '/uploads/' + name;
          state.localPreviews[path] = URL.createObjectURL(blob);
          state.draft.body[index].src = path;
          // Размеры уходят в статью: по ним вёрстка резервирует место под картинку,
          // и страница не прыгает во время загрузки.
          state.draft.body[index].w = dims.w;
          state.draft.body[index].h = dims.h;
          state.dirty = true; renderBlocks();
          toast('Изображение загружено. На сайте появится после сборки, примерно через минуту.');
        });
      }).catch(function (e) { toast(e.message || 'Не удалось загрузить изображение.', true); });
    });
    input.click();
  }

  /* ── Импорт готового текста ─────────────────────────────────────── */
  $('#toggle-import').addEventListener('click', function () {
    var p = $('#import-panel'); p.hidden = !p.hidden;
    this.classList.toggle('on', !p.hidden);
  });
  $('#do-parse').addEventListener('click', function () {
    var raw = $('#import-text').value;
    state.chunks = raw.split(/\n\s*\n/).map(function (t) { return t.trim(); }).filter(Boolean)
      .map(function (t) { return { text: t, role: 'p' }; });
    renderChunks();
  });
  $('#auto-roles').addEventListener('click', function () {
    if (!state.chunks.length) $('#do-parse').click();
    state.chunks.forEach(function (c, i) {
      var t = c.text, words = t.split(/\s+/).length;
      if (i === 0) c.role = 'title';
      else if (i === 1 && words <= 40) c.role = 'lead';
      else if (/^\s*[-•—]/m.test(t)) c.role = 'list';
      else if (/^[«"]/.test(t)) c.role = 'quote';
      else if (words <= 7 && !/[.!?…:;]$/.test(t)) c.role = 'h2';
      else c.role = 'p';
    });
    renderChunks();
  });
  var CHUNK_ROLES = [['title','Заголовок'],['lead','Лид'],['h2','H2'],['h3','H3'],['p','Абзац'],['quote','Цитата'],['list','Список']];
  function renderChunks() {
    var box = $('#chunks');
    box.innerHTML = state.chunks.map(function (c, i) {
      var style = c.role === 'title' ? 'font-weight:900;font-size:20px;text-transform:uppercase'
        : c.role === 'lead' ? 'font-weight:600;font-size:16px;color:#E8E8E8'
        : c.role === 'h2' ? 'font-weight:900;font-size:18px;text-transform:uppercase'
        : c.role === 'h3' ? 'font-weight:800;font-size:15px;text-transform:uppercase'
        : c.role === 'quote' ? 'font-style:italic;font-size:16px'
        : 'font-weight:500;font-size:14px;color:#9A9A9A';
      return '<div class="block" data-c="' + i + '"><div class="block-bar">'
        + CHUNK_ROLES.map(function (r) {
          return '<button class="rolebtn" data-crole="' + r[0] + '" aria-pressed="' + (r[0] === c.role) + '">' + r[1] + '</button>';
        }).join('')
        + '<span class="spacer"><button class="rolebtn" data-cdel style="color:#FF3B30">Убрать</button></span></div>'
        + '<div style="' + style + ';line-height:1.5;white-space:pre-wrap">' + esc(c.text) + '</div></div>';
    }).join('');
    $$('.block', box).forEach(function (el) {
      var i = +el.dataset.c;
      $$('[data-crole]', el).forEach(function (b) {
        b.addEventListener('click', function () { state.chunks[i].role = b.dataset.crole; renderChunks(); });
      });
      $('[data-cdel]', el).addEventListener('click', function () { state.chunks.splice(i, 1); renderChunks(); });
    });
    $('#chunks-actions').hidden = !state.chunks.length;
    $('#chunk-stats').textContent = 'Блоков: ' + state.chunks.length;
  }
  $('#apply-chunks').addEventListener('click', function () {
    var d = state.draft, body = [];
    state.chunks.forEach(function (c) {
      if (c.role === 'title') { d.title = c.text; if (!d.slug) d.slug = slugify(c.text); }
      else if (c.role === 'lead') { d.lead = c.text; if (!d.excerpt) d.excerpt = c.text.slice(0, 200); }
      else if (c.role === 'list') body.push({ type: 'list', items: c.text.split('\n').map(function (t) {
        return t.replace(/^\s*[-•—]\s*/, '').trim(); }).filter(Boolean) });
      else if (c.role === 'quote') body.push({ type: 'quote', text: c.text.replace(/^[«"]|[»"]$/g, '') });
      else body.push({ type: c.role, text: c.text });
    });
    if (body.length) d.body = body;
    if (!d.seoTitle) d.seoTitle = d.title;
    if (!d.seoDescription) d.seoDescription = (d.excerpt || d.lead || '').slice(0, 160);
    state.chunks = []; state.dirty = true;
    $('#import-panel').hidden = true; $('#toggle-import').classList.remove('on');
    fillEditor();
    toast('Статья собрана из блоков — проверьте роли и сохраните.');
  });

  /* ── Авто-статья ──────────────────────────────────────────────────
     Отдельный экран: сюда кладут текст целиком и пачку фотографий, отсюда
     выходит готовый черновик. Разбор — правила, а не магия: их видно в
     колонке «Что получится», и всё, что собралось, остаётся править руками. */

  var AUTO = { pics: [], cover: null, parsed: null };

  // Куски текста. Обычно абзацы разделены пустой строкой; если текст пришёл
  // из документа, где её нет, — разделителем становится обычный перенос.
  function autoChunks(raw) {
    var t = String(raw || '').replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').trim();
    if (!t) return [];
    var byBlank = t.split(/\n\s*\n/).map(function (x) { return x.trim(); }).filter(Boolean);
    if (byBlank.length >= 3) return byBlank;
    var byLine = t.split(/\n/).map(function (x) { return x.trim(); }).filter(Boolean);
    return byLine.length > byBlank.length ? byLine : byBlank;
  }

  // Заголовок главы: короткая строка, которая не заканчивается точкой.
  // Вопрос заголовком быть может («Кто писал песни Децла?»), перечисление — нет.
  function looksLikeHeading(t) {
    if (!t || t.indexOf('\n') >= 0) return false;
    if (t.length > 90) return false;
    if (t.split(/\s+/).length > 12) return false;
    if (/[,:;—–-]$/.test(t)) return false;
    if (/[.!…]$/.test(t)) return false;
    return true;
  }

  // Длинный абзац режем по границам предложений: на телефоне сплошной кусок
  // в тысячу знаков читается как стена.
  function splitLong(t, max, target) {
    max = max || 460; target = target || 330;
    if (t.length <= max) return [t];
    var sents = t.match(/[^.!?…]+[.!?…]+[»")\]]*\s*/g);
    if (!sents || sents.length < 2) return [t];
    var out = [], cur = '';
    sents.forEach(function (sn) {
      if (cur && (cur + sn).trim().length > target) { out.push(cur.trim()); cur = sn; }
      else cur += sn;
    });
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  // Заголовок из первой фразы главы — когда своих заголовков в тексте нет.
  function headingFrom(t) {
    // Берём начало первой фразы до первой паузы: целое предложение в заголовке
    // слово в слово повторяет абзац под ним и читается как ошибка.
    var s = (t.match(/^[^.!?…]+/) || [t])[0].trim();
    var cut = s.search(/[,;:—–(]/);
    if (cut > 14) s = s.slice(0, cut);
    s = s.trim().replace(/[\s,;:—–-]+$/, '');
    if (s.length > 48) { s = s.slice(0, 48); s = s.slice(0, s.lastIndexOf(' ')); }
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function autoParse(raw) {
    var chunks = autoChunks(raw), out = { title: '', lead: '', blocks: [], guessed: 0 };
    if (!chunks.length) return out;

    var i = 0;
    // Заголовок статьи — первая строка, если она похожа на заголовок.
    var first = chunks[0].replace(/^#{1,6}\s*/, '').trim();
    if (looksLikeHeading(first) || /^#{1,6}\s/.test(chunks[0])) { out.title = first; i = 1; }
    // Лид — следующий абзац, если он не слишком длинный.
    if (i < chunks.length && !looksLikeHeading(chunks[i]) && chunks[i].length <= 520
        && !/^\s*([-–—•*]|\d+[.)])\s/.test(chunks[i])) {
      out.lead = chunks[i]; i += 1;
    }

    for (; i < chunks.length; i++) {
      var c = chunks[i];
      if (/^#{1,6}\s/.test(c)) {
        out.blocks.push({ type: c.indexOf('###') === 0 ? 'h3' : 'h2', text: c.replace(/^#{1,6}\s*/, '').trim() });
        continue;
      }
      if (/^\s*>/.test(c)) { out.blocks.push({ type: 'quote', text: c.replace(/^\s*>\s?/gm, '').trim() }); continue; }
      var lines = c.split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
      var isList = lines.length > 1 && lines.every(function (l) { return /^([-–—•*]|\d+[.)])\s+/.test(l); });
      if (isList) {
        out.blocks.push({ type: 'list', items: lines.map(function (l) { return l.replace(/^([-–—•*]|\d+[.)])\s+/, ''); }) });
        continue;
      }
      if (looksLikeHeading(c)) { out.blocks.push({ type: 'h2', text: c }); continue; }
      if (/^[«"].{0,300}[»"]$/.test(c)) { out.blocks.push({ type: 'quote', text: c.replace(/^[«"]|[»"]$/g, '') }); continue; }
      splitLong(c).forEach(function (part) { out.blocks.push({ type: 'p', text: part }); });
    }

    // Если своих заголовков нет — расставляем сами, по три абзаца на главу,
    // и честно помечаем их: такие почти всегда хочется переписать.
    var hasH = out.blocks.some(function (b) { return b.type === 'h2'; });
    if (!hasH && out.blocks.filter(function (b) { return b.type === 'p'; }).length >= 4) {
      var withH = [], n = 0;
      out.blocks.forEach(function (b) {
        if (b.type === 'p' && n % 3 === 0) {
          withH.push({ type: 'h2', text: headingFrom(b.text), guess: true });
          out.guessed++;
        }
        if (b.type === 'p') n++;
        withH.push(b);
      });
      out.blocks = withH;
    }
    return out;
  }

  // Куда вставлять картинки: после абзацев, равномерно по всей статье.
  function imageSlots(blocks, n) {
    var pos = [];
    blocks.forEach(function (b, i) { if (b.type === 'p') pos.push(i + 1); });
    if (!n || !pos.length) return [];
    var picks = [];
    for (var k = 0; k < n; k++) {
      var idx = Math.round((k + 1) * pos.length / (n + 1)) - 1;
      if (idx < 0) idx = 0;
      if (idx > pos.length - 1) idx = pos.length - 1;
      while (picks.indexOf(pos[idx]) >= 0 && idx < pos.length - 1) idx++;
      picks.push(pos[idx]);
    }
    return picks;
  }

  function autoRefresh() {
    var parsed = autoParse($('#auto-text').value);
    AUTO.parsed = parsed;
    var titleField = $('#auto-title');
    if (parsed.title && (!titleField.value.trim() || titleField.dataset.auto === '1')) {
      titleField.value = parsed.title; titleField.dataset.auto = '1';
    }
    var slots = imageSlots(parsed.blocks, AUTO.pics.length);
    var box = $('#auto-outline');
    if (!parsed.blocks.length && !parsed.lead) {
      box.innerHTML = '<p class="hint">Вставьте текст — здесь появится разбор.</p>';
      return;
    }
    var heads = parsed.blocks.filter(function (b) { return b.type === 'h2' || b.type === 'h3'; }).length;
    var paras = parsed.blocks.filter(function (b) { return b.type === 'p'; }).length;
    var faqRaw = $('#auto-faq').value;
    var faq = parseFaq(faqRaw);
    var faqDropped = faqRaw.split(/\n\s*\n/).filter(function (c) { return c.trim(); }).length - faq.length;
    var rows = [];
    if (AUTO.cover) rows.push({ cls: 'cov', role: 'Обложка', txt: AUTO.cover.name });
    var yt = $('#auto-youtube').value.trim();
    if (yt) {
      rows.push({ cls: 'vid', role: 'Видео', txt: youtubeId(yt)
        ? 'проигрыватель встанет над текстом' : 'ссылка не распознана — проверьте её' });
    }
    if (parsed.lead) rows.push({ cls: '', role: 'Лид', txt: parsed.lead });
    parsed.blocks.forEach(function (b, i) {
      rows.push({
        cls: b.type === 'h2' || b.type === 'h3' ? 'h2' + (b.guess ? ' guess' : '') : '',
        role: b.type === 'h2' ? 'H2' : b.type === 'h3' ? 'H3' : b.type === 'list' ? 'Список'
          : b.type === 'quote' ? 'Цитата' : 'Абзац',
        txt: b.type === 'list' ? b.items.join(' · ') : b.text,
      });
      for (var m = 0; m < slots.filter(function (x) { return x === i + 1; }).length; m++) {
        rows.push({ cls: 'img', role: 'Фото', txt: 'здесь встанет картинка' });
      }
    });
    faq.forEach(function (f) { rows.push({ cls: 'faq', role: 'Вопрос', txt: f.q }); });
    box.innerHTML = '<p class="outline-sum">Глав: ' + heads + ' · абзацев: ' + paras
      + ' · картинок в тексте: ' + AUTO.pics.length + (AUTO.cover ? ' · обложка есть' : ' · обложки нет')
      + (faq.length ? ' · вопросов: ' + faq.length : '')
      + '</p>'
      + (parsed.guessed ? '<p class="hint warn" style="margin:-8px 0 12px">Заголовков в тексте не нашлось — '
        + parsed.guessed + ' придуманы автоматически, их точно стоит переписать.</p>' : '')
      + (faqDropped ? '<p class="hint warn" style="margin:-8px 0 12px">В «Частых вопросах» '
        + faqDropped + ' кусок без ответа — вопрос и ответ должны идти двумя строками подряд, '
        + 'пары разделяются пустой строкой. Такие куски в статью не попадут.</p>' : '')
      + '<ul class="outline">' + rows.map(function (r) {
        return '<li class="' + r.cls + '"><span class="role">' + r.role + '</span>'
          + '<span class="txt">' + esc(r.txt) + '</span></li>';
      }).join('') + '</ul>';
  }

  function renderPics() {
    var box = $('#auto-pics');
    box.innerHTML = AUTO.pics.map(function (pic, i) {
      return '<div class="pic" data-i="' + i + '">'
        + '<img class="pic-th" src="' + pic.url + '" alt="">'
        + '<div class="pic-body"><span class="pic-name">' + (i + 1) + '. ' + esc(pic.name) + '</span>'
        + '<input type="text" data-alt placeholder="Alt: что на фотографии" value="' + esc(pic.alt || '') + '"></div>'
        + '<div class="pic-act"><button data-up title="Выше">↑</button>'
        + '<button data-down title="Ниже">↓</button>'
        + '<button class="del" data-del title="Убрать">✕</button></div></div>';
    }).join('');
    $$('.pic', box).forEach(function (el) {
      var i = +el.dataset.i;
      $('[data-alt]', el).addEventListener('input', function () { AUTO.pics[i].alt = this.value; });
      $('[data-up]', el).addEventListener('click', function () {
        if (i > 0) { var t = AUTO.pics[i - 1]; AUTO.pics[i - 1] = AUTO.pics[i]; AUTO.pics[i] = t; renderPics(); autoRefresh(); }
      });
      $('[data-down]', el).addEventListener('click', function () {
        if (i < AUTO.pics.length - 1) { var t = AUTO.pics[i + 1]; AUTO.pics[i + 1] = AUTO.pics[i]; AUTO.pics[i] = t; renderPics(); autoRefresh(); }
      });
      $('[data-del]', el).addEventListener('click', function () {
        URL.revokeObjectURL(AUTO.pics[i].url); AUTO.pics.splice(i, 1); renderPics(); autoRefresh();
      });
    });
  }

  function addPics(files) {
    var list = Array.prototype.slice.call(files).filter(function (f) {
      if (OK_TYPES.indexOf(f.type) < 0) { toast('Пропущен ' + f.name + ': нужен PNG, JPEG, WebP или AVIF.', true); return false; }
      if (f.size > 15 * 1024 * 1024) { toast('Пропущен ' + f.name + ': больше 15 МБ.', true); return false; }
      return true;
    });
    list.forEach(function (f) {
      AUTO.pics.push({ file: f, name: f.name, alt: '', url: URL.createObjectURL(f) });
    });
    renderPics(); renderAutoCover(); autoRefresh();
  }

  // Уменьшение до 1600 px и WebP — как у картинок в редакторе: кадр не режем,
  // форму выбирает автор снимка.
  function prepImage(file) {
    return createImageBitmap(file).then(function (bmp) {
      var scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      var c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(bmp.width * scale));
      c.height = Math.max(1, Math.round(bmp.height * scale));
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      return new Promise(function (res) {
        c.toBlob(function (b) { res({ blob: b, w: c.width, h: c.height, bitmap: bmp }); }, 'image/webp', 0.85);
      });
    });
  }

  function autoBuild() {
    var parsed = autoParse($('#auto-text').value);
    var title = $('#auto-title').value.trim() || parsed.title;
    if (!title) return toast('Впишите заголовок статьи.', true);
    if (!parsed.blocks.some(function (b) { return b.type === 'p'; })) return toast('В тексте нет ни одного абзаца.', true);

    var slug = slugify(title);
    if (state.articles.some(function (a) { return a.data.slug === slug; })) {
      return toast('Статья с адресом /' + slug + '/ уже есть — измените заголовок.', true);
    }

    var coverPic = AUTO.cover;
    var inlinePics = AUTO.pics.slice();
    var btn = $('#auto-build');
    btn.disabled = true; btn.textContent = 'Собираем…';
    progress(8);

    Promise.all(inlinePics.map(function (pic) { return prepImage(pic.file); }))
      .then(function (prepped) {
        progress(40);
        if (!prepped.length) return [];
        var stamp = Date.now();
        var files = prepped.map(function (pr, i) {
          var name = slug + '-' + stamp + '-' + (i + 1) + '-1600.webp';
          pr.path = '/uploads/' + name;
          return pr.blob.arrayBuffer().then(function (buf) {
            return { path: contentPath('uploads/' + name), base64: b64bytes(buf) };
          });
        });
        return Promise.all(files).then(function (payload) {
          toast('Загружаем ' + payload.length + ' ' + (payload.length === 1 ? 'картинку' : 'картинок') + '…');
          // Один коммит на всю пачку: меньше перезапусков сборки сайта.
          return commitFiles(payload, 'Картинки к статье: ' + title).then(function () { return prepped; });
        });
      })
      .then(function (prepped) {
        progress(80);
        var d = emptyDraft();
        d.title = title;
        d.slug = slug;
        d.lead = parsed.lead || '';
        d.excerpt = (parsed.lead || (parsed.blocks.find(function (b) { return b.type === 'p'; }) || {}).text || '').slice(0, 200).trim();
        d.category = $('#auto-cat').value || d.category;
        d.youtubeUrl = $('#auto-youtube').value.trim();
        d.faq = parseFaq($('#auto-faq').value);
        d.seoTitle = title;
        d.seoDescription = d.excerpt.slice(0, 160);
        var blocks = parsed.blocks.map(function (b) {
          return b.type === 'list' ? { type: 'list', items: b.items.slice() } : { type: b.type, text: b.text };
        });
        var slots = imageSlots(blocks, prepped.length);
        // Вставляем с конца, чтобы ранее посчитанные позиции не съезжали.
        var pairs = prepped.map(function (pr, i) { return { at: slots[i], pr: pr, alt: (inlinePics[i] || {}).alt || '' }; })
          .sort(function (a, b) { return b.at - a.at; });
        pairs.forEach(function (pair) {
          state.localPreviews[pair.pr.path] = URL.createObjectURL(pair.pr.blob);
          blocks.splice(pair.at, 0, { type: 'image', src: pair.pr.path, alt: pair.alt, caption: '', w: pair.pr.w, h: pair.pr.h });
        });
        d.body = blocks.length ? blocks : [{ type: 'p', text: '' }];

        state.draft = d;
        state.editingPath = null; state.editingSha = null;
        state.originalSlug = null; state.originalStatus = null;
        state.pendingCover = null;
        state.chunks = [];
        state.dirty = true;
        var after = Promise.resolve();
        if (coverPic) {
          d.cover = { src: '', alt: $('#auto-cover-alt').value.trim(), focus: '50% 50%' };
          after = createImageBitmap(coverPic.file).then(function (bmp) {
            state.pendingCover = { bitmap: bmp, name: coverPic.name };
            return reprocessCover();
          });
        }
        return after.then(function () {
          fillEditor();
          route('editor');
          progress(0);
          btn.disabled = false; btn.textContent = 'Собрать статью';
          var msg = 'Собрано: ' + blocks.filter(function (b) { return b.type === 'h2'; }).length + ' глав, '
            + blocks.filter(function (b) { return b.type === 'p'; }).length + ' абзацев, '
            + prepped.length + ' картинок в тексте' + (coverPic ? ', обложка' : '')
            + (d.youtubeUrl ? ', видео' : '')
            + (d.faq.length ? ', вопросов: ' + d.faq.length : '') + '. Проверьте и сохраните.';
          toast(msg);
        });
      })
      .catch(function (e) {
        progress(0);
        btn.disabled = false; btn.textContent = 'Собрать статью';
        toast(e.message || 'Не удалось собрать статью.', true);
      });
  }

  function renderAuto() {
    var sel = $('#auto-cat');
    sel.innerHTML = (state.site.categories || []).filter(function (c) { return c.enabled !== false; })
      .map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.title) + '</option>'; }).join('');
    renderPics();
    renderAutoCover();
    autoRefresh();
  }

  $('#auto-text').addEventListener('input', autoRefresh);
  $('#auto-title').addEventListener('input', function () { this.dataset.auto = '0'; });
  function renderAutoCover() {
    var img = $('#auto-cover-img'), cap = $('#auto-cover-cap');
    if (AUTO.cover) {
      img.src = AUTO.cover.url; img.hidden = false;
      cap.textContent = '';
    } else {
      img.hidden = true; img.removeAttribute('src');
      cap.textContent = 'Перетащите обложку или нажмите — кадр 16:9 сделается сам';
    }
    $('#auto-cover-first').disabled = !AUTO.pics.length;
    $('#auto-cover-clear').disabled = !AUTO.cover;
  }
  function setAutoCover(file) {
    if (!file) return;
    if (OK_TYPES.indexOf(file.type) < 0) return toast('Нужен PNG, JPEG, WebP или AVIF.', true);
    if (file.size > 15 * 1024 * 1024) return toast('Файл больше 15 МБ — уменьшите его.', true);
    if (AUTO.cover) URL.revokeObjectURL(AUTO.cover.url);
    AUTO.cover = { file: file, name: file.name, url: URL.createObjectURL(file) };
    renderAutoCover(); autoRefresh();
  }
  $('#auto-cover-drop').addEventListener('click', function () { $('#auto-cover-file').click(); });
  $('#auto-cover-file').addEventListener('change', function () { setAutoCover(this.files[0]); this.value = ''; });
  ['dragenter', 'dragover'].forEach(function (ev) {
    $('#auto-cover-drop').addEventListener(ev, function (e) { e.preventDefault(); this.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    $('#auto-cover-drop').addEventListener(ev, function (e) { e.preventDefault(); this.classList.remove('over'); });
  });
  $('#auto-cover-drop').addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files) setAutoCover(e.dataTransfer.files[0]);
  });
  // Частый случай: первая фотография из пачки и есть обложка — забираем её
  // из списка целиком, чтобы в тексте она вторым экземпляром не повторялась.
  $('#auto-cover-first').addEventListener('click', function () {
    if (!AUTO.pics.length) return;
    var pic = AUTO.pics.shift();
    if (AUTO.cover) URL.revokeObjectURL(AUTO.cover.url);
    AUTO.cover = { file: pic.file, name: pic.name, url: pic.url };
    if (pic.alt && !$('#auto-cover-alt').value.trim()) $('#auto-cover-alt').value = pic.alt;
    renderPics(); renderAutoCover(); autoRefresh();
  });
  $('#auto-cover-clear').addEventListener('click', function () {
    if (AUTO.cover) URL.revokeObjectURL(AUTO.cover.url);
    AUTO.cover = null; $('#auto-cover-alt').value = '';
    renderAutoCover(); autoRefresh();
  });
  $('#auto-youtube').addEventListener('input', autoRefresh);
  $('#auto-faq').addEventListener('input', autoRefresh);
  $('#auto-build').addEventListener('click', autoBuild);
  $('#auto-reset').addEventListener('click', function () {
    if (!confirm('Очистить текст и картинки?')) return;
    AUTO.pics.forEach(function (p) { URL.revokeObjectURL(p.url); });
    AUTO.pics = [];
    if (AUTO.cover) URL.revokeObjectURL(AUTO.cover.url);
    AUTO.cover = null; $('#auto-cover-alt').value = '';
    renderAutoCover();
    $('#auto-text').value = ''; $('#auto-title').value = ''; $('#auto-title').dataset.auto = '1';
    $('#auto-youtube').value = ''; $('#auto-faq').value = '';
    renderPics(); autoRefresh();
  });
  $('#auto-drop').addEventListener('click', function () { $('#auto-files').click(); });
  $('#auto-files').addEventListener('change', function () { addPics(this.files); this.value = ''; });
  ['dragenter', 'dragover'].forEach(function (ev) {
    $('#auto-drop').addEventListener(ev, function (e) { e.preventDefault(); this.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    $('#auto-drop').addEventListener(ev, function (e) { e.preventDefault(); this.classList.remove('over'); });
  });
  $('#auto-drop').addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files) addPics(e.dataTransfer.files);
  });

  /* Пары «вопрос / ответ»: первая строка — вопрос, остальные — ответ,
     пары разделены пустой строкой. Один и тот же разбор в редакторе и на
     экране авто-статьи. */
  function parseFaq(v) {
    return String(v || '').split(/\n\s*\n/).map(function (chunk) {
      var lines = chunk.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
      return lines.length >= 2 ? { q: lines[0], a: lines.slice(1).join(' ') } : null;
    }).filter(Boolean);
  }

  /* ── Сохранение ─────────────────────────────────────────────────── */
  function validate(publishing) {
    var d = state.draft, errs = [];
    if (!d.title.trim()) errs.push('заголовок');
    if (!d.slug.trim()) errs.push('URL-slug');
    if (publishing) {
      if (!d.excerpt.trim()) errs.push('краткий анонс');
      if (!d.category) errs.push('категория');
      if (!d.publishedAt) errs.push('дата');
      if (!(d.body || []).some(function (b) { return blockText(b).trim(); })) errs.push('текст статьи');
      if (state.pendingCover ? !$('#f-cover-alt').value.trim() : (d.cover && d.cover.src && !d.cover.alt.trim())) errs.push('alt-текст обложки');
    }
    if (errs.length) { toast('Заполните: ' + errs.join(', ') + '.', true); return false; }
    var clash = state.articles.some(function (a) { return a.data.slug === d.slug && a.path !== state.editingPath; });
    if (clash) { toast('Статья с таким адресом уже есть.', true); return false; }
    return true;
  }

  function save(status) {
    if (!validate(status === 'published')) return Promise.resolve();
    var d = state.draft;
    d.status = status;
    d.updatedAt = new Date().toISOString().slice(0, 10);
    if (!d.seoTitle) d.seoTitle = d.title;
    if (!d.seoDescription) d.seoDescription = (d.excerpt || d.lead || '').slice(0, 160);
    d.cover = d.cover || { src: '', alt: '', focus: '50% 50%' };

    var files = [], deletions = [], msgs = [], newPath;
    progress(20);
    return Promise.resolve()
      .then(function () {
        if (!state.pendingCover || !state.pendingCover.variants) return;
        var stem = (d.slug || 'cover') + '-' + Date.now();
        return Promise.all(state.pendingCover.variants.map(function (v) {
          return v.blob.arrayBuffer().then(function (buf) {
            files.push({ path: contentPath('uploads/' + stem + '-' + v.w + '.webp'), base64: b64bytes(buf) });
          });
        })).then(function () {
          d.cover.src = '/uploads/' + stem + '-1600.webp';
          state.localPreviews[d.cover.src] = state.pendingCover.preview;
        });
      })
      .then(function () {
        newPath = contentPath('articles/' + d.slug + '.json');
        // Смена адреса: старый файл удаляем, а для опубликованной статьи ставим редирект.
        if (state.editingPath && state.editingPath !== newPath) {
          deletions.push(state.editingPath);
          if (state.originalStatus === 'published' && state.originalSlug) {
            state.site.redirects = state.site.redirects || {};
            state.site.redirects[state.originalSlug] = d.slug;
            files.push({ path: contentPath('site.json'), content: JSON.stringify(state.site, null, 2) + '\n' });
            msgs.push('редирект с /articles/' + state.originalSlug);
          }
        }
        files.push({ path: newPath, content: JSON.stringify(d, null, 2) + '\n' });
        progress(60);
        return commitFiles(files, (status === 'published' ? 'Публикация' : 'Черновик') + ': ' + d.title
          + (msgs.length ? ' (' + msgs.join(', ') + ')' : ''), deletions);
      })
      .then(function () {
        progress(90);
        state.pendingCover = null;
        // Путь известен из коммита: не полагаемся на то, что перечитанный список уже содержит файл.
        state.editingPath = newPath;
        state.originalSlug = d.slug;
        state.originalStatus = status;
        return loadAll();
      })
      .then(function () {
        var item = findArticle(d.slug);
        state.editingSha = item ? item.sha : null;
        state.dirty = false;
        progress(0);
        fillEditor();
        if (status === 'published') {
          // Ссылка с меткой времени: браузер держит HTML до десяти минут, и обычное
          // обновление подсовывает старую версию страницы. С меткой она всегда свежая.
          toast('Опубликовано. Сайт пересобирается, статья появится примерно через минуту.', false, {
            text: 'Открыть статью →',
            href: (CFG.siteUrl || '') + '/articles/' + d.slug + '/?v=' + Date.now(),
          });
        } else {
          toast('Черновик сохранён. На сайте он не появится.');
        }
      })
      .catch(function (e) { progress(0); toast(e.message, true); });
  }
  $('#save-draft').addEventListener('click', function () { save('draft'); });
  $('#publish').addEventListener('click', function () { save('published'); });

  /* ── Предпросмотр ───────────────────────────────────────────────── */
  $('#preview').addEventListener('click', function () {
    var w = window.open('', '_blank');
    if (!w) return toast('Браузер заблокировал окно предпросмотра.', true);
    var d = state.draft, css = new URL('../assets/site.css', location.href).href;
    var cover = state.pendingCover ? state.pendingCover.preview : mediaUrl(d.cover && d.cover.src);
    var id = youtubeId(d.youtubeUrl);
    var body = (d.body || []).map(function (b) {
      if (b.type === 'h2') return '<h2>' + esc(b.text) + '</h2>';
      if (b.type === 'h3') return '<h3>' + esc(b.text) + '</h3>';
      if (b.type === 'quote') return '<blockquote>' + esc(b.text) + '</blockquote>';
      if (b.type === 'rule') return '<hr>';
      if (b.type === 'list') return '<ul>' + (b.items || []).map(function (i) { return '<li>' + esc(i) + '</li>'; }).join('') + '</ul>';
      if (b.type === 'image') return '<figure><div class="fr">' + (b.src
        ? '<img src="' + esc(mediaUrl(b.src)) + '" alt="' + esc(b.alt || '') + '">' : '')
        + '</div>' + (b.caption ? '<figcaption>' + esc(b.caption) + '</figcaption>' : '') + '</figure>';
      return '<p>' + esc(b.text || '') + '</p>';
    }).join('');
    w.document.write('<!doctype html><html lang="ru"><head><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow">'
      + '<title>Предпросмотр: ' + esc(d.title) + '</title><link rel="stylesheet" href="' + esc(css) + '"></head><body>'
      + '<div style="background:#FF3B30;color:#fff;padding:10px 20px;font-weight:800;font-size:12px;letter-spacing:.12em;'
      + 'text-transform:uppercase">Предпросмотр — материал ещё не опубликован</div>'
      + '<main><article class="article"><span class="kicker">' + esc(catTitle(d.category)) + '</span>'
      + '<h1 class="h1-art">' + esc(d.title || 'Без заголовка') + '</h1>'
      + (d.lead ? '<p class="lead-art">' + esc(d.lead) + '</p>' : '')
      + '<div class="meta"><span class="who">' + esc(d.author) + '</span><span>' + esc(ruDate(d.publishedAt)) + '</span></div>'
      + (id ? '<div class="video"><div class="video-frame"><iframe src="https://www.youtube-nocookie.com/embed/'
          + esc(id) + '?rel=0" title="Видео" allowfullscreen></iframe></div></div>'
        : cover ? '<div class="hero"><div class="hero-cover"><img src="' + esc(cover) + '" alt="' + esc(d.cover.alt || '') + '"></div></div>' : '')
      + '<div class="body">' + body + '</div>'
      + ((d.sources || []).length ? '<section class="sources"><div class="eyebrow"><span class="sl">//</span><span>Источники</span></div><ul>'
        + d.sources.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul></section>' : '')
      + '</article></main></body></html>');
    w.document.close();
  });

  /* ── Удаление ───────────────────────────────────────────────────── */
  $('#delete-article').addEventListener('click', function () {
    if (!state.editingPath) return;
    var d = state.draft;
    var root = $('#modal-root');
    root.innerHTML = '<div class="modal"><div class="box"><h2>Удалить статью?</h2>'
      + '<p>«' + esc(d.title) + '» — действие необратимо. Опубликованный адрес отдаст 404, если не поставить редирект.</p>'
      + '<div class="row" style="margin-top:20px"><button class="btn" id="do-delete" '
      + 'style="background:#FF3B30;border-color:#FF3B30;color:#fff">Да, удалить</button>'
      + '<button class="btn" id="cancel-delete">Отмена</button></div></div></div>';
    $('#cancel-delete').addEventListener('click', function () { root.innerHTML = ''; });
    $('#do-delete').addEventListener('click', function () {
      root.innerHTML = '';
      progress(40);
      commitFiles([], 'Удаление статьи: ' + d.title, [state.editingPath])
        .then(loadAll)
        .then(function () { progress(0); state.dirty = false; toast('Статья удалена.'); route('list'); })
        .catch(function (e) { progress(0); toast(e.message, true); });
    });
  });

  /* ── Аналитика ────────────────────────────────────────────────────
     Цифры приходят из content/stats.json: его раз в шесть часов наполняет
     GitHub Actions, обращаясь к API Метрики с токеном из секретов репозитория.
     В браузере токена нет и быть не может — админка только читает готовый файл. */
  function fmt(n) {
    return typeof n === 'number' && isFinite(n)
      ? String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : '—';
  }
  function ago(iso) {
    var d = new Date(iso), mins = Math.round((Date.now() - d) / 60000);
    if (!isFinite(mins)) return iso;
    if (mins < 60) return mins + ' мин назад';
    if (mins < 60 * 24) return Math.round(mins / 60) + ' ч назад';
    return Math.round(mins / 1440) + ' дн назад';
  }
  function shortUrl(u) {
    try { return decodeURI(new URL(u).pathname) || '/'; } catch (e) { return u; }
  }

  function renderStats() {
    var box = $('#screen-stats');
    box.innerHTML = '<div class="eyebrow"><span class="sl">//</span><span>Загружаем данные…</span></div>'
      + '<h1>Аналитика.</h1>';
    gh(repoPath('/contents/' + contentPath('stats.json') + '?ref=' + (CFG.branch || 'main')
      + '&_=' + Date.now()), { raw: true, allow404: true })
      .then(function (text) { drawStats(text ? JSON.parse(text) : null); })
      .catch(function (e) { drawStats(null, e.message); });
  }

  function drawStats(d, err) {
    var box = $('#screen-stats');
    var counter = (state.site.analytics || {}).yandexMetrika;
    if (!d) {
      box.innerHTML = '<div class="eyebrow"><span class="sl">//</span><span>Данные ещё не забирались</span></div>'
        + '<h1>Аналитика.</h1>' + setupBlock(counter, err);
      return;
    }
    var byEvent = {};
    (d.goals || []).forEach(function (g) { byEvent[g.event || g.name] = g; });
    var tile = function (label, value, note) {
      return '<div class="tile"><div class="l">' + esc(label) + '</div><div class="v">' + value
        + '</div><div class="n">' + esc(note) + '</div></div>';
    };
    var t = d.totals || {};
    var goalTile = function (event, label) {
      var g = byEvent[event];
      var share = (g && t.visits) ? ' · ' + Math.round(g.reaches / t.visits * 100) + '% визитов' : '';
      return tile(label, g ? fmt(g.reaches) : '—', g ? 'цель ' + event + share : 'цель ' + event + ' не заведена');
    };

    box.innerHTML = '<div class="eyebrow"><span class="sl">//</span><span>Метрика · счётчик '
      + esc(d.counter) + ' · обновлено ' + esc(ago(d.updatedAt)) + '</span></div>'
      + '<h1>Аналитика.</h1>'
      + '<div class="tiles">'
      + tile('Визиты за ' + d.days + ' дней', fmt(t.visits), fmt(t.users) + ' посетителей')
      + goalTile('youtube_click', 'Переходы на YouTube')
      + goalTile('read_end', 'Дочитывания')
      + goalTile('telegram_click', 'Переходы в Telegram')
      + goalTile('video_play', 'Запуски видео')
      + '</div>'
      + '<div class="cols">'
      + '<div class="card"><h2 class="sec">Откуда приходят</h2>'
      + ((d.sources || []).length ? d.sources.map(function (s) {
          return '<div style="margin-bottom:12px"><div class="row" style="justify-content:space-between;font-size:14px;font-weight:700">'
            + '<span>' + esc(s.name) + '</span><span class="hint">' + fmt(s.visits) + ' · ' + s.share + '%</span></div>'
            + '<div class="bar"><i style="width:' + s.share + '%"></i></div></div>';
        }).join('') : '<p class="hint">Пока не из чего считать.</p>')
      + '</div>'
      + '<div class="card"><h2 class="sec">География</h2><div class="tbl">'
      + ((d.geo || []).length ? d.geo.map(function (g) {
          return '<div class="r"><span style="flex:1 1 auto;font-weight:600">' + esc(g.name)
            + '</span><span class="hint">' + fmt(g.visits) + '</span></div>';
        }).join('') : '<div class="r"><span class="hint">Пока пусто.</span></div>')
      + '</div></div></div>'
      + '<div class="card" style="margin-top:24px"><h2 class="sec">Статьи и переходы на YouTube</h2><div class="tbl">'
      + ((d.pages || []).length ? d.pages.map(function (p) {
          return '<div class="r">'
            + '<span style="flex:1 1 220px;min-width:0;font-weight:700;font-size:14px;color:#fff">' + esc(shortUrl(p.url)) + '</span>'
            + '<span class="hint" style="min-width:110px">' + fmt(p.visits) + ' визитов</span>'
            + '<span class="hint" style="min-width:120px">' + fmt((p.goals || {}).read_end) + ' дочитываний</span>'
            + '<span style="min-width:120px;font-weight:800;color:var(--accent)">' + fmt((p.goals || {}).youtube_click) + ' → YouTube</span>'
            + '</div>';
        }).join('') : '<div class="r"><span class="hint">Данных пока нет.</span></div>')
      + '</div></div>'
      + ((d.errors || []).length ? '<div class="note-danger" style="margin-top:24px">'
          + '<div class="h">Метрика ответила ошибкой</div><ul>'
          + d.errors.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul></div>' : '')
      + '<p class="hint" style="margin-top:16px">Данные обновляются каждые шесть часов. '
      + 'Полные отчёты — в кабинете Метрики: '
      + '<a href="https://metrika.yandex.ru/dashboard?id=' + esc(d.counter) + '" target="_blank" rel="noopener" '
      + 'style="color:var(--accent)">открыть</a>.</p>';
  }

  function setupBlock(counter, err) {
    return '<div class="note-danger" style="margin-top:26px">'
      + '<div class="h">Что нужно, чтобы цифры появились здесь</div><ul>'
      + '<li>Счётчик Метрики: ' + (counter
          ? '<b style="color:#CCFF04">подключён, номер ' + esc(counter) + '</b>'
          : 'не указан в <code>content/site.json</code> → <code>analytics</code>') + '.</li>'
      + '<li>Нужен OAuth-токен Яндекса с правом «получение статистики» — его кладут в секрет '
      + '<code>METRIKA_TOKEN</code> в настройках репозитория. Токен остаётся на стороне GitHub '
      + 'и в браузер не попадает.</li>'
      + '<li>После этого раз в шесть часов запускается сбор данных, и цифры появляются на этом экране. '
      + 'Первый раз можно запустить вручную: Actions → «Обновить статистику Метрики» → Run workflow.</li>'
      + (err ? '<li>Последняя ошибка чтения: ' + esc(err) + '</li>' : '')
      + '</ul></div>';
  }

  /* ── Старт ──────────────────────────────────────────────────────── */
  window.addEventListener('beforeunload', function (e) {
    if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
  });
  // Токен, сохранённый прошлой версией админки открытым текстом, удаляем:
  // теперь он должен жить только в зашифрованном сейфе.
  try {
    if (localStorage.getItem(OLD_TOKEN_KEY) || sessionStorage.getItem(OLD_TOKEN_KEY)) {
      localStorage.removeItem(OLD_TOKEN_KEY);
      sessionStorage.removeItem(OLD_TOKEN_KEY);
    }
  } catch (e) {}
  if (!window.crypto || !crypto.subtle) {
    showLogin('Браузер не поддерживает шифрование в этом окне. Откройте админку по https.');
  } else {
    showLogin('');
  }
})();
