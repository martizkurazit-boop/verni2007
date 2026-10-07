#!/usr/bin/env node
/**
 * Забирает данные Яндекс.Вебмастера в content/webmaster.json: поисковые
 * запросы с позициями, показами и кликами, плюс состояние индексирования.
 *
 * Зачем отдельно от Метрики. Метрика видит только тех, кто до нас дошёл.
 * Вебмастер видит и показы без клика — то есть запросы, по которым сайт
 * уже в выдаче, но его не выбирают. Это и есть список того, что дожимать.
 *
 * Пишет в свой файл, а не в stats.json: два скрипта, пишущие в один файл по
 * очереди, рано или поздно затрут работу друг друга.
 *
 * Требуется WEBMASTER_TOKEN — OAuth-токен Яндекса с доступом к Вебмастеру.
 * Лежит в секретах репозитория, в браузер не попадает никогда.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'site.json'), 'utf8'));
const TOKEN = process.env.WEBMASTER_TOKEN;
const OUT = path.join(ROOT, 'content', 'webmaster.json');
const API = 'https://api.webmaster.yandex.net/v4';
const DAYS = Number(process.env.WEBMASTER_DAYS || 28);

if (!TOKEN) {
  console.log('Нет секрета WEBMASTER_TOKEN — пропускаем.');
  console.log('Добавить: Settings → Secrets and variables → Actions → New repository secret.');
  process.exit(0);
}

const out = {
  updatedAt: new Date().toISOString(),
  days: DAYS,
  host: '',
  indexing: {},
  queries: [],
  errors: [],
};

async function api(url) {
  const res = await fetch(url, { headers: { Authorization: 'OAuth ' + TOKEN } });
  const text = await res.text();
  if (!res.ok) {
    const e = new Error(res.status + ': ' + text.slice(0, 400));
    e.status = res.status;
    try { e.human = (JSON.parse(text).error_message || '').trim(); } catch (x) { e.human = ''; }
    throw e;
  }
  return text ? JSON.parse(text) : {};
}

const day = (shift) => new Date(Date.now() - shift * 86400000).toISOString().slice(0, 10);

/* ── Кто мы и какой сайт ─────────────────────────────────────────── */
let userId = '';
let hostId = '';
try {
  userId = String((await api(`${API}/user/`)).user_id || '');
  if (!userId) throw new Error('в ответе нет user_id');
  console.log('Пользователь:', userId);
} catch (e) {
  out.errors.push('Пользователь: ' + (e.human || e.message));
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log('Дальше идти некуда:', out.errors[0]);
  process.exit(0);
}

try {
  const wanted = new URL(site.url).hostname.replace(/^www\./, '');
  const { hosts = [] } = await api(`${API}/user/${userId}/hosts/`);
  console.log('Сайтов в кабинете:', hosts.length);
  // Подтверждённый сайт с нужным доменом. Если их несколько (http и https),
  // берём подтверждённый — по неподтверждённому данных всё равно не дадут.
  const match = hosts.filter((h) => String(h.ascii_host_url || h.unicode_host_url || '')
    .replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/^www\./, '') === wanted);
  const picked = match.find((h) => h.verified) || match[0];
  if (!picked) {
    out.errors.push(`Сайта ${wanted} нет в кабинете Вебмастера. Добавьте его и подтвердите права.`);
  } else if (!picked.verified) {
    out.errors.push(`Права на ${wanted} не подтверждены — Вебмастер не отдаёт данные.`);
  } else {
    hostId = picked.host_id;
    out.host = picked.unicode_host_url || picked.ascii_host_url || wanted;
    console.log('Сайт:', out.host, '| host_id:', hostId);
  }
} catch (e) {
  out.errors.push('Список сайтов: ' + (e.human || e.message));
}

/* ── Индексирование: сколько страниц в поиске ────────────────────── */
if (hostId) {
  try {
    const s = await api(`${API}/user/${userId}/hosts/${encodeURIComponent(hostId)}/summary`);
    out.indexing = {
      sqi: s.sqi ?? null,
      inSearch: s.searchable_pages_count ?? null,
      excluded: s.excluded_pages_count ?? null,
      siteProblems: s.site_problems || {},
    };
    console.log('Страниц в поиске:', out.indexing.inSearch, '| ИКС:', out.indexing.sqi);
  } catch (e) {
    out.errors.push('Сводка: ' + (e.human || e.message));
  }
}

/* ── Запросы: показы, клики, средняя позиция ─────────────────────── */
if (hostId) {
  const ind = ['TOTAL_SHOWS', 'TOTAL_CLICKS', 'AVG_SHOW_POSITION', 'AVG_CLICK_POSITION']
    .map((x) => 'query_indicator=' + x).join('&');
  const url = `${API}/user/${userId}/hosts/${encodeURIComponent(hostId)}/search-queries/popular/`
    + `?order_by=TOTAL_SHOWS&${ind}&date_from=${day(DAYS)}&date_to=${day(1)}&limit=100`;
  try {
    const r = await api(url);
    out.queries = (r.queries || []).map((q) => {
      const v = q.indicators || {};
      return {
        text: q.query_text || '',
        shows: v.TOTAL_SHOWS ?? 0,
        clicks: v.TOTAL_CLICKS ?? 0,
        position: v.AVG_SHOW_POSITION ?? null,
        clickPosition: v.AVG_CLICK_POSITION ?? null,
      };
    }).filter((q) => q.text);
    console.log('Запросов получено:', out.queries.length);
  } catch (e) {
    out.errors.push('Запросы: ' + (e.human || e.message));
  }
}

/* Самое полезное из всего отчёта: фразы, где мы уже показываемся на второй
   странице выдачи. Поднять такую страницу на первую дешевле, чем родить
   новую с нуля, — трафик появляется почти сразу. */
out.nearlyThere = out.queries
  .filter((q) => q.position !== null && q.position > 10 && q.position <= 30 && q.shows >= 3)
  .sort((a, b) => b.shows - a.shows)
  .slice(0, 20);

fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log(`\nЗаписано: запросов ${out.queries.length}, из них «почти в топе» ${out.nearlyThere.length}`);
if (out.errors.length) console.log('Ошибки:\n  ' + out.errors.join('\n  '));
