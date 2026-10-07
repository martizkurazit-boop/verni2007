#!/usr/bin/env node
/**
 * Проверка внешних ссылок: живы ли источники, на которые ссылаются статьи.
 *
 * Отдельный скрипт, а не часть аудита, по простой причине: аудит обязан
 * работать без сети и за секунду, а эта проверка ходит в интернет и зависит
 * от чужих серверов. Ломать из-за недоступной Википедии публикацию статьи
 * было бы глупо, поэтому выход всегда 0 — скрипт только докладывает.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT = path.join(ROOT, 'content', 'articles');
const UA = 'Mozilla/5.0 (compatible; vernitemoy2007-linkcheck/1.0; +https://vernitemoy2007.ru/)';

/* Скобки в адресе — обычное дело: «Бригада_(телесериал)», «TODD_(альбом)».
   Наивное [^\s)]+ обрезает такой адрес на первой скобке, и живая ссылка
   выглядит битой. Разрешаем парные скобки внутри — так же, как это делает
   разбор ссылок в сборке. */
const URL_IN_TEXT = /\[([^\]]+)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))*)\)/g;

/* Если адрес Википедии не открылся, скорее всего мы просто не угадали точное
   название статьи. Спрашиваем у поиска самой Википедии, как она называется. */
async function suggestWiki(url) {
  const m = String(url).match(/^https:\/\/(ru|en)\.wikipedia\.org\/wiki\/(.+)$/);
  if (!m) return '';
  const [, lang, raw] = m;
  const title = decodeURIComponent(raw).replace(/_/g, ' ');
  try {
    const api = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search`
      + `&srsearch=${encodeURIComponent(title)}&srlimit=1&format=json`;
    const res = await fetch(api, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return '';
    const data = await res.json();
    const hit = ((data.query || {}).search || [])[0];
    if (!hit) return '';
    return `https://${lang}.wikipedia.org/wiki/${hit.title.replace(/ /g, '_')}`;
  } catch (e) { return ''; }
}

const found = [];
for (const f of fs.readdirSync(CONTENT).filter((x) => x.endsWith('.json'))) {
  const a = JSON.parse(fs.readFileSync(path.join(CONTENT, f), 'utf8'));
  if (a.status !== 'published') continue;
  const texts = [...(a.sources || []), ...(a.body || []).map((b) => b.text || '')];
  for (const t of texts) {
    for (const m of String(t).matchAll(URL_IN_TEXT)) {
      found.push({ slug: a.slug, label: m[1], url: m[2] });
    }
  }
}

// Один и тот же адрес у нескольких статей проверяем один раз.
const byUrl = new Map();
found.forEach((x) => {
  if (!byUrl.has(x.url)) byUrl.set(x.url, []);
  byUrl.get(x.url).push(x.slug);
});

console.log(`Ссылок в источниках и текстах: ${found.length}, уникальных адресов: ${byUrl.size}\n`);

async function check(url) {
  // Кириллица в адресе требует процентного кодирования, но часть ссылок
  // записана в закодированном виде изначально. Кодировать их второй раз
  // нельзя: encodeURI превращает «%» в «%25», и живая страница становится
  // несуществующей. Сначала раскодируем, потом кодируем — операция
  // идемпотентная; если адрес раскодировать нельзя, берём как есть.
  let safe;
  try { safe = encodeURI(decodeURI(url)); } catch (e) { safe = url; }
  for (const method of ['HEAD', 'GET']) {
    try {
      const res = await fetch(safe, {
        method, redirect: 'follow',
        headers: { 'user-agent': UA, 'accept-language': 'ru,en' },
        signal: AbortSignal.timeout(15000),
      });
      // Часть сайтов на HEAD отвечает 403/405 — тогда пробуем обычный запрос.
      if (res.status === 405 || res.status === 403) continue;
      return { status: res.status, finalUrl: res.url };
    } catch (e) {
      if (method === 'GET') return { status: 0, error: e.message };
    }
  }
  return { status: 0, error: 'нет ответа' };
}

const results = [];
const urls = [...byUrl.keys()];
// По пять за раз: Википедии незачем видеть от нас шквал запросов.
for (let i = 0; i < urls.length; i += 5) {
  const chunk = urls.slice(i, i + 5);
  const part = await Promise.all(chunk.map(async (u) => ({ url: u, ...(await check(u)) })));
  results.push(...part);
}

const dead = results.filter((r) => r.status === 0 || r.status >= 400);
const ok = results.filter((r) => r.status >= 200 && r.status < 400);

console.log(`Живых: ${ok.length}, битых: ${dead.length}\n`);
if (dead.length) {
  console.log('БИТЫЕ ССЫЛКИ — их нужно заменить:');
  for (const r of dead) {
    console.log(`  ✗ ${r.status || 'нет ответа'}  ${r.url}`);
    console.log(`      в статьях: ${byUrl.get(r.url).join(', ')}`);
    if (r.error) console.log(`      ${r.error}`);
    const hint = await suggestWiki(r.url);
    if (hint) console.log(`      похоже, нужно: ${decodeURI(hint)}`);
  }
  console.log('');
}
// Перенаправления показываем отдельно: ссылка работает, но лучше вести сразу
// на конечный адрес — лишний переход теряет часть веса и время читателя.
const moved = ok.filter((r) => r.finalUrl && decodeURI(r.finalUrl) !== decodeURI(r.url));
if (moved.length) {
  console.log('ПЕРЕНАПРАВЛЕНИЯ — работают, но стоит поправить адрес:');
  moved.forEach((r) => console.log(`  → ${r.url}\n      ведёт на ${decodeURI(r.finalUrl)}`));
}
if (!dead.length && !moved.length) console.log('Все ссылки живые и ведут напрямую.');
