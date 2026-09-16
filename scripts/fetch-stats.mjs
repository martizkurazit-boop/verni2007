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
  if (!res.ok) {
    const err = new Error(res.status + ': ' + text.slice(0, 300));
    err.status = res.status;
    // «Запрос слишком сложный» — это не поломка, а просьба считать дешевле.
    err.tooHeavy = res.status === 400 && /слишком сложн|too complex|query_error/i.test(text);
    try { err.human = (JSON.parse(text).message || '').trim(); } catch (e) { err.human = ''; }
    throw err;
  }
  return JSON.parse(text);
}

/* Метрика отказывается считать тяжёлые запросы и прямым текстом просит
   уменьшить точность или период. Раньше мы просили accuracy=full — расчёт
   по всем визитам без выборки, — и на этом всё вставало. Теперь идём
   лесенкой: сначала дёшево и точно, при отказе — ещё дешевле, в крайнем
   случае за неделю вместо месяца. Для сайта с сотнями визитов разницы в
   цифрах нет, а отчёт приходит всегда. */
const LADDER = [
  { accuracy: 'medium', days: DAYS },
  { accuracy: 'low', days: DAYS },
  { accuracy: 'low', days: Math.min(7, DAYS) },
];
let sampled = false;

async function stat(params) {
  let last;
  for (const step of LADDER) {
    const q = new URLSearchParams(Object.assign({
      ids: COUNTER, date1: step.days + 'daysAgo', date2: 'today', accuracy: step.accuracy,
      // Без lang API отдаёт названия источников и стран по-английски.
      lang: 'ru',
    }, params));
    try {
      const r = await api(API + '/stat/v1/data?' + q);
      if (r.sampled) sampled = true;
      if (step !== LADDER[0]) console.log('  (пересчитано с точностью ' + step.accuracy + ' за ' + step.days + ' дней)');
      return r;
    } catch (e) {
      last = e;
      if (!e.tooHeavy) throw e;
    }
  }
  throw last;
}
const num = (v) => Math.round(Number(v) || 0);

/* Если Метрика отказывает даже на простейшем отчёте, дело не в сложности
   запроса, а в каком-то параметре. Перебираем их по одному и печатаем ответ:
   без доступа к API руками это единственный способ понять, что именно ей
   не нравится. Токен в журнал не попадает — он уходит заголовком. */
async function probe() {
  const line = (mark, name, text) => console.log(`   ${mark} ${name}: ${String(text).slice(0, 150)}`);
  console.log('— что отвечает Метрика:');

  // 1. Виден ли счётчик токену и в каком он состоянии.
  try {
    const r = await api(`${API}/management/v1/counter/${COUNTER}`);
    const c = r.counter || {};
    line('✓', 'счётчик', `${c.id} «${c.name}», статус ${c.status}, права ${c.permission}, владелец ${c.owner_login}`);
  } catch (e) { line('✗', 'счётчик', e.human || e.message); }

  // 2. Какие счётчики токен вообще видит.
  try {
    const r = await api(`${API}/management/v1/counters?per_page=20`);
    line('✓', 'доступные счётчики', (r.counters || []).map((c) => c.id + ' ' + c.permission).join(', ') || 'ни одного');
  } catch (e) { line('✗', 'доступные счётчики', e.human || e.message); }

  // 3. Отчёты: разные метрики, периоды и точки входа.
  const cases = [
    ['визиты за вчера', `/stat/v1/data?ids=${COUNTER}&metrics=ym:s:visits&date1=yesterday&date2=yesterday`],
    ['посетители за вчера', `/stat/v1/data?ids=${COUNTER}&metrics=ym:s:users&date1=yesterday&date2=yesterday`],
    ['визиты по дням', `/stat/v1/data/bytime?ids=${COUNTER}&metrics=ym:s:visits&date1=yesterday&date2=yesterday`],
    ['чужой счётчик (для сравнения ошибки)', `/stat/v1/data?ids=1&metrics=ym:s:visits&date1=yesterday&date2=yesterday`],
  ];
  // Контроль: тот же запрос к другому счётчику, доступному тому же токену.
  // Если он считается — беда в конкретном счётчике, если нет — во всём
  // аккаунте, и это уже вопрос к поддержке Метрики.
  try {
    const r = await api(`${API}/management/v1/counters?per_page=20`);
    const other = (r.counters || []).find((c) => String(c.id) !== String(COUNTER));
    if (other) cases.push([`контрольный счётчик ${other.id}`,
      `/stat/v1/data?ids=${other.id}&metrics=ym:s:visits&date1=yesterday&date2=yesterday`]);
  } catch (e) { /* список уже печатали выше */ }

  for (const [name, path] of cases) {
    try {
      const r = await api(API + path);
      line('✓', name, 'ответ получен: ' + JSON.stringify((r.totals || [])[0]));
    } catch (e) { line('✗', name, (e.status || '') + ' ' + (e.human || e.message)); }
  }
}

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
  const r = await api(`${API}/management/v1/counter/${COUNTER}/goals?lang=ru`);
  goals = (r.goals || []).map((g) => ({
    id: g.id,
    name: g.name,
    // У «целевого события» идентификатор лежит в поле url — не в value,
    // как можно подумать по названию. Берём оба на всякий случай.
    event: (g.conditions || []).map((c) => c.url || c.value).filter(Boolean)[0] || '',
  }));
  console.log('Цели в счётчике: ' + (goals.map((g) => g.name + ' (' + g.event + ')').join(', ') || 'нет'));
} catch (e) {
  out.errors.push('Список целей: ' + e.message);
}

try {
  const r = await stat({ metrics: 'ym:s:visits,ym:s:users,ym:s:pageviews,ym:s:avgVisitDurationSeconds,ym:s:bounceRate' });
  const t = (r.totals || []).map(num);
  out.totals = { visits: t[0], users: t[1], pageviews: t[2], avgSeconds: t[3], bounceRate: t[4] };
} catch (e) {
  out.errors.push('Итоги: ' + (e.human || e.message));
  // Самый простой отчёт не прошёл — ищем виноватый параметр.
  await probe();
}

/* Цели известны всегда — даже если цифры по ним не пришли. Иначе админка
   скажет «цель не заведена» там, где цель есть, а не получены данные. */
out.goals = goals.map((g) => ({ id: g.id, name: g.name, event: g.event, reaches: null }));
if (goals.length) {
  // По одной метрике на цель: десяток целей — и запрос снова становится
  // «слишком сложным». Спрашиваем пачками по пять.
  for (let i = 0; i < goals.length; i += 5) {
    const chunk = goals.slice(i, i + 5);
    try {
      const r = await stat({ metrics: chunk.map((g) => `ym:s:goal${g.id}reaches`).join(',') });
      chunk.forEach((g, j) => {
        const row = out.goals.find((x) => x.id === g.id);
        if (row) row.reaches = num((r.totals || [])[j]);
      });
    } catch (e) { out.errors.push('Достижения целей: ' + (e.human || e.message)); }
  }
}

try {
  const r = await stat({ dimensions: 'ym:s:lastsignTrafficSource', metrics: 'ym:s:visits', limit: 10, sort: '-ym:s:visits' });
  const total = (r.data || []).reduce((s, row) => s + num(row.metrics[0]), 0) || 1;
  out.sources = (r.data || []).map((row) => ({
    name: (row.dimensions[0] || {}).name || 'не определён',
    visits: num(row.metrics[0]),
    share: Math.round(num(row.metrics[0]) / total * 100),
  }));
} catch (e) { out.errors.push('Источники: ' + (e.human || e.message)); }

try {
  const r = await stat({ dimensions: 'ym:s:regionCountry', metrics: 'ym:s:visits', limit: 8, sort: '-ym:s:visits' });
  out.geo = (r.data || []).map((row) => ({
    name: (row.dimensions[0] || {}).name || '—', visits: num(row.metrics[0]),
  }));
} catch (e) { out.errors.push('География: ' + (e.human || e.message)); }

try {
  // Страницы входа плюс достижения целей на них — из этой таблицы видно,
  // какая статья реально уводит зрителя на YouTube.
  // В таблицу страниц берём не больше четырёх целей: каждая — отдельная
  // метрика, а вместе с визитами их и так пять на строку.
  const pageGoals = goals.slice(0, 4);
  const goalMetrics = pageGoals.map((g) => `ym:s:goal${g.id}reaches`);
  const r = await stat({
    dimensions: 'ym:s:startURL',
    metrics: ['ym:s:visits'].concat(goalMetrics).join(','),
    limit: 20, sort: '-ym:s:visits',
  });
  out.pages = (r.data || []).map((row) => {
    const g = {};
    pageGoals.forEach((goal, i) => { g[goal.event || goal.name] = num(row.metrics[i + 1]); });
    return { url: (row.dimensions[0] || {}).name || '', visits: num(row.metrics[0]), goals: g };
  });
} catch (e) { out.errors.push('Страницы: ' + (e.human || e.message)); }

out.sampled = sampled;
fs.writeFileSync(path.join(ROOT, 'content', 'stats.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`Записано: визитов ${out.totals.visits ?? '—'}, источников ${out.sources.length}, `
  + `страниц ${out.pages.length}, целей ${out.goals.length}`);
if (out.errors.length) console.log('Ошибки:\n  ' + out.errors.join('\n  '));
