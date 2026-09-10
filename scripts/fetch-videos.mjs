#!/usr/bin/env node
/**
 * Забирает список последних выпусков YouTube-канала в content/videos.json.
 *
 * Используется публичная RSS-лента канала — ни ключа, ни токена не нужно.
 * Отдаёт последние 15 роликов: этого хватает и для страницы «Видео»,
 * и для блока новых выпусков на главной.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'site.json'), 'utf8'));
const channel = site.youtubeChannel || '';
const m = channel.match(/channel\/(UC[\w-]+)/);

if (!m) {
  console.log('В site.json нет адреса канала вида /channel/UC… — пропускаем.');
  process.exit(0);
}
const id = m[1];
const res = await fetch('https://www.youtube.com/feeds/videos.xml?channel_id=' + id);
if (!res.ok) {
  console.log('YouTube ответил ' + res.status + ' — оставляем прежний список.');
  process.exit(0);
}
const xml = await res.text();

const pick = (block, tag) => {
  const r = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>');
  const found = r.exec(block);
  return found ? found[1] : '';
};
const unescape = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim();

const entries = xml.split('<entry>').slice(1).map((block) => ({
  id: pick(block, 'yt:videoId'),
  title: unescape(pick(block, 'title')),
  published: pick(block, 'published'),
  description: unescape(pick(block, 'media:description')).split('\n')[0].slice(0, 220),
})).filter((v) => v.id).slice(0, 15);

const channelTitle = unescape(pick(xml.split('<entry>')[0], 'title'));
const out = {
  updatedAt: new Date().toISOString(),
  channelId: id,
  channelTitle: channelTitle,
  channelUrl: channel,
  videos: entries,
};
fs.writeFileSync(path.join(ROOT, 'content', 'videos.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`Выпусков получено: ${entries.length}. Канал: ${channelTitle || id}`);
