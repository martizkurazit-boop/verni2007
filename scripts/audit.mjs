#!/usr/bin/env node
/**
 * Аудит собранного сайта. Проверки те же, что SEO-специалист делает руками
 * раз в месяц, — только выполняются при каждой сборке и занимают секунду.
 *
 *   node scripts/audit.mjs            — отчёт, выход всегда 0
 *   node scripts/audit.mjs --strict   — грубые ошибки роняют сборку
 *
 * Грубая ошибка — то, что ломает выдачу молча: нет canonical, нет или больше
 * одного H1, два материала с одинаковым заголовком. Остальное — предупреждения:
 * они не повод не публиковать статью, но копятся и тянут сайт вниз.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const STRICT = process.argv.includes('--strict');

if (!fs.existsSync(DIST)) {
  console.error('Нет каталога dist — сначала запустите сборку.');
  process.exit(1);
}

const errors = [];
const warns = [];
const err = (m) => errors.push(m);
const warn = (m) => warns.push(m);

/* ── Статьи из контента ──────────────────────────────────────────── */
const CONTENT = path.join(ROOT, 'content', 'articles');
const articles = fs.readdirSync(CONTENT)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(CONTENT, f), 'utf8')))
  .filter((a) => a.status === 'published');

/* ── Собранные страницы ──────────────────────────────────────────── */
const pages = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.name === 'index.html') pages.push(full);
  }
})(DIST);

const rel = (f) => '/' + path.relative(DIST, path.dirname(f)).replace(/\\/g, '/') + '/';
const artPages = pages.filter((f) => rel(f).startsWith('/articles/'));

/* ── 1. Техническая гигиена каждой страницы ──────────────────────── */
for (const f of artPages) {
  const html = fs.readFileSync(f, 'utf8');
  const where = rel(f);
  const h1 = (html.match(/<h1[\s>]/g) || []).length;
  if (h1 !== 1) err(`${where} — H1 должен быть один, найдено ${h1}`);
  if (!/rel="canonical"/.test(html)) err(`${where} — нет canonical`);

  const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
  if (!title) err(`${where} — пустой <title>`);
  else if (title.length > 65) warn(`${where} — <title> ${title.length} символов, обрежется в выдаче`);

  const desc = (html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || '';
  if (!desc) err(`${where} — нет описания`);
  else if (desc.length > 170) warn(`${where} — описание ${desc.length} символов, длинновато`);
  else if (desc.length < 70) warn(`${where} — описание ${desc.length} символов, коротковато`);

  if (!/og:image/.test(html)) warn(`${where} — нет картинки для соцсетей`);
  if (!/application\/ld\+json/.test(html)) warn(`${where} — нет микроразметки`);

  const noAlt = (html.match(/<img (?![^>]*\balt=)[^>]*>/g) || []).length;
  if (noAlt) warn(`${where} — картинок без alt: ${noAlt}`);
}

/* ── 2. Связность: кого не на что открыть ────────────────────────── */
const incoming = new Map(artPages.map((f) => [rel(f), 0]));
for (const f of pages) {
  const html = fs.readFileSync(f, 'utf8');
  const self = rel(f);
  for (const target of incoming.keys()) {
    if (target !== self && html.includes(`href="${target}"`)) {
      incoming.set(target, incoming.get(target) + 1);
    }
  }
}
const orphans = [...incoming.entries()].filter(([, n]) => n < 3).sort((a, b) => a[1] - b[1]);
orphans.forEach(([u, n]) => warn(`${u} — входящих ссылок всего ${n}, страница на задворках сайта`));

/* ── 3. Дубли и каннибализация ───────────────────────────────────── */
const norm = (t) => String(t).toLowerCase().replace(/[«»„“”:,.!?—–\-()]/g, ' ').replace(/\s+/g, ' ').trim();
const STOP = new Set(['и', 'в', 'на', 'с', 'по', 'из', 'за', 'от', 'до', 'как', 'что', 'почему',
  'кто', 'где', 'все', 'вse', 'это', 'его', 'её', 'их', 'для', 'не', 'а', 'о', 'об', 'у', 'к',
  'годов', 'года', 'год', 'стал', 'стала', 'были', 'был', 'была']);
const words = (t) => new Set(norm(t).split(' ').filter((w) => w.length > 3 && !STOP.has(w)));

const seen = new Map();
for (const a of articles) {
  const key = norm(a.title);
  if (seen.has(key)) err(`Одинаковый заголовок: /${a.slug}/ и /${seen.get(key)}/`);
  else seen.set(key, a.slug);
}
for (let i = 0; i < articles.length; i++) {
  for (let j = i + 1; j < articles.length; j++) {
    const A = words(articles[i].title), B = words(articles[j].title);
    if (A.size < 2 || B.size < 2) continue;
    const common = [...A].filter((w) => B.has(w));
    const share = common.length / Math.min(A.size, B.size);
    if (share >= 0.6) {
      warn(`Заголовки спорят за один запрос (${Math.round(share * 100)}% общих слов: ${common.join(', ')}):\n`
        + `      «${articles[i].title}»\n      «${articles[j].title}»`);
    }
  }
}

/* ── 4. Доверие к материалу ──────────────────────────────────────── */
const noSources = articles.filter((a) => !(a.sources || []).length);
if (noSources.length) warn(`Статей без источников: ${noSources.length} из ${articles.length}`);
const noFaq = articles.filter((a) => !(a.faq || []).length);
if (noFaq.length) warn(`Статей без коротких вопросов: ${noFaq.length}`);

/* ── 5. Что пора обновить ────────────────────────────────────────── */
const MONTHS = 4;
const edge = Date.now() - MONTHS * 30 * 86400000;
const stale = articles.filter((a) => Date.parse(a.updatedAt || a.publishedAt || '') < edge);
if (stale.length) {
  warn(`Не обновлялись дольше ${MONTHS} месяцев: ${stale.length} — `
    + stale.slice(0, 5).map((a) => a.slug).join(', ') + (stale.length > 5 ? '…' : ''));
}

/* ── Отчёт ───────────────────────────────────────────────────────── */
console.log(`\nАудит: страниц ${pages.length}, статей ${articles.length}`);
const least = orphans.length ? orphans[0][1] : Math.min(...incoming.values());
console.log(`Входящих ссылок: минимум ${Number.isFinite(least) ? least : '—'}, `
  + `медиана ${[...incoming.values()].sort((a, b) => a - b)[Math.floor(incoming.size / 2)]}`);

if (errors.length) {
  console.log(`\nОШИБКИ (${errors.length}):`);
  errors.forEach((m) => console.log('  ✗ ' + m));
}
if (warns.length) {
  console.log(`\nПредупреждения (${warns.length}):`);
  warns.forEach((m) => console.log('  • ' + m));
}
if (!errors.length && !warns.length) console.log('\nЗамечаний нет.');
console.log('');

if (STRICT && errors.length) {
  console.error('Аудит со --strict: есть грубые ошибки, сборка остановлена.');
  process.exit(1);
}
