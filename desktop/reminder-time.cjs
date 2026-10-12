const formatter = zone => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

/** Validate an IANA zone without relying on the computer's current offset. */
function timezone(value) {
  if (typeof value !== 'string' || value.length > 80) throw new Error('Укажите часовой пояс IANA, например Europe/Moscow.');
  try { formatter(value).format(0); } catch { throw new Error('Неизвестный часовой пояс: ' + value); }
  return value;
}
function parts(value, zone) {
  return Object.fromEntries(formatter(zone).formatToParts(value).filter(item => item.type !== 'literal').map(item => [item.type, Number(item.value)]));
}
function stamp(value) { return Date.UTC(value.year, value.month - 1, value.day, value.hour || 0, value.minute || 0, value.second || 0); }
function same(a, b) { return ['year','month','day','hour','minute','second'].every(key => (a[key] || 0) === (b[key] || 0)); }

/** Reject impossible and repeated wall-clock times instead of choosing a DST offset. */
function wallToUtc(value, zone) {
  timezone(zone);
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) throw new Error('Укажите дату и время: ГГГГ-ММ-ДДTЧЧ:ММ.');
  const fields = value.match(/\d+/g).map(Number);
  const wall = Object.fromEntries(['year','month','day','hour','minute','second'].map((key, index) => [key, fields[index] || 0]));
  const utc = stamp(wall), round = new Date(utc);
  if (wall.year < 2020 || wall.year > 2100 || round.toISOString().slice(0, 16) !== value.slice(0, 16) || wall.second > 59) throw new Error('Несуществующая дата или время.');
  const candidates = new Set();
  for (let hours = -36; hours <= 36; hours += 6) {
    const probe = utc + hours * 3600000, offset = stamp(parts(probe, zone)) - probe;
    const result = utc - offset;
    if (same(parts(result, zone), wall)) candidates.add(result);
  }
  if (!candidates.size) throw new Error('Такого местного времени нет из-за перевода часов. Выберите другое время.');
  if (candidates.size > 1) throw new Error('Это время повторяется при переводе часов. Выберите однозначное время.');
  return new Date([...candidates][0]).toISOString();
}
function localTime(value, zone) {
  const p = parts(new Date(value), zone), pad = n => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}
const numbers = new Map([['одну',1],['один',1],['одна',1],['два',2],['две',2],['три',3],['четыре',4],['пять',5],['шесть',6],['семь',7],['восемь',8],['девять',9],['десять',10],['пятнадцать',15],['двадцать',20],['тридцать',30]]);
const normalize = text => text.normalize('NFKC').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

/** Parse supported Russian time phrases from the original utterance, not an LLM date. */
function resolveTime(text, spokenAt, zone) {
  timezone(zone);
  const input = normalize(text), base = new Date(spokenAt);
  const clarify = question => ({ due_at: null, due_local: '', question });
  if (typeof spokenAt !== 'string' || !spokenAt.trim() || !Number.isFinite(base.getTime())) return clarify('Неизвестно время произнесения. Укажите точную дату и время.');
  if (/(?:примерно|около|как только|если|после обеда|в течение|следующ\p{L}* (?:понедельник|вторник|сред|четверг|пятниц|суббот|воскресень))/u.test(input)) return clarify('Уточните точную дату и время напоминания.');
  const relatives = [...input.matchAll(/(?<![\p{L}\p{N}])через\s+(полчаса|полтора\s+часа|час|минуту|день|неделю|(?:\d{1,5}|одну|один|одна|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять|пятнадцать|двадцать|тридцать)\s+(?:секунд\p{L}*|минут\p{L}*|час\p{L}*|дн\p{L}*|день|недел\p{L}*))(?![\p{L}\p{N}])/gu)];
  const dates = [...input.matchAll(/(?<![\p{L}\p{N}])(послезавтра|завтра|сегодня|\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.\d{4}|понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)(?![\p{L}\p{N}])/gu)];
  const clocks = [...input.matchAll(/(?<!\d)(\d{1,2}):(\d{2})(?!\d)/g)];
  if (relatives.length > 1 || dates.length > 1 || clocks.length > 1 || (relatives.length && (dates.length || clocks.length))) return clarify('В фразе несколько вариантов времени. Выберите один.');
  if (relatives.length && /^\s*(?:и\s*)?(?:\d+|полчаса|два|две|три|пять|десять|пятнадцать|тридцать)\s*(?:минут|час|секунд)/u.test(input.slice(relatives[0].index + relatives[0][0].length))) return clarify('Укажите интервал одним числом, например «через 90 минут».');
  let due;
  try {
    if (relatives.length) {
      const phrase = relatives[0][1], split = phrase.split(' ');
      let count = split.length === 1 ? 1 : Number(split[0]) || numbers.get(split[0]);
      let unit = split.at(-1);
      if (phrase === 'полчаса') { count = 30; unit = 'минут'; }
      if (phrase === 'полтора часа') count = 1.5;
      if (!count || count < 0 || count > 10000) return clarify('Уточните допустимый интервал времени.');
      if (/^(?:д|нед)/.test(unit)) {
        const days = count * (unit.startsWith('нед') ? 7 : 1);
        if (days > 365) return clarify('Укажите точную дату для интервала больше года.');
        const wall = parts(base, zone), shifted = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days));
        due = wallToUtc(`${shifted.toISOString().slice(0,10)}T${String(wall.hour).padStart(2,'0')}:${String(wall.minute).padStart(2,'0')}:${String(wall.second).padStart(2,'0')}`, zone);
      } else {
        const ms = count * (unit.startsWith('час') ? 3600000 : unit.startsWith('минут') ? 60000 : 1000);
        if (ms > 365 * 86400000) return clarify('Укажите точную дату для интервала больше года.');
        due = new Date(base.getTime() + ms).toISOString();
      }
    } else {
      if (!dates.length || !clocks.length) return clarify('Укажите день и точное время, например «завтра в 19:00».');
      const [hour, minute] = clocks[0].slice(1).map(Number);
      if (hour > 23 || minute > 59) return clarify('Проверьте часы и минуты.');
      const date = dates[0][1], wall = parts(base, zone);
      let day;
      if (/^\d{4}-/.test(date)) day = date;
      else if (/^\d/.test(date)) { const [d,m,y] = date.split('.'); day = `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`; }
      else {
        let delta = { сегодня:0, завтра:1, послезавтра:2 }[date];
        if (delta === undefined) {
          const wanted = ['воскресенье','понедельник','вторник','среду','четверг','пятницу','субботу'].indexOf(date);
          const current = new Date(Date.UTC(wall.year,wall.month-1,wall.day)).getUTCDay();
          delta = (wanted-current+7)%7;
          if (!delta) return clarify('Сегодня этот день недели. Уточните: сегодня или через неделю?');
        }
        day = new Date(Date.UTC(wall.year,wall.month-1,wall.day+delta)).toISOString().slice(0,10);
      }
      due = wallToUtc(`${day}T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`, zone);
    }
  } catch (error) { return clarify(error.message); }
  if (new Date(due) <= base) return clarify('Это время уже прошло на момент записи. Укажите будущую дату.');
  return { due_at: due, due_local: localTime(due, zone), question: '' };
}
module.exports = { timezone, normalize, resolveTime, wallToUtc, localTime };
