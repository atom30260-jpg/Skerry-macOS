export const JAPAN_TIMEZONE = 'Asia/Tokyo';
export const US_TIMEZONE = 'America/New_York';
export const SESSION_TIMEZONES = Object.freeze([JAPAN_TIMEZONE, US_TIMEZONE]);

const TZ_KEYS = new Set(['timezone', 'timeZone', 'time_zone', 'tz']);
const DATE_TIME = /^(\d{4}-\d{2}-\d{2})([T ])(\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)(Z|[+-]\d{2}:?\d{2})?$/;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function localTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function isSessionTimezone(value) {
  return SESSION_TIMEZONES.includes(String(value || '').trim());
}

export function pickSessionTimezone(random = Math.random) {
  return random() < 0.5 ? JAPAN_TIMEZONE : US_TIMEZONE;
}

export function ensureSessionTimezone(session, random = Math.random) {
  if (!session || typeof session !== 'object') return '';
  const current = String(session.timezone || '').trim();
  if (isSessionTimezone(current)) return current;
  session.timezone = pickSessionTimezone(random);
  return session.timezone;
}

export function applyRequestTimezone(payload, timezone, fromZone = localTimeZone()) {
  if (!isSessionTimezone(timezone)) return payload;
  return convertJsonDatetimes(payload, fromZone, timezone);
}

export function applyResponseTimezone(payload, timezone, toZone = localTimeZone()) {
  if (!isSessionTimezone(timezone)) return payload;
  return convertJsonDatetimes(payload, timezone, toZone);
}

export function convertJsonDatetimes(value, fromZone, toZone) {
  if (!fromZone || !toZone || fromZone === toZone) return value;
  if (!isValidTimeZone(fromZone) || !isValidTimeZone(toZone)) return value;
  return convertNode(value, fromZone, toZone);
}

function isValidTimeZone(zone) {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function convertNode(value, fromZone, toZone) {
  if (Array.isArray(value)) return value.map(item => convertNode(item, fromZone, toZone));
  if (!value || typeof value !== 'object') {
    if (typeof value !== 'string') return value;
    return convertDateTimeString(value, fromZone, toZone);
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = TZ_KEYS.has(key) ? item : convertNode(item, fromZone, toZone);
  }
  return out;
}

function convertDateTimeString(text, fromZone, toZone) {
  const parsed = parseDateTime(text);
  if (!parsed) return text;
  if (parsed.kind === 'date') {
    const instant = zonedWallTimeToUtc(parsed.year, parsed.month, parsed.day, 0, 0, 0, 0, fromZone);
    if (Number.isNaN(instant)) return text;
    return formatInZone(instant, toZone, { dateOnly: true });
  }
  const instant = parsed.offset
    ? Date.parse(`${parsed.date}T${normalizeClock(parsed.time)}${normalizeOffset(parsed.offset)}`)
    : zonedWallTimeToUtc(...wallParts(parsed), fromZone);
  if (Number.isNaN(instant)) return text;
  return formatInZone(instant, toZone, {
    fraction: parsed.fraction,
    separator: 'T',
    hasSeconds: parsed.hasSeconds,
  });
}

function parseDateTime(text) {
  const dateOnly = DATE_ONLY.exec(text);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    if (!validYmd(year, month, day)) return null;
    return { kind: 'date', year, month, day };
  }
  const match = DATE_TIME.exec(text);
  if (!match) return null;
  const [year, month, day] = match[1].split('-').map(Number);
  if (!validYmd(year, month, day)) return null;
  const time = match[3];
  const parts = time.split(':');
  const hour = Number(parts[0]);
  const minute = Number(parts[1]);
  if (hour > 23 || minute > 59) return null;
  let second = 0;
  let fraction = '';
  if (parts[2] != null) {
    const [sec, frac = ''] = parts[2].split('.');
    second = Number(sec);
    if (second > 59) return null;
    fraction = frac;
  }
  return {
    kind: 'datetime',
    date: match[1],
    separator: match[2],
    time,
    offset: match[4] || '',
    hasSeconds: parts.length >= 3,
    fraction,
    year,
    month,
    day,
    hour,
    minute,
    second,
  };
}

function validYmd(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

function wallParts(parsed) {
  const ms = parsed.fraction ? Number(`0.${parsed.fraction}`) * 1000 : 0;
  return [parsed.year, parsed.month, parsed.day, parsed.hour, parsed.minute, parsed.second, Math.round(ms)];
}

function normalizeClock(time) {
  return time.split(':').length >= 3 ? time : `${time}:00`;
}

function normalizeOffset(offset) {
  if (offset === 'Z') return 'Z';
  const match = offset.match(/^([+-])(\d{2}):?(\d{2})$/);
  if (!match) return offset;
  return `${match[1]}${match[2]}:${match[3]}`;
}

function zonedWallTimeToUtc(year, month, day, hour, minute, second, ms, zone) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const first = utcGuess - offsetAt(utcGuess, zone);
  const secondGuess = utcGuess - offsetAt(first, zone);
  return secondGuess;
}

function offsetAt(instant, zone) {
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    timeZoneName: 'longOffset',
    hour: '2-digit',
  }).formatToParts(new Date(instant)).find(part => part.type === 'timeZoneName')?.value || '';
  const match = name.match(/([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * ((Number(match[2]) * 60 + Number(match[3] || 0)) * 60000);
}

function formatInZone(instant, zone, { dateOnly = false, fraction = '', separator = 'T', hasSeconds = true } = {}) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'longOffset',
  }).formatToParts(new Date(instant));
  const get = type => parts.find(part => part.type === type)?.value || '';
  let hour = get('hour');
  if (hour === '24') hour = '00';
  const ymd = `${get('year')}-${get('month')}-${get('day')}`;
  if (dateOnly) return ymd;
  const offset = formatOffset(get('timeZoneName'));
  const frac = fraction ? `.${fraction}` : '';
  const clock = hasSeconds ? `${hour}:${get('minute')}:${get('second')}${frac}` : `${hour}:${get('minute')}`;
  return `${ymd}${separator}${clock}${offset}`;
}

function formatOffset(name) {
  const match = String(name || '').match(/([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!match) return '+00:00';
  return `${match[1]}${String(match[2]).padStart(2, '0')}:${match[3] || '00'}`;
}
