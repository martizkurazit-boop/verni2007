#!/usr/bin/env node
/**
 * IndexNow: сообщает поисковикам об изменившихся страницах сразу после выкладки.
 * Яндекс и Bing забирают такие страницы за минуты вместо ожидания обхода.
 * Google протокол не поддерживает — он приходит по карте сайта.
 *
 * Запускается из workflow после сборки. Список берётся из изменившихся файлов
 * последнего коммита: опубликовали статью — уйдёт её адрес и главная, а не весь сайт.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'site.json'), 'utf8'));
const RAW = (process.env.SITE_URL || site.url || '').replace(/\/+$/, '');
const key = site.indexNowKey;

if (!RAW || !key) { console.log('IndexNow: не задан адрес сайта или ключ — пропускаем.'); process.exit(0); }
const U = new URL(RAW);
if (U.protocol === 'http:') U.protocol = 'https:';
if (/\.github\.io$/.test(U.hostname)) {
  console.log('IndexNow: временный адрес github.io — поисковикам сообщать нечего.');
  process.exit(0);
}
const base = U.origin + U.pathname.replace(/\/+$/, '');

let changed = [];
try {
  changed = execSync('git diff --name-only HEAD^ HEAD', { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map((l) => l.trim()).filter(Boolean);
} catch (e) {
  console.log('IndexNow: не удалось получить список изменений (' + e.message.split('\n')[0] + ') — отправим только главную.');
}

const urls = new Set([base + '/']);
const published = new Set(
  fs.readdirSync(path.join(ROOT, 'content', 'articles')).filter((f) => f.endsWith('.json'))
    .filter((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'articles', f), 'utf8')).status === 'published'; }
      catch (e) { return false; }
    })
    .map((f) => f.replace(/\.json$/, ''))
);
for (const f of changed) {
  const m = f.match(/^content\/articles\/(.+)\.json$/);
  // Снятая с публикации статья отдаёт 404 — её адрес тоже полезно отправить,
  // чтобы поисковик выкинул страницу из индекса быстрее.
  if (m) urls.add(base + '/articles/' + m[1] + '/');
  if (f === 'content/site.json') urls.add(base + '/all/');
}
if (changed.some((f) => f.startsWith('content/articles/'))) {
  for (const slug of published) urls.add(base + '/articles/' + slug + '/');
}

const urlList = [...urls].slice(0, 10000);
console.log('IndexNow: отправляем ' + urlList.length + ' адрес(ов):');
urlList.forEach((u) => console.log('  ' + u));

const body = JSON.stringify({ host: U.hostname, key, keyLocation: base + '/' + key + '.txt', urlList });
const res = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body,
}).catch((e) => ({ ok: false, status: 0, statusText: e.message }));

console.log('IndexNow: ответ ' + res.status + ' ' + (res.statusText || ''));
// Ошибка уведомления не должна ронять выкладку: сайт уже опубликован.
if (!res.ok) console.log('IndexNow: страницы попадут в индекс обычным обходом.');
