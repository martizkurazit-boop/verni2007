#!/usr/bin/env node
/**
 * Генератор статического сайта «Верните мой 2007».
 * Каждая страница отдаётся готовым HTML — текст статьи присутствует в исходнике ответа.
 * Зависимостей нет: node scripts/build.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT = path.join(ROOT, 'content');
const PUBLIC = path.join(ROOT, 'public');
const DIST = path.join(ROOT, 'dist');

/* ── Конфигурация адреса ─────────────────────────────────────────── */
const site = JSON.parse(fs.readFileSync(path.join(CONTENT, 'site.json'), 'utf8'));
const RAW_URL = (process.env.SITE_URL || site.url || 'http://localhost:8000').replace(/\/+$/, '');
const U = new URL(RAW_URL);
// Настройки Pages отдают адрес по http, пока не включён Enforce HTTPS, а сайт всё равно
// будет жить на https. Канонический адрес обязан совпадать с реальным, поэтому схему
// поднимаем сами — кроме локальной сборки, где https неоткуда взять.
if (U.protocol === 'http:' && !/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(U.hostname)) {
  U.protocol = 'https:';
}
const BASE = U.pathname.replace(/\/+$/, '');          // '' или '/repo-name' для project pages
const ORIGIN = U.origin;
// Админка живёт по своему адресу: в меню сайта ссылки на неё нет.
const ADMIN = String(site.adminPath || 'admin').replace(/^\/+|\/+$/g, '');
const url = (p) => (BASE + (p.startsWith('/') ? p : '/' + p)) || '/';
// Временный адрес github.io закрывается от индексации целиком: иначе, когда появится
// собственный домен, тот же текст будет висеть в выдаче по двум адресам сразу.
// Снимается автоматически, как только SITE_URL станет доменом (или FORCE_INDEX=1).
const TEMP_HOST = /\.github\.io$/.test(U.hostname) && process.env.FORCE_INDEX !== '1';
const abs = (p) => ORIGIN + url(p);

/* Отпечаток содержимого: подставляется к статике как ?v=…
   Без него браузер может взять новый HTML и старый скрипт из кэша — страница
   ломается на ровном месте, и лечится только ручной очисткой кэша. */
const hashCache = new Map();
function ver(rel) {
  if (!hashCache.has(rel)) {
    const file = path.join(PUBLIC, rel.replace(/^\//, ''));
    let h = '0';
    try { h = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 10); } catch (e) {}
    hashCache.set(rel, h);
  }
  return url(rel) + '?v=' + hashCache.get(rel);
}

/* ── Утилиты ─────────────────────────────────────────────────────── */
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const attr = esc;

const TRANSLIT = {а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',
  о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya'};
function slugify(s) {
  return String(s).toLowerCase().split('').map((c) => TRANSLIT[c] ?? c).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'x';
}

const MONTHS = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
function ruDate(iso) {
  const d = new Date(iso + (iso.length === 10 ? 'T00:00:00Z' : ''));
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function blockText(b) {
  if (!b) return '';
  if (b.type === 'list') return (b.items || []).join(' ');
  return b.text || b.caption || '';
}
function plain(article) {
  return [article.lead, ...(article.body || []).map(blockText)].filter(Boolean).join(' ');
}
function readingMinutes(article) {
  const words = plain(article).split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 180));
}
function readingLabel(article) { return `${readingMinutes(article)} мин чтения`; }

/* Ссылка на YouTube с метками: без них переходы с сайта смешиваются в отчётах
   канала с прочими «внешними источниками», и понять отдачу невозможно. */
function ytLink(link, place) {
  if (!link) return '';
  try {
    const u = new URL(link);
    u.searchParams.set('utm_source', U.hostname);
    u.searchParams.set('utm_medium', 'site');
    u.searchParams.set('utm_campaign', place || 'link');
    return u.toString();
  } catch (e) { return link; }
}

function youtubeId(link) {
  if (!link) return '';
  const m = String(link).match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{6,})/);
  return m ? m[1] : '';
}

/* Автоматические ссылки на свои же материалы: если в тексте упомянут герой или
   предмет, о котором есть отдельная статья, первое упоминание становится ссылкой.
   Ровно одно на статью-цель — иначе текст превращается в решето из ссылок. */
function autoLink(html, article) {
  if (!article) return html;
  const targets = published
    .filter((x) => x.slug !== article.slug)
    // Кроме полного заголовка берём его начало до двоеточия: статьи называются
    // «Децл: как…», а в чужом тексте встречается просто «Децл».
    .flatMap((x) => {
      const short = String(x.title).split(/[:—–]/)[0].trim();
      return [x.title, short, ...(x.aliases || [])]
        .filter(Boolean)
        .filter((n, i, arr) => arr.indexOf(n) === i)
        .map((name) => ({ name, slug: x.slug }));
    })
    // Длинные названия проверяем первыми: «Виктор Цой» важнее, чем «Цой».
    .sort((a, b) => b.name.length - a.name.length)
    // Имя собственное и не короче четырёх букв — иначе в ссылки полезут предлоги.
    .filter((t) => t.name.length >= 4 && t.name[0] === t.name[0].toUpperCase());
  const used = article._autoLinked || (article._autoLinked = new Set());
  // Больше четырёх автоссылок на статью — уже решето, читать мешает.
  const LIMIT = 4;
  let out = html;
  for (const t of targets) {
    if (used.size >= LIMIT) break;
    if (used.has(t.slug)) continue;
    const safe = t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Мимо содержимого тегов и уже проставленных ссылок.
    // Регистр важен: «Кино» — группа, «кино» — просто кино. Без этого обычные
    // слова в тексте превращались в ссылки на статьи о героях.
    const re = new RegExp('(^|[^\\w<>/-])(' + safe + ')(?![\\w-])', 'u');
    const m = re.exec(out);
    if (!m) continue;
    if (/<a[^>]*>[^<]*$/.test(out.slice(0, m.index))) continue;
    // В начале предложения заглавная буква ничего не значит: «Кино просто
    // закрепило доверие» — это кино, а не группа. Такие совпадения пропускаем.
    const before = out.slice(0, m.index + m[1].length).replace(/<[^>]*>/g, '').trimEnd();
    if (!before || /[.!?…:»)]$/.test(before)) continue;
    used.add(t.slug);
    out = out.slice(0, m.index) + m[1]
      + `<a class="autolink" href="${url('/articles/' + t.slug + '/')}">${m[2]}</a>`
      + out.slice(m.index + m[0].length);
  }
  return out;
}

/* Инлайновая разметка внутри текста: **жирный**, [ссылка](url) */
function inline(text) {
  let out = esc(text);
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g,
    (_, t, href) => `<a href="${attr(href)}"${href.startsWith('http') ? ' target="_blank" rel="noopener"' : ''}>${t}</a>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return out;
}

/* ── Контент ─────────────────────────────────────────────────────── */
function loadArticles() {
  const dir = path.join(CONTENT, 'articles');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
    const a = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    a.slug = a.slug || f.replace(/\.json$/, '');
    a.body = Array.isArray(a.body) ? a.body : [];
    a.tags = Array.isArray(a.tags) ? a.tags : [];
    a.related = Array.isArray(a.related) ? a.related : [];
    a.sources = Array.isArray(a.sources) ? a.sources : [];
    a.faq = Array.isArray(a.faq) ? a.faq.filter((f) => f && f.q && f.a) : [];
    return a;
  }).sort((x, y) => String(y.publishedAt || '').localeCompare(String(x.publishedAt || '')));
}

/* Список выпусков канала — его наполняет отдельный workflow из публичной
   RSS-ленты YouTube. Нет файла — страницы видео просто не будет. */
let videoFeed = null;
try {
  videoFeed = JSON.parse(fs.readFileSync(path.join(CONTENT, 'videos.json'), 'utf8'));
  if (!videoFeed.videos || !videoFeed.videos.length) videoFeed = null;
} catch (e) { videoFeed = null; }

const allArticles = loadArticles();
const published = allArticles.filter((a) => a.status === 'published');
const catById = new Map((site.categories || []).map((c) => [c.id, c]));
const countIn = (id) => published.filter((a) => a.category === id).length;
const visibleCats = (site.categories || []).filter((c) => c.enabled !== false && countIn(c.id) > 0);
const catTitle = (id) => (catById.get(id) || {}).title || '';

/* Хаб показывается только тогда, когда в нём есть материалы: пустых разделов
   посетитель видеть не должен. */
function activeHubs() {
  return (site.hubs || []).filter((h) => {
    const wanted = (h.tags || []).map((t) => t.toLowerCase());
    return published.some((a) => a.tags.some((t) => wanted.includes(t.toLowerCase())));
  });
}

const tagIndex = new Map();
for (const a of published) {
  for (const t of a.tags) {
    const s = slugify(t);
    if (!tagIndex.has(s)) tagIndex.set(s, { slug: s, label: t, items: [] });
    tagIndex.get(s).items.push(a);
  }
}
const topTags = [...tagIndex.values()].sort((a, b) => b.items.length - a.items.length);

/* ── Обложки ─────────────────────────────────────────────────────── */
function coverData(a) {
  const c = a.cover || {};
  if (!c.src) return null;
  const src = c.src.startsWith('/') ? c.src : '/uploads/' + c.src;
  const variants = [1600, 1000, 600]
    .map((w) => ({ w, file: src.replace(/-(?:1600|1000|600)?(\.\w+)$/, `-${w}$1`) }))
    .filter((v) => fs.existsSync(path.join(CONTENT, v.file.replace(/^\/uploads\//, 'uploads/'))));
  const srcset = variants.length > 1 ? variants.map((v) => `${url(v.file)} ${v.w}w`).join(', ') : '';
  return { src: url(src), srcset, alt: c.alt || a.title, focus: c.focus || '50% 50%' };
}
function coverImg(a, sizes, eager) {
  const c = coverData(a);
  if (!c) return `<span class="ph">Обложка 16:9</span>`;
  return `<img src="${attr(c.src)}"${c.srcset ? ` srcset="${attr(c.srcset)}" sizes="${attr(sizes)}"` : ''}`
    + ` alt="${attr(c.alt)}" width="1600" height="900" style="object-position:${attr(c.focus)}"`
    + ` loading="${eager ? 'eager' : 'lazy'}" decoding="async">`;
}

/* ── Общая обвязка страницы ──────────────────────────────────────── */
function analyticsSnippet() {
  const ya = site.analytics && site.analytics.yandexMetrika;
  const ga = site.analytics && site.analytics.ga4;
  let out = '';
  if (ya) {
    // Официальный сниппет Метрики: маркер времени загрузки, защита от повторной вставки
    // и id счётчика в отдельной переменной — из неё цели берут номер после того,
    // как tag.js подменит функцию ym собой.
    out += `<script>window.__YM_ID=${JSON.stringify(String(ya))};`
      + `(function(m,e,t,r,i,k,a){m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};`
      + `m[i].l=1*new Date();`
      + `for(var j=0;j<e.scripts.length;j++){if(e.scripts[j].src===r){return}}`
      + `k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)})`
      + `(window,document,"script","https://mc.yandex.ru/metrika/tag.js?id=${attr(ya)}","ym");`
      + `ym(${JSON.stringify(String(ya))},"init",{ssr:true,clickmap:true,trackLinks:true,accurateTrackBounce:true,`
      + `webvisor:${site.analytics.webvisor ? 'true' : 'false'}});</script>`
      + `<noscript><div><img src="https://mc.yandex.ru/watch/${attr(ya)}" style="position:absolute;left:-9999px" alt=""></div></noscript>`;
  }
  if (ga) {
    out += `<script async src="https://www.googletagmanager.com/gtag/js?id=${attr(ga)}"></script>`
      + `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}`
      + `gtag('js',new Date());gtag('config',${JSON.stringify(ga)});</script>`;
  }
  return out;
}

function header(active) {
  const link = (href, title, id) =>
    `<a href="${attr(url(href))}"${active === id ? ' aria-current="page"' : ''}>${esc(title)}</a>`;
  return `<header class="hdr">
  <div class="hdr-in">
    <a class="mark" href="${attr(url('/'))}" aria-label="Верните мой 2007 — на главную"><b>Верните мой</b><i>2007</i></a>
    <nav class="nav-desk" aria-label="Разделы">
      ${visibleCats.map((c) => link('/category/' + c.id + '/', c.title, 'cat:' + c.id)).join('\n      ')}
      <a class="all" href="${attr(url('/all/'))}"${active === 'all' ? ' aria-current="page"' : ''}>Все статьи</a>
      ${videoFeed ? `<a class="all" href="${attr(url('/video/'))}"${active === 'video' ? ' aria-current="page"' : ''}>Видео</a>` : ''}
      ${activeHubs().map((h) => `<a class="all" href="${attr(url('/' + h.slug + '/'))}"${active === 'hub:' + h.slug ? ' aria-current="page"' : ''}>${esc(h.title)}</a>`).join('')}
    </nav>
    <div class="hdr-act">
      <button class="btn-ico" type="button" data-search-toggle aria-expanded="false" aria-controls="searchbar" aria-label="Поиск">⌕</button>
      ${site.youtubeChannel ? `<a class="btn-yt" href="${attr(ytLink(site.youtubeChannel, 'header'))}" target="_blank" rel="noopener"
        data-yt-header>▶ <span class="yt-our">Наш&nbsp;</span>YouTube<span class="yt-word">&nbsp;канал</span></a>` : ''}
    </div>
  </div>
  <nav class="nav-mob" aria-label="Разделы (мобильные)">
    <div class="nav-mob-in">
      <a href="${attr(url('/all/'))}"${active === 'all' ? ' aria-current="page"' : ''}>Все</a>
      ${videoFeed ? `<a href="${attr(url('/video/'))}"${active === 'video' ? ' aria-current="page"' : ''}>Видео</a>` : ''}
      ${activeHubs().map((h) => `<a href="${attr(url('/' + h.slug + '/'))}"${active === 'hub:' + h.slug ? ' aria-current="page"' : ''}>${esc(h.title)}</a>`).join('')}
      ${visibleCats.map((c) => link('/category/' + c.id + '/', c.title, 'cat:' + c.id)).join('\n      ')}
    </div>
  </nav>
</header>
<div class="searchbar" id="searchbar" hidden>
  <div class="searchbar-in">
    <form class="search-row" action="${attr(url('/search/'))}" method="get" role="search">
      <input type="search" name="q" placeholder="Герой, фильм, вещь, год…" aria-label="Поиск по сайту">
      <button type="button" data-search-toggle>Закрыть</button>
    </form>
    ${topTags.length ? `<div class="tagrow"><span class="lbl">Теги</span>${topTags.slice(0, 8)
      .map((t) => `<a class="chip" href="${attr(url('/tag/' + t.slug + '/'))}">${esc(t.label)}</a>`).join('')}</div>` : ''}
  </div>
</div>`;
}

function footer() {
  return `<footer class="ftr">
  <div class="ftr-in">
    <div>
      <div class="mark"><b>Верните мой</b><i>2007</i></div>
      <p>${esc(site.description)}</p>
    </div>
    <div class="ftr-cols">
      <div class="ftr-col"><span class="lbl">Разделы</span>
        ${visibleCats.map((c) => `<a href="${attr(url('/category/' + c.id + '/'))}">${esc(c.title)}</a>`).join('\n        ')}
      </div>
      <div class="ftr-col"><span class="lbl">Ещё</span>
        <a href="${attr(url('/all/'))}">Все статьи</a>
        ${videoFeed ? `<a href="${attr(url('/video/'))}">Видео</a>` : ''}
        ${activeHubs().map((h) => `<a href="${attr(url('/' + h.slug + '/'))}">${esc(h.title)}</a>`).join('\n        ')}
        <a href="${attr(url('/about/'))}">О проекте</a>
        <a href="${attr(url('/saved/'))}">Читать позже</a>
        <a href="${attr(url('/search/'))}">Поиск</a>
        ${site.youtubeChannel ? `<a href="${attr(ytLink(site.youtubeChannel, 'footer'))}" target="_blank" rel="noopener" data-yt-footer>Наш YouTube-канал →</a>` : ''}
      </div>
    </div>
  </div>
  <div class="ftr-bot"><div>${esc(site.footerNote || '')}</div></div>
</footer>`;
}

function layout({ title, description, canonical, body, active, jsonld = [], noindex = false, ogImage, ogType = 'website', extraHead = '' }) {
  if (TEMP_HOST) noindex = true;
  const img = ogImage || (site.defaultOgImage ? url(site.defaultOgImage) : '');
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${attr(description)}">
${noindex
  ? '<meta name="robots" content="noindex, follow">\n'
  : '<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1">\n'}<link rel="canonical" href="${attr(canonical)}">
<meta property="og:type" content="${attr(ogType)}">
<meta property="og:site_name" content="${attr(site.title)}">
<meta property="og:locale" content="ru_RU">
<meta property="og:title" content="${attr(title)}">
<meta property="og:description" content="${attr(description)}">
<meta property="og:url" content="${attr(canonical)}">
${img ? `<meta property="og:image" content="${attr(img.startsWith('http') ? img : ORIGIN + img)}">\n<meta property="og:image:width" content="1600">\n<meta property="og:image:height" content="900">\n` : ''}<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${attr(title)}">
<meta name="twitter:description" content="${attr(description)}">
${img ? `<meta name="twitter:image" content="${attr(img.startsWith('http') ? img : ORIGIN + img)}">\n` : ''}<meta name="theme-color" content="#0A0A0A">
${(site.verification && site.verification.yandex) ? `<meta name="yandex-verification" content="${attr(site.verification.yandex)}">\n` : ''}${(site.verification && site.verification.google) ? `<meta name="google-site-verification" content="${attr(site.verification.google)}">\n` : ''}
<link rel="icon" href="${attr(url('/favicon.svg'))}" type="image/svg+xml">
<link rel="apple-touch-icon" href="${attr(url('/apple-touch-icon.png'))}">
<link rel="alternate" type="application/rss+xml" title="${attr(site.title)}" href="${attr(url('/feed.xml'))}">
<link rel="preload" href="${attr(url('/fonts/gilroy-900.woff2'))}" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="${attr(url('/fonts/gilroy-500.woff2'))}" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${attr(ver('/assets/site.css'))}">
${jsonld.map((j) => `<script type="application/ld+json">${JSON.stringify(j).replace(/</g, '\\u003c')}</script>`).join('\n')}
${extraHead}${analyticsSnippet()}
</head>
<body>
<a class="skip" href="#main">К содержанию</a>
<div class="read-progress" data-progress hidden><i></i></div>
${header(active)}
${body}
${footer()}
<button class="to-top" type="button" data-to-top hidden aria-label="Наверх">↑</button>
<script src="${attr(ver('/assets/site.js'))}" defer></script>
</body>
</html>`;
}

/* ── Карточки ────────────────────────────────────────────────────── */
function card(a, i) {
  const href = url('/articles/' + a.slug + '/');
  return `<article class="card">
  <a class="cover" href="${attr(href)}" tabindex="-1" aria-hidden="true">
    ${coverImg(a, '(min-width:860px) 360px, 100vw', i < 2)}
    ${a.youtubeUrl ? '<span class="badge-video">▶ Есть видео</span>' : ''}
  </a>
  <div class="card-body">
    <div class="card-meta">
      <a class="kicker" href="${attr(url('/category/' + a.category + '/'))}">${esc(catTitle(a.category))}</a>
      <span class="readtime">${esc(readingLabel(a))}</span>
      <time class="readtime" datetime="${attr(a.publishedAt)}">${esc(ruDate(a.publishedAt))}</time>
    </div>
    <h2><a href="${attr(href)}">${esc(a.title)}</a></h2>
    <p>${esc(a.excerpt)}</p>
    <a class="read-more" href="${attr(href)}">Читать →</a>
  </div>
</article>`;
}

function relatedCard(a) {
  const href = url('/articles/' + a.slug + '/');
  return `<article>
  <a class="cover" href="${attr(href)}" tabindex="-1" aria-hidden="true">
    ${coverImg(a, '(min-width:860px) 260px, 100vw', false)}
    ${a.youtubeUrl ? '<span class="badge-video">▶ Видео</span>' : ''}
  </a>
  <div class="rc">
    <div class="card-meta">
      <a class="kicker" href="${attr(url('/category/' + a.category + '/'))}">${esc(catTitle(a.category))}</a>
      <span class="readtime">${esc(readingLabel(a))}</span>
    </div>
    <h3><a href="${attr(href)}">${esc(a.title)}</a></h3>
    <p>${esc(a.excerpt)}</p>
  </div>
</article>`;
}

function asideCard(a) {
  const href = url('/articles/' + a.slug + '/');
  return `<li class="ac">
  <a class="cover" href="${attr(href)}" tabindex="-1" aria-hidden="true">
    ${coverImg(a, '300px', false)}
    ${a.youtubeUrl ? '<span class="badge-video">▶ Видео</span>' : ''}
  </a>
  <div class="ac-body">
    <span class="kicker">${esc(catTitle(a.category))}</span>
    <h3><a href="${attr(href)}">${esc(a.title)}</a></h3>
    <span class="readtime">${esc(readingLabel(a))}</span>
  </div>
</li>`;
}

function nextCard(a) {
  const href = url('/articles/' + a.slug + '/');
  return `<a class="next-card" href="${attr(href)}">
  <span class="next-cover">${coverImg(a, '(min-width:760px) 320px, 100vw', false)}</span>
  <span class="next-body">
    <span class="lbl">Следующая статья</span>
    <span class="t">${esc(a.title)}</span>
    <span class="ex">${esc(a.excerpt)}</span>
    <span class="go">Читать дальше →</span>
  </span>
</a>`;
}

function videoCard(v, place) {
  const href = ytLink('https://www.youtube.com/watch?v=' + v.id, place);
  return `<article class="vcard">
  <a class="vcover" href="${attr(href)}" target="_blank" rel="noopener" data-yt-video>
    <img src="https://i.ytimg.com/vi/${attr(v.id)}/hqdefault.jpg" alt="Превью выпуска «${attr(v.title)}»"
         width="480" height="360" loading="lazy" decoding="async">
    <span class="vplay">▶</span>
  </a>
  <div class="vbody">
    ${v.published ? `<time class="readtime" datetime="${attr(v.published)}">${esc(ruDate(v.published.slice(0, 10)))}</time>` : ''}
    <h3><a href="${attr(href)}" target="_blank" rel="noopener" data-yt-video>${esc(v.title)}</a></h3>
  </div>
</article>`;
}

function latestVideosBlock() {
  if (!videoFeed) return '';
  return `<section class="more videos-strip">
  <div class="eyebrow"><span class="sl">//</span><span>Новые выпуски</span></div>
  <div class="grid vgrid">${videoFeed.videos.slice(0, 3).map((v) => videoCard(v, 'home-strip')).join('\n')}</div>
  <div class="back"><a class="btn-accent" href="${attr(url('/video/'))}">Все выпуски →</a>
    <a class="btn-more" href="${attr(ytLink(videoFeed.channelUrl, 'home-strip-channel'))}" target="_blank" rel="noopener" data-yt-video>Открыть канал</a></div>
</section>`;
}

/* ── Лента (главная, категория, тег, «все») ──────────────────────── */
/* Переключатели над лентой: вся лента или только материалы с выпуском.
   Показываются там, где это осмысленно — на главной, «Все статьи» и в самой ленте с видео. */
function feedFilters(active) {
  const spots = ['home', 'all', 'with-video'];
  if (!spots.includes(active) || !published.some((a) => youtubeId(a.youtubeUrl))) return '';
  const chip = (href, label, on) =>
    `<a class="feed-chip${on ? ' on' : ''}" href="${attr(url(href))}">${esc(label)}</a>`;
  return `<div class="feed-chips">${chip('/all/', 'Все материалы', active !== 'with-video')}`
    + `${chip('/with-video/', '▶ Только с видео', active === 'with-video')}</div>`;
}

function feedPage({ items, total, page, pages, basePath, eyebrow, h1, lead, title, description, canonicalPath, active, jsonld, noindex }) {
  const pageLink = (n) => url(n === 1 ? basePath : basePath + 'page/' + n + '/');
  const perPage = site.pageSize || 4;
  const shownTo = Math.min(page * perPage, total);
  const body = `<main id="main">
  <section class="head-sec">
    <div class="eyebrow"><span class="sl">//</span><span>${esc(eyebrow)}</span></div>
    <h1 class="h1-feed">${esc(h1)}</h1>
    ${lead ? `<p class="lead-feed">${esc(lead)}</p>` : ''}
    ${feedFilters(active)}
    <div class="rule-accent"></div>
  </section>
  <section class="feed">
    ${items.length ? `<div class="grid" data-feed>${items.map(card).join('\n')}</div>` : `<div class="empty">
      <p>Ничего не нашлось.</p>
      <p>Попробуй другое имя или сними фильтр.</p>
      <p style="margin-top:18px"><a class="btn-accent" href="${attr(url('/all/'))}">Все статьи</a></p>
    </div>`}
    ${pages > 1 ? `<div class="pager">
      ${page < pages ? `<a class="btn-more" data-more href="${attr(pageLink(page + 1))}">Показать ещё</a>` : ''}
      <nav class="pages" aria-label="Страницы ленты">
        ${Array.from({ length: pages }, (_, i) => i + 1).map((n) =>
          `<a href="${attr(pageLink(n))}"${n === page ? ' aria-current="page"' : ''}>${n}</a>`).join('\n        ')}
      </nav>
      <span class="page-status" data-status>Показано ${shownTo} из ${total} · страница ${page} из ${pages}</span>
    </div>` : ''}
  </section>
  ${active === 'home' && page === 1 ? latestVideosBlock() : ''}
</main>`;
  const seq = (page > 1 ? `<link rel="prev" href="${attr(ORIGIN + pageLink(page - 1))}">\n` : '')
    + (page < pages ? `<link rel="next" href="${attr(ORIGIN + pageLink(page + 1))}">\n` : '');
  return layout({ title, description, canonical: ORIGIN + canonicalPath, body, active, jsonld, noindex, extraHead: seq });
}
function writeFeed({ list, basePath, eyebrow, h1, lead, title, description, active, jsonldFor, noindex }) {
  const perPage = site.pageSize || 4;
  const pages = Math.max(1, Math.ceil(list.length / perPage));
  for (let p = 1; p <= pages; p++) {
    const items = list.slice((p - 1) * perPage, p * perPage);
    const rel = p === 1 ? basePath : basePath + 'page/' + p + '/';
    const html = feedPage({
      items, total: list.length, page: p, pages, basePath, eyebrow, h1, lead,
      title: p > 1 ? `${title} — страница ${p}` : title,
      description, canonicalPath: url(rel), active,
      jsonld: jsonldFor ? jsonldFor(items, p) : [], noindex,
    });
    write(rel + 'index.html', html);
  }
}

/* ── Статья ──────────────────────────────────────────────────────── */
function renderBody(a, inlineRel) {
  const out = [];
  let h2seen = 0, pending = false;
  const inlineBlock = inlineRel ? `<aside class="inline-rel">
  <span class="lbl">Читайте также</span>
  <a href="${attr(url('/articles/' + inlineRel.slug + '/'))}">${esc(inlineRel.title)}</a>
</aside>` : '';
  for (const b of a.body) {
    if (b.type === 'h2' && ++h2seen === 2) pending = true;
    else if (pending && inlineBlock) { pending = false; out.push(inlineBlock); }
    switch (b.type) {
      case 'h2': out.push(`<h2 id="${attr(b.anchor || slugify(b.text))}">${inline(b.text)}</h2>`); break;
      case 'h3': out.push(`<h3 id="${attr(b.anchor || slugify(b.text))}">${inline(b.text)}</h3>`); break;
      case 'quote': out.push(`<blockquote>${inline(b.text)}</blockquote>`); break;
      case 'list': out.push(`<ul>${(b.items || []).map((i) => `<li>${inline(i)}</li>`).join('')}</ul>`); break;
      case 'rule': out.push('<hr>'); break;
      case 'image': {
        const src = b.src ? (b.src.startsWith('/') ? url(b.src) : url('/uploads/' + b.src)) : '';
        const w = Number(b.w) || 0, h = Number(b.h) || 0;
        // Форму кадра задаёт сам снимок. Вертикальные и квадратные ограничиваем по
        // ширине и ставим по центру: иначе портрет занимает три экрана подряд.
        const shape = (w && h)
          ? (h > w * 1.05 ? ' fig-portrait' : (w > h * 1.05 ? ' fig-wide' : ' fig-square'))
          : '';
        out.push(`<figure class="fig${shape}">${src
          ? `<img src="${attr(src)}" alt="${attr(b.alt || b.caption || '')}"`
            + `${w && h ? ` width="${w}" height="${h}"` : ''} loading="lazy" decoding="async">`
          : `<div class="fr"><span class="ph">${esc(b.alt || 'Изображение')}</span></div>`}`
          + `${b.caption ? `<figcaption>${esc(b.caption)}</figcaption>` : ''}</figure>`);
        break;
      }
      default: out.push(`<p>${autoLink(inline(b.text || ''), a)}</p>`);
    }
  }
  return out.join('\n');
}

/* Очередь рекомендаций. Порядок: выбранные вручную в админке → та же категория →
   общие теги → всё остальное свежее. Текущая статья и черновики не попадают никогда.
   Ничего выбирать вручную не обязательно: список всегда заполняется сам. */
function pickRelated(a) {
  const pool = published.filter((x) => x.slug !== a.slug);
  const picked = [];
  const push = (x) => { if (x && !picked.some((p) => p.slug === x.slug)) picked.push(x); };
  a.related.forEach((slug) => push(pool.find((x) => x.slug === slug)));
  pool.filter((x) => x.category === a.category).forEach(push);
  pool.filter((x) => x.tags.some((t) => a.tags.includes(t))).forEach(push);
  pool.forEach(push);
  return picked;
}

/* Следующий материал для чтения: ближайший по времени в той же категории,
   иначе ближайший вообще, иначе самый свежий. */
function pickNext(a) {
  const older = published.filter((x) => x.slug !== a.slug
    && String(x.publishedAt || '') < String(a.publishedAt || ''));
  return older.find((x) => x.category === a.category)
    || older[0]
    || published.find((x) => x.slug !== a.slug)
    || null;
}

/* Путь к нарисованной карточке для соцсетей. Ставится в очередь только тем
   статьям, у которых нет своей обложки: у остальных в соцсети уходит обложка. */
function ogCardPath(a) {
  const rel = '/assets/og/' + a.slug + '.png';
  if (!ogQueue.some((x) => x.path === rel)) {
    ogQueue.push({ path: rel, title: a.title, category: catTitle(a.category) });
  }
  return rel;
}

function articlePage(a) {
  const cat = catById.get(a.category) || { id: a.category, title: '' };
  const canonicalPath = url('/articles/' + a.slug + '/');
  const canonical = ORIGIN + canonicalPath;
  const vid = youtubeId(a.youtubeUrl);
  const toc = a.body.filter((b) => b.type === 'h2').map((b) => ({ id: b.anchor || slugify(b.text), text: b.text }));
  const related = pickRelated(a);
  const next = pickNext(a);
  // Боковая колонка забирает самые близкие материалы, нижний блок — следующие.
  // Когда архив маленький и «следующих» не набирается, нижний блок берёт те же.
  const sideItems = related.slice(0, 5);
  const rest = related.slice(5, 11);
  const bottomItems = rest.length >= 3 ? rest : related.slice(0, 6);
  const cover = coverData(a);
  const desc = a.seoDescription || a.excerpt || a.lead || '';

  const jsonld = [
    {
      '@context': 'https://schema.org', '@type': 'Article',
      headline: a.title, description: desc,
      mainEntityOfPage: { '@type': 'WebPage', '@id': canonical },
      datePublished: a.publishedAt, dateModified: a.updatedAt || a.publishedAt,
      author: { '@type': 'Organization', name: a.author || site.author || site.title },
      publisher: {
        '@type': 'Organization', name: site.title,
        logo: { '@type': 'ImageObject', url: ORIGIN + url('/assets/logo-512.png'), width: 512, height: 512 },
      },
      inLanguage: 'ru-RU',
      ...(cover ? { image: [cover.src.startsWith('http') ? cover.src : ORIGIN + cover.src] } : {}),
      ...(a.tags.length ? { keywords: a.tags.join(', ') } : {}),
      articleSection: cat.title,
    },
    {
      '@context': 'https://schema.org', '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Главная', item: ORIGIN + url('/') },
        { '@type': 'ListItem', position: 2, name: cat.title, item: ORIGIN + url('/category/' + cat.id + '/') },
        { '@type': 'ListItem', position: 3, name: a.title, item: canonical },
      ],
    },
  ];
  // Вопросы и ответы: занимают больше места в выдаче и часто попадают в ответы
  // ИИ дословно. Размечаем только то, что действительно есть на странице.
  if (a.faq.length) {
    jsonld.push({
      '@context': 'https://schema.org', '@type': 'FAQPage',
      mainEntity: a.faq.map((f) => ({
        '@type': 'Question', name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    });
  }

  // VideoObject — только при полных достоверных данных о ролике.
  const v = a.video || {};
  if (vid && v.name && v.uploadDate && v.thumbnailUrl && v.duration) {
    jsonld.push({
      '@context': 'https://schema.org', '@type': 'VideoObject',
      name: v.name, description: v.description || desc, uploadDate: v.uploadDate,
      duration: v.duration, thumbnailUrl: v.thumbnailUrl,
      embedUrl: `https://www.youtube-nocookie.com/embed/${vid}`, contentUrl: a.youtubeUrl,
    });
  }

  const body = `<main id="main">
<div class="article-layout">
<div class="article-col">
<nav class="crumbs" aria-label="Хлебные крошки">
  <a href="${attr(url('/'))}">Главная</a><span>/</span>
  <a href="${attr(url('/category/' + cat.id + '/'))}">${esc(cat.title)}</a><span>/</span>
  <span class="cur">${esc(a.title)}</span>
</nav>
<article class="article">
  <a class="kicker" href="${attr(url('/category/' + cat.id + '/'))}">${esc(cat.title)}</a>
  <h1 class="h1-art">${esc(a.title)}</h1>
  ${a.lead ? `<p class="lead-art">${esc(a.lead)}</p>` : ''}
  <div class="meta">
    <span class="who">${esc(a.author || site.author || 'Редакция')}</span>
    <span><time datetime="${attr(a.publishedAt)}">${esc(ruDate(a.publishedAt))}</time></span>
    <span>${esc(readingLabel(a))}</span>
    ${a.updatedAt && a.updatedAt > a.publishedAt
      ? `<span class="upd">Обновлено <time datetime="${attr(a.updatedAt)}">${esc(ruDate(a.updatedAt))}</time></span>` : ''}
  </div>
  ${a.demo ? '<p class="demo-note">Демо-материал: образец вёрстки. Перед публикацией факты нужно проверить и переписать.</p>' : ''}
  ${vid ? `<div class="video" data-video data-id="${attr(vid)}">
    <button class="video-facade" type="button" data-play aria-label="Загрузить и проиграть видео">
      <img src="https://i.ytimg.com/vi/${attr(vid)}/maxresdefault.jpg" alt="Превью видео к статье «${attr(a.title)}»" width="1600" height="900" loading="lazy" decoding="async"
           onerror="this.src='https://i.ytimg.com/vi/${attr(vid)}/hqdefault.jpg'">
      <span class="play"><span>▶ Смотреть выпуск</span></span>
    </button>
    <div class="video-note">
      <span>Видео не запускается само — грузится по нажатию.</span>
      <a href="${attr(ytLink(a.youtubeUrl, 'article-top'))}" target="_blank" rel="noopener" data-yt-out>Смотреть на YouTube →</a>
    </div>
  </div>` : (cover ? `<div class="hero"><div class="hero-cover">
      <img src="${attr(cover.src)}"${cover.srcset ? ` srcset="${attr(cover.srcset)}" sizes="(min-width:800px) 760px, 100vw"` : ''} alt="${attr(cover.alt)}" width="1600" height="900" style="object-position:${attr(cover.focus)}" decoding="async">
    </div></div>` : '')}
  ${toc.length > 2 ? `<nav class="toc" data-toc aria-label="Содержание">
    <button type="button" data-toc-toggle aria-expanded="true" aria-controls="toc-list"><span>Содержание</span><span class="sign">−</span></button>
    <ol id="toc-list">${toc.map((t) => `<li><a href="#${attr(t.id)}">${esc(t.text)}</a></li>`).join('')}</ol>
  </nav>` : ''}
  <div class="body">${renderBody(a, sideItems[0] || null)}</div>
  ${a.faq.length ? `<section class="faq">
    <h2 id="voprosy">Частые вопросы</h2>
    ${a.faq.map((f) => `<details class="faq-item">
      <summary>${esc(f.q)}</summary>
      <div class="faq-a">${inline(f.a)}</div>
    </details>`).join('\n    ')}
  </section>` : ''}
  ${a.sources.length ? `<section class="sources">
    <div class="eyebrow"><span class="sl">//</span><span>Источники</span></div>
    <ul>${a.sources.map((s) => `<li>${inline(s)}</li>`).join('')}</ul>
  </section>` : ''}
  <div class="share" data-share data-title="${attr(a.title)}">
    <span class="share-l">Поделиться</span>
    <a class="chip" data-share-tg target="_blank" rel="noopener" href="https://t.me/share/url?url=${attr(encodeURIComponent(canonical))}&text=${attr(encodeURIComponent(a.title))}">Telegram</a>
    <a class="chip" data-share-vk target="_blank" rel="noopener" href="https://vk.com/share.php?url=${attr(encodeURIComponent(canonical))}">ВКонтакте</a>
    <button class="chip" type="button" data-share-copy>Скопировать ссылку</button>
    <button class="chip" type="button" data-save aria-pressed="false">Читать позже</button>
  </div>
  ${a.tags.length ? `<div class="tags">${a.tags.map((t) =>
    `<a href="${attr(url('/tag/' + slugify(t) + '/'))}">${esc(t)}</a>`).join('')}</div>` : ''}
</article>
${vid ? `<section class="watch-up">
  <div class="eyebrow"><span class="sl">//</span><span>Выпуск на канале</span></div>
  <a class="watch-card" href="${attr(ytLink(a.youtubeUrl, 'article-end'))}" target="_blank" rel="noopener" data-yt-end>
    <span class="watch-cover">
      <img src="https://i.ytimg.com/vi/${attr(vid)}/hqdefault.jpg" alt="Превью выпуска «${attr(a.title)}»"
           width="480" height="360" loading="lazy" decoding="async">
      <span class="watch-play">▶</span>
    </span>
    <span class="watch-body">
      <span class="t">Смотреть выпуск целиком</span>
      <span class="ex">Полная версия истории — на нашем YouTube-канале.</span>
      <span class="go">Открыть на YouTube →</span>
    </span>
  </a>
</section>` : ''}
${next ? `<section class="next-up">
  <div class="eyebrow"><span class="sl">//</span><span>Читать дальше</span></div>
  ${nextCard(next)}
</section>` : ''}
</div>
${sideItems.length ? `<aside class="rail" aria-label="Другие материалы">
  <div class="rail-inner">
    <div class="eyebrow"><span class="sl">//</span><span>Ещё по теме</span></div>
    <ul class="rail-list">${sideItems.map(asideCard).join('\n')}</ul>
    <a class="rail-all" href="${attr(url('/all/'))}">Все статьи →</a>
  </div>
</aside>` : ''}
</div>
${bottomItems.length ? `<section class="more">
  <div class="eyebrow"><span class="sl">//</span><span>Советуем почитать</span></div>
  <div class="grid">${bottomItems.map(relatedCard).join('\n')}</div>
  <div class="back">
    <a class="btn-accent" href="${attr(url('/'))}" data-back-to-feed>← Вернуться в ленту</a>
    <a class="btn-more" href="${attr(url('/all/'))}">Все статьи</a>
  </div>
</section>` : `<section class="more"><div class="back"><a class="btn-accent" href="${attr(url('/'))}" data-back-to-feed>← Вернуться в ленту</a></div></section>`}
</main>
${vid ? `<a class="yt-sticky" href="${attr(ytLink(a.youtubeUrl, 'article-sticky'))}" target="_blank" rel="noopener"
  data-yt-sticky hidden>▶ Смотреть выпуск<span class="yt-sticky-x" data-yt-sticky-close role="button" aria-label="Скрыть">✕</span></a>` : ''}`;

  return layout({
    title: a.seoTitle || `${a.title} — ${site.title}`,
    description: desc, canonical, body, active: 'cat:' + cat.id, jsonld, ogType: 'article',
    ogImage: a.ogImage
      ? (a.ogImage.startsWith('http') ? a.ogImage : url(a.ogImage))
      : (cover ? cover.src : url(ogCardPath(a))),
  });
}

/* ── Запись файлов ───────────────────────────────────────────────── */
function write(rel, content) {
  const p = path.join(DIST, rel.replace(/^\//, ''));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}
function copyDir(from, to) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name), d = path.join(to, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

/* ── Сборка ──────────────────────────────────────────────────────── */
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });
copyDir(PUBLIC, DIST);
if (ADMIN !== 'admin' && fs.existsSync(path.join(DIST, 'admin'))) {
  fs.renameSync(path.join(DIST, 'admin'), path.join(DIST, ADMIN));
}
copyDir(path.join(CONTENT, 'uploads'), path.join(DIST, 'uploads'));

const urls = [];   // для sitemap
const ogQueue = [];  // статьи, которым нужна нарисованная картинка для соцсетей
const addUrl = (loc, lastmod, priority, changefreq, images) =>
  urls.push({ loc: ORIGIN + loc, lastmod, priority, changefreq, images });

// Главная + /page/N
writeFeed({
  list: published, basePath: '/', eyebrow: 'Онлайн-энциклопедия',
  h1: site.title + '.', lead: site.lead || site.description,
  title: site.seoTitle || `${site.title} — энциклопедия 90-х и 2000-х`,
  description: site.description, active: 'home',
  jsonldFor: (items, p) => p === 1 ? [
    { '@context': 'https://schema.org', '@type': 'Organization', name: site.title,
      url: ORIGIN + url('/'), description: site.description,
      logo: { '@type': 'ImageObject', url: ORIGIN + url('/assets/logo-512.png'), width: 512, height: 512 },
      ...((site.social || []).length ? { sameAs: site.social } : {}) },
    { '@context': 'https://schema.org', '@type': 'WebSite', name: site.title, url: ORIGIN + url('/'),
      inLanguage: 'ru-RU', description: site.description,
      potentialAction: { '@type': 'SearchAction', target: { '@type': 'EntryPoint', urlTemplate: ORIGIN + url('/search/') + '?q={search_term_string}' }, 'query-input': 'required name=search_term_string' } },
    { '@context': 'https://schema.org', '@type': 'ItemList', itemListElement: items.map((a, i) => ({
      '@type': 'ListItem', position: i + 1, url: ORIGIN + url('/articles/' + a.slug + '/'), name: a.title })) },
  ] : [],
});
{
  const pages = Math.max(1, Math.ceil(published.length / (site.pageSize || 4)));
  addUrl(url('/'), published[0] && published[0].publishedAt, '1.0', 'daily');
  for (let p = 2; p <= pages; p++) addUrl(url('/page/' + p + '/'), undefined, '0.5', 'weekly');
}

// Материалы с видео — отдельная лента и точка входа для тех, кто пришёл смотреть
const withVideo = published.filter((a) => youtubeId(a.youtubeUrl));
if (withVideo.length) {
  writeFeed({
    list: withVideo, basePath: '/with-video/', eyebrow: 'С выпусками',
    h1: 'Статьи с видео.',
    lead: `Материалы, к которым есть выпуск на нашем YouTube-канале: ${withVideo.length} `
      + `${plural(withVideo.length, 'штука', 'штуки', 'штук')}.`,
    title: `Статьи с видео — ${site.title}`,
    description: `Материалы «${site.title}», к которым есть выпуск на YouTube-канале.`,
    active: 'with-video',
  });
  addUrl(url('/with-video/'), undefined, '0.7', 'weekly');
}

// Все статьи
writeFeed({
  list: published, basePath: '/all/', eyebrow: 'Все материалы', h1: 'Все статьи.',
  lead: `Полная лента: ${published.length} ${plural(published.length, 'материал', 'материала', 'материалов')} о девяностых и двухтысячных.`,
  title: `Все статьи — ${site.title}`,
  description: `Полный архив материалов «${site.title}»: музыка, кино, вещи, телевидение, игры и интернет 90-х и 2000-х.`,
  active: 'all',
});
addUrl(url('/all/'), undefined, '0.8', 'daily');

// Категории
for (const c of visibleCats) {
  const list = published.filter((a) => a.category === c.id);
  writeFeed({
    list, basePath: '/category/' + c.id + '/', eyebrow: 'Раздел', h1: c.title + '.',
    lead: c.description || '', active: 'cat:' + c.id,
    title: c.seoTitle || `${c.title} — ${site.title}`,
    description: c.seoDescription || c.description || `${c.title}: материалы «${site.title}» о культуре 90-х и 2000-х.`,
    jsonldFor: (items) => [{ '@context': 'https://schema.org', '@type': 'CollectionPage', name: c.title,
      description: c.description || '', url: ORIGIN + url('/category/' + c.id + '/'), inLanguage: 'ru-RU' }],
  });
  addUrl(url('/category/' + c.id + '/'), undefined, '0.8', 'weekly');
  const pages = Math.ceil(list.length / (site.pageSize || 4));
  for (let p = 2; p <= pages; p++) addUrl(url('/category/' + c.id + '/page/' + p + '/'), undefined, '0.4', 'weekly');
}

// Хабы по десятилетиям: под «девяностые» и «нулевые» ищут в разы чаще, чем по
// именам героев, — это точка входа, с которой человек расходится по статьям.
for (const hub of site.hubs || []) {
  const wanted = (hub.tags || []).map((t) => t.toLowerCase());
  const list = published.filter((a) => a.tags.some((t) => wanted.includes(t.toLowerCase())));
  if (!list.length) continue;
  writeFeed({
    list, basePath: '/' + hub.slug + '/', eyebrow: 'Эпоха', h1: hub.title + '.',
    lead: hub.description || '', active: 'hub:' + hub.slug,
    title: hub.seoTitle || `${hub.title} — ${site.title}`,
    description: hub.seoDescription || hub.description || '',
    jsonldFor: () => [{ '@context': 'https://schema.org', '@type': 'CollectionPage',
      name: hub.title, description: hub.description || '', url: ORIGIN + url('/' + hub.slug + '/'),
      inLanguage: 'ru-RU' }],
  });
  addUrl(url('/' + hub.slug + '/'), undefined, '0.8', 'weekly');
  const pages = Math.ceil(list.length / (site.pageSize || 4));
  for (let p = 2; p <= pages; p++) addUrl(url('/' + hub.slug + '/page/' + p + '/'), undefined, '0.4', 'weekly');
}

// Теги
for (const t of topTags) {
  writeFeed({
    list: t.items, basePath: '/tag/' + t.slug + '/', eyebrow: 'Тег', h1: t.label + '.',
    lead: `Материалы по теме «${t.label}».`, active: '',
    title: `${t.label} — ${site.title}`,
    description: `Все материалы «${site.title}» по теме «${t.label}».`,
  });
  addUrl(url('/tag/' + t.slug + '/'), undefined, '0.5', 'weekly');
}

// Статьи
for (const a of published) {
  write('/articles/' + a.slug + '/index.html', articlePage(a));
  // Картинки перечисляем в карте отдельно: поиск по картинкам для ностальгического
  // контента даёт заметный трафик, а сам он их находит хуже.
  const cover = coverData(a);
  const imgs = [];
  if (cover) imgs.push({ loc: ORIGIN + cover.src, caption: cover.alt });
  for (const b of a.body) {
    if (b.type === 'image' && b.src) {
      imgs.push({
        loc: ORIGIN + (b.src.startsWith('/') ? url(b.src) : url('/uploads/' + b.src)),
        caption: b.caption || b.alt || a.title,
      });
    }
  }
  addUrl(url('/articles/' + a.slug + '/'), a.updatedAt || a.publishedAt, '0.9', 'monthly', imgs);
}

// 301-редиректы со старых адресов (на статике — HTML-редирект с canonical)
for (const [from, to] of Object.entries(site.redirects || {})) {
  const target = url('/articles/' + to + '/');
  write('/articles/' + from + '/index.html', `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<title>Статья переехала</title><link rel="canonical" href="${attr(ORIGIN + target)}">
<meta name="robots" content="noindex, follow"><meta http-equiv="refresh" content="0; url=${attr(target)}">
</head><body><p>Материал переехал: <a href="${attr(target)}">${attr(ORIGIN + target)}</a></p>
<script>location.replace(${JSON.stringify(target)})</script></body></html>`);
}

// Поиск (клиентский, из индекса; из выдачи исключён)
write('/search/index.html', layout({
  title: `Поиск — ${site.title}`, description: 'Поиск по статьям, героям и темам.',
  canonical: ORIGIN + url('/search/'), noindex: true, active: '',
  body: `<main id="main">
  <section class="head-sec">
    <div class="eyebrow"><span class="sl">//</span><span>Результаты поиска</span></div>
    <h1 class="h1-feed" data-search-title>Поиск.</h1>
    <p class="lead-feed" data-search-lead>Введите имя героя, название фильма, вещи или год.</p>
    <div class="rule-accent"></div>
  </section>
  <section class="feed">
    <form class="search-row" style="max-width:720px;margin-bottom:28px" action="${attr(url('/search/'))}" method="get" role="search">
      <input type="search" name="q" placeholder="Герой, фильм, вещь, год…" aria-label="Поиск по сайту" data-search-input>
      <button type="submit" style="background:#CCFF04;border-color:#CCFF04">Найти</button>
    </form>
    <div class="grid" data-search-results></div>
    <div class="empty" data-search-empty hidden>
      <p>Ничего не нашлось.</p><p>Попробуй другое имя или сними фильтр.</p>
      <p style="margin-top:18px"><a class="btn-accent" href="${attr(url('/all/'))}">Все статьи</a></p>
    </div>
  </section>
</main>`,
}));

// Страница выпусков канала
if (videoFeed) {
  const vids = videoFeed.videos;
  write('/video/index.html', layout({
    title: `Видео — ${site.title}`,
    description: `Выпуски YouTube-канала «${site.title}»: истории о людях, вещах и явлениях 90-х и 2000-х.`,
    canonical: ORIGIN + url('/video/'), active: 'video',
    jsonld: [{
      '@context': 'https://schema.org', '@type': 'ItemList',
      itemListElement: vids.map((v, i) => ({
        '@type': 'ListItem', position: i + 1,
        item: {
          '@type': 'VideoObject', name: v.title,
          description: v.description || site.description,
          uploadDate: v.published,
          thumbnailUrl: [`https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`],
          embedUrl: `https://www.youtube-nocookie.com/embed/${v.id}`,
          contentUrl: `https://www.youtube.com/watch?v=${v.id}`,
        },
      })),
    }],
    body: `<main id="main">
  <section class="head-sec">
    <div class="eyebrow"><span class="sl">//</span><span>Выпуски канала</span></div>
    <h1 class="h1-feed">Видео.</h1>
    <p class="lead-feed">Те же истории, но в кадре. Последние выпуски канала — их ${vids.length}
      ${plural(vids.length, 'штука', 'штуки', 'штук')}; полный архив на YouTube.</p>
    <div class="feed-chips">
      <a class="feed-chip on" href="${attr(ytLink(videoFeed.channelUrl, 'video-page-top'))}"
         target="_blank" rel="noopener" data-yt-video>▶ Смотреть на канале</a>
      <a class="feed-chip" href="${attr(url('/with-video/'))}">Статьи с выпусками</a>
    </div>
    <div class="rule-accent"></div>
  </section>
  <section class="feed">
    <div class="grid vgrid">${vids.map((v) => videoCard(v, 'video-page')).join('\n')}</div>
    <div class="pager"><a class="btn-accent" href="${attr(ytLink(videoFeed.channelUrl, 'video-page-bottom'))}"
      target="_blank" rel="noopener" data-yt-video>Открыть канал на YouTube →</a>
      <span class="page-status">Список обновляется автоматически из ленты канала.</span></div>
  </section>
</main>`,
  }));
  addUrl(url('/video/'), (videoFeed.videos[0] || {}).published, '0.8', 'daily');
}

// О проекте: страница нужна и читателю, и поисковику — Google отдельно смотрит,
// понятно ли, кто пишет и почему ему верить.
if (site.about) {
  const ab = site.about;
  write('/about/index.html', layout({
    title: `${ab.title} — ${site.title}`,
    description: ab.lead || site.description,
    canonical: ORIGIN + url('/about/'), active: 'about',
    jsonld: [{
      '@context': 'https://schema.org', '@type': 'AboutPage',
      name: ab.title, description: ab.lead || site.description,
      url: ORIGIN + url('/about/'), inLanguage: 'ru-RU',
      mainEntity: {
        '@type': 'Organization', name: site.title, url: ORIGIN + url('/'),
        description: site.description,
        logo: { '@type': 'ImageObject', url: ORIGIN + url('/assets/logo-512.png') },
        ...((site.social || []).length ? { sameAs: site.social } : {}),
      },
    }],
    body: `<main id="main">
  <div class="article-layout"><div class="article-col">
  <nav class="crumbs" aria-label="Хлебные крошки">
    <a href="${attr(url('/'))}">Главная</a><span>/</span><span class="cur">${esc(ab.title)}</span>
  </nav>
  <article class="article">
    <h1 class="h1-art">${esc(ab.title)}</h1>
    ${ab.lead ? `<p class="lead-art">${esc(ab.lead)}</p>` : ''}
    <div class="body">
      ${(ab.body || []).map((t) => `<p>${inline(t)}</p>`).join('\n      ')}
      ${site.youtubeChannel ? `<h2 id="kanal">Наш YouTube-канал</h2>
      <p>Каждая большая тема выходит и текстом, и видео. Если больше нравится смотреть —
      <a href="${attr(ytLink(site.youtubeChannel, 'about'))}" target="_blank" rel="noopener" data-yt-about>откройте канал</a>.</p>` : ''}
      <h2 id="kontakty">Связаться</h2>
      <p>Нашли ошибку, хотите предложить тему или сотрудничество — пишите на
      <a href="mailto:${attr(site.email || 'martizkurazit@gmail.com')}">${esc(site.email || 'martizkurazit@gmail.com')}</a>.</p>
    </div>
  </article>
  </div></div>
</main>`,
  }));
  addUrl(url('/about/'), undefined, '0.5', 'monthly');
}

// «Читать позже»: список хранится в браузере, поэтому страница собирается на месте.
write('/saved/index.html', layout({
  title: `Читать позже — ${site.title}`,
  description: 'Материалы, отложенные вами на этом устройстве.',
  canonical: ORIGIN + url('/saved/'), noindex: true, active: '',
  body: `<main id="main">
  <section class="head-sec">
    <div class="eyebrow"><span class="sl">//</span><span>Ваш список</span></div>
    <h1 class="h1-feed">Читать позже.</h1>
    <p class="lead-feed">Материалы, которые вы отложили. Список хранится в этом браузере
      и никуда не отправляется — на другом устройстве он будет свой.</p>
    <div class="rule-accent"></div>
  </section>
  <section class="feed">
    <div class="grid" data-saved-list></div>
    <div class="empty" data-saved-empty hidden>
      <p>Пока пусто.</p>
      <p>Кнопка «Читать позже» есть под каждой статьёй — отложенное появится здесь.</p>
      <p style="margin-top:18px"><a class="btn-accent" href="${attr(url('/all/'))}">Все статьи</a></p>
    </div>
  </section>
</main>`,
}));

// 404
write('/404.html', layout({
  title: `Страница не найдена — ${site.title}`, description: 'Такой страницы нет.',
  canonical: ORIGIN + url('/404.html'), noindex: true, active: '',
  body: `<main id="main"><div class="center-box">
    <div class="eyebrow"><span class="sl">//</span><span>Ошибка 404</span></div>
    <h1>Такой страницы нет.</h1>
    <p>Адрес устарел или в нём опечатка. Загляните в ленту — там всё живое.</p>
    <p><a class="btn-accent" href="${attr(url('/'))}">← Вернуться в ленту</a></p>
  </div></main>`,
}));

// Индекс для поиска
write('/search-index.json', JSON.stringify(published.map((a) => ({
  slug: a.slug, title: a.title, excerpt: a.excerpt, category: catTitle(a.category), categoryId: a.category,
  tags: a.tags, read: readingLabel(a), video: !!a.youtubeUrl, date: a.publishedAt,
  cover: coverData(a) ? coverData(a).src : '', coverAlt: coverData(a) ? coverData(a).alt : '',
  href: url('/articles/' + a.slug + '/'),
}))));

// sitemap.xml
write('/sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${urls.map((u) => `  <url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${esc(u.lastmod)}</lastmod>` : ''}`
  + `${u.changefreq ? `<changefreq>${u.changefreq}</changefreq>` : ''}<priority>${u.priority}</priority>`
  + `${(u.images || []).map((im) => `\n    <image:image><image:loc>${esc(im.loc)}</image:loc>`
      + `${im.caption ? `<image:caption>${esc(im.caption)}</image:caption>` : ''}</image:image>`).join('')}`
  + `${(u.images || []).length ? '\n  ' : ''}</url>`).join('\n')}
</urlset>`);

// robots.txt
// Разрешаем всё и всем, а ботов ИИ-поисковиков и обучающие краулеры называем явно:
// часть из них ищет в файле собственное имя, и отдельная запись снимает вопросы.
// Это осознанное решение владельца: материалы сайта открыты для цитирования,
// поиска и обучения моделей — трафик из ChatGPT и подобных сервисов и есть цель.
const AI_AGENTS = [
  ['OAI-SearchBot', 'поиск ChatGPT'],
  ['ChatGPT-User', 'переходы по ссылкам из ChatGPT'],
  ['GPTBot', 'обучающий краулер OpenAI'],
  ['ClaudeBot', 'краулер Anthropic'],
  ['Claude-User', 'переходы по ссылкам из Claude'],
  ['Claude-SearchBot', 'поиск Claude'],
  ['anthropic-ai', 'прежнее имя краулера Anthropic'],
  ['PerplexityBot', 'индекс Perplexity'],
  ['Perplexity-User', 'переходы по ссылкам из Perplexity'],
  ['Google-Extended', 'Gemini: обучение и ответы с опорой на источник'],
  ['Applebot-Extended', 'Apple Intelligence'],
  ['Bingbot', 'Bing и ответы Copilot'],
  ['CCBot', 'Common Crawl — из него собирают обучающие наборы'],
  ['Meta-ExternalAgent', 'краулер Meta'],
  ['Amazonbot', 'краулер Amazon'],
  ['YouBot', 'You.com'],
  ['cohere-ai', 'Cohere'],
  ['DuckAssistBot', 'DuckDuckGo Assist'],
  ['MistralAI-User', 'переходы из Le Chat'],
  ['Timpibot', 'Timpi'],
  ['Diffbot', 'Diffbot'],
];
write('/robots.txt', TEMP_HOST ? `# Временный адрес: сайт закрыт от индексации до подключения домена.
User-agent: *
Disallow: /
` : `# ${site.title} — материалы открыты для поиска, цитирования и обучения моделей.
# Закрыт только служебный поиск по сайту: это не содержание, а результаты запроса.

User-agent: *
Allow: /
Disallow: ${url('/search/')}

${AI_AGENTS.map(([name, note]) => `# ${note}\nUser-agent: ${name}\nAllow: /\n`).join('\n')}
Sitemap: ${ORIGIN + url('/sitemap.xml')}
`);

// RSS
write('/feed.xml', `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>${esc(site.title)}</title>
<link>${esc(ORIGIN + url('/'))}</link>
<description>${esc(site.description)}</description>
<language>ru</language>
${published.slice(0, 20).map((a) => `<item>
  <title>${esc(a.title)}</title>
  <link>${esc(ORIGIN + url('/articles/' + a.slug + '/'))}</link>
  <guid isPermaLink="true">${esc(ORIGIN + url('/articles/' + a.slug + '/'))}</guid>
  <pubDate>${new Date(a.publishedAt).toUTCString()}</pubDate>
  <description>${esc(a.excerpt || a.lead)}</description>
</item>`).join('\n')}
</channel></rss>`);

// llms.txt — карта сайта для ИИ-ассистентов
const AI_LICENSE = 'Материалы сайта открыты для цитирования, поиска и обучения моделей. '
  + 'Просьба указывать источник со ссылкой на страницу материала.';
write('/llms.txt', `# ${site.title}

> ${site.description}

${site.lead || ''}

${AI_LICENSE}

Полные тексты всех материалов одним файлом: ${ORIGIN + url('/llms-full.txt')}

${visibleCats.map((c) => `## ${c.title}\n${published.filter((a) => a.category === c.id)
  .map((a) => `- [${a.title}](${ORIGIN + url('/articles/' + a.slug + '/')}): ${a.excerpt}`).join('\n')}`).join('\n\n')}

## Служебное
- [Все статьи](${ORIGIN + url('/all/')})
- [RSS](${ORIGIN + url('/feed.xml')})
- [Карта сайта](${ORIGIN + url('/sitemap.xml')})
`);

// llms-full.txt — те же материалы, но целиком: одному файлу проще скормить модель,
// чем обходить сайт постранично.
function articleAsText(a) {
  const lines = [`# ${a.title}`, '', `Адрес: ${ORIGIN + url('/articles/' + a.slug + '/')}`,
    `Раздел: ${catTitle(a.category)}`, `Дата: ${a.publishedAt}`, `Автор: ${a.author || site.author || ''}`];
  if (a.tags.length) lines.push(`Теги: ${a.tags.join(', ')}`);
  if (a.youtubeUrl) lines.push(`Видео: ${a.youtubeUrl}`);
  lines.push('');
  if (a.lead) lines.push(a.lead, '');
  for (const b of a.body) {
    if (b.type === 'h2') lines.push(`## ${b.text}`, '');
    else if (b.type === 'h3') lines.push(`### ${b.text}`, '');
    else if (b.type === 'quote') lines.push(`> ${b.text}`, '');
    else if (b.type === 'list') { (b.items || []).forEach((i) => lines.push(`- ${i}`)); lines.push(''); }
    else if (b.type === 'image') { if (b.caption || b.alt) lines.push(`[изображение: ${b.caption || b.alt}]`, ''); }
    else if (b.type === 'rule') lines.push('---', '');
    else if (b.text) lines.push(b.text, '');
  }
  if (a.faq.length) {
    lines.push('## Частые вопросы', '');
    a.faq.forEach((f) => lines.push(`**${f.q}**`, f.a, ''));
  }
  if (a.sources.length) lines.push('## Источники', ...a.sources.map((x) => `- ${x}`), '');
  return lines.join('\n');
}
write('/llms-full.txt', `# ${site.title}\n\n> ${site.description}\n\n${AI_LICENSE}\n\n`
  + `Материалов: ${published.length}. Обновлено: ${new Date().toISOString().slice(0, 10)}.\n\n`
  + published.map(articleAsText).join('\n\n---\n\n'));

// CNAME для GitHub Pages: пишется только когда сайт собирается под собственный домен.
if (!TEMP_HOST && U.hostname && !/\.github\.io$/.test(U.hostname) && U.hostname !== 'localhost') {
  write('/CNAME', U.hostname + '\n');
}

// Админка — статический файл, отпечатки её файлов проставляем в собранной копии.
// config.js генерируется этой же сборкой, поэтому его версия — время сборки.
{
  const indexPath = path.join(DIST, ADMIN, 'index.html');
  if (fs.existsSync(indexPath)) {
    const hashOf = (rel) => crypto.createHash('sha1')
      .update(fs.readFileSync(path.join(PUBLIC, rel))).digest('hex').slice(0, 10);
    const stamp = crypto.createHash('sha1').update(String(Date.now())).digest('hex').slice(0, 10);
    const html = fs.readFileSync(indexPath, 'utf8')
      .replace('href="admin.css"', `href="admin.css?v=${hashOf('admin/admin.css')}"`)
      .replace('src="admin.js"', `src="admin.js?v=${hashOf('admin/admin.js')}"`)
      .replace('src="config.js"', `src="config.js?v=${stamp}"`);
    fs.writeFileSync(indexPath, html);
  }
}

// Конфиг админки (репозиторий и ветка для GitHub API)
write('/' + ADMIN + '/config.js', `window.VM2007 = ${JSON.stringify({
  repo: process.env.CONTENT_REPO || site.repo || '',
  branch: process.env.CONTENT_BRANCH || site.branch || 'main',
  contentPath: process.env.CONTENT_PATH || site.contentPath || 'verni2007/content',
  siteUrl: ORIGIN + BASE,
  base: BASE,
}, null, 2)};
`);

if (ogQueue.length) {
  write('/og-manifest.json', JSON.stringify(ogQueue, null, 2));
  console.log(`Картинок для соцсетей в очереди: ${ogQueue.length} (рисует scripts/og-images.py)`);
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

console.log(`Собрано: ${published.length} опубликованных статей, ${allArticles.length - published.length} черновиков, `
  + `${visibleCats.length} разделов, ${topTags.length} тегов → ${path.relative(process.cwd(), DIST)}`);
console.log(`Адрес сборки: ${ORIGIN + BASE || '/'}`);
if (TEMP_HOST) {
  console.log('ВНИМАНИЕ: временный адрес github.io — все страницы отдаются с noindex, robots.txt закрыт.');
  console.log('Индексация включится сама, когда SITE_URL станет собственным доменом.');
}
