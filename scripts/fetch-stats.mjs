#!/usr/bin/env node
/**
 * Забирает статистику из Яндекс.Метрики и кладёт её в content/stats.json,
 * откуда её читает админка.
 *
 * Запускается только в GitHub Actions: токен лежит в секретах репозитория —
 * это и есть та «серверная сторона», которой нет у статического хостинга.
 * В браузер токен не попадает никогда.
 *
 * Требуется переменная окружения METRIKA_TOKEN (OAuth-токен Яндекса с правом
 * «получение статистики»). Номер счётчика берётся из content/site.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'site.json'), 'utf8'));
const COUNTER = (site.analytics || {}).yandexMetrika;
const TOKEN = process.env.METRIKA_TOKEN;
const DAYS = Number(process.env.STATS_DAYS || 30);

if (!COUNTER) { console.log('Счётчик не задан в site.json — нечего забирать.'); process.exit(0); }
if (!TOKEN) {
  console.log('Нет секрета METRIKA_TOKEN. Добавьте его в Settings → Secrets and variables → Actions.');
  process.exit(0);
}

const API = 'https://api-metrika.yandex.net';
async function api(url) {
  const res = await fetch(url, { headers: { Authorization: 'OAuth ' + TOKEN } });
  const text = await res.text();
  if (!res.ok) throw new Error(res.status + ': ' + text.slice(0, 300));
  return JSON.parse(text);
}
function stat(params) {
  const q = new URLSearchParams(Object.assign({
    ids: COUNTER, date1: DAYS + 'daysAgo', date2: 'today', accuracy: 'full',
  }, params));
  return api(API + '/stat/v1/data?' + q);
}
const num = (v) => Math.round(Number(v) || 0);

const out = {
  updatedAt: new Date().toISOString(),
  days: DAYS,
  counter: String(COUNTER),
  totals: {}, goals: [], sources: [], geo: [], pages: [], errors: [],
};

/* Цели заводятся в интерфейсе Метрики, их идентификаторы заранее неизвестны —
   поэтому сначала спрашиваем список и сопоставляем по имени события. */
let goals = [];
try {
  const r = await api(`${API}/management/v1/counter/${COUNTER}/goals`);
  goals = (r.goals || []).map((g) => ({
    id: g.id,
    name: g.name,
    event: (g.conditions || []).map((c) => c.value).filter(Boolean)[0] || '',
  }));
  console.log('Цели в счётчике: ' + (goals.map((g) => g.name + ' (' + g.event + ')').join(', ') || 'нет'));
} catch (e) {
  out.errors.push('Список целей: ' + e.message);
}

try {
  const r = await stat({ metrics: 'ym:s:visits,ym:s:users,ym:s:pageviews,ym:s:avgVisitDurationSeconds,ym:s:bounceRate' });
  const t = (r.totals || []).map(num);
  out.totals = { visits: t[0], users: t[1], pageviews: t[2], avgSeconds: t[3], bounceRate: t[4] };
} catch (e) { out.errors.push('Итоги: ' + e.message); }

if (goals.length) {
  try {
    const metrics = goals.map((g) => `ym:s:goal${g.id}reaches`).join(',');
    const r = await stat({ metrics });
    out.goals = goals.map((g, i) => ({ id: g.id, name: g.name, event: g.event, reaches: num((r.totals || [])[i]) }));
  } catch (e) { out.errors.push('Достижения целей: ' + e.message); }
}

try {
  const r = await stat({ dimensions: 'ym:s:lastsignTrafficSource', metrics: 'ym:s:visits', limit: 10, sort: '-ym:s:visits' });
  const total = (r.data || []).reduce((s, row) => s + num(row.metrics[0]), 0) || 1;
  out.sources = (r.data || []).map((row) => ({
    name: (row.dimensions[0] || {}).name || 'не определён',
    visits: num(row.metrics[0]),
    share: Math.round(num(row.metrics[0]) / total * 100),
  }));
} catch (e) { out.errors.push('Источники: ' + e.message); }

try {
  const r = await stat({ dimensions: 'ym:s:regionCountry', metrics: 'ym:s:visits', limit: 8, sort: '-ym:s:visits' });
  out.geo = (r.data || []).map((row) => ({
    name: (row.dimensions[0] || {}).name || '—', visits: num(row.metrics[0]),
  }));
} catch (e) { out.errors.push('География: ' + e.message); }

try {
  // Страницы входа плюс достижения целей на них — из этой таблицы видно,
  // какая статья реально уводит зрителя на YouTube.
  const goalMetrics = goals.map((g) => `ym:s:goal${g.id}reaches`);
  const r = await stat({
    dimensions: 'ym:s:startURL',
    metrics: ['ym:s:visits'].concat(goalMetrics).join(','),
    limit: 20, sort: '-ym:s:visits',
  });
  out.pages = (r.data || []).map((row) => {
    const g = {};
    goals.forEach((goal, i) => { g[goal.event || goal.name] = num(row.metrics[i + 1]); });
    return { url: (row.dimensions[0] || {}).name || '', visits: num(row.metrics[0]), goals: g };
  });
} catch (e) { out.errors.push('Страницы: ' + e.message); }

fs.writeFileSync(path.join(ROOT, 'content', 'stats.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`Записано: визитов ${out.totals.visits ?? '—'}, источников ${out.sources.length}, `
  + `страниц ${out.pages.length}, целей ${out.goals.length}`);
if (out.errors.length) console.log('Ошибки:\n  ' + out.errors.join('\n  '));
