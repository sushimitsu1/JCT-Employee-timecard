// Pacific civil time for the timecard. All pay weeks and displays use
// America/Los_Angeles, including daylight-saving transitions.
// Instants are stored as UTC milliseconds. A punch is never snapped to a
// 5- or 15-minute boundary.

export const PACIFIC = 'America/Los_Angeles';

const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKDAY_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function pacificParts(date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: PACIFIC,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  });
  const map = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
    weekday: map.weekday,
  };
}

export function ymd(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function parseYmd(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!isValidCivilDate(year, month, day)) return null;
  return { year, month, day };
}

export function isValidCivilDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

export function pacificYmd(ms) {
  const parts = pacificParts(new Date(ms));
  return ymd(parts.year, parts.month, parts.day);
}

export function addDays(year, month, day, count) {
  const probe = new Date(Date.UTC(year, month - 1, day + count));
  return { year: probe.getUTCFullYear(), month: probe.getUTCMonth() + 1, day: probe.getUTCDate() };
}

export function addDaysYmd(value, count) {
  const parsed = parseYmd(value);
  if (!parsed) throw new Error('bad date');
  const next = addDays(parsed.year, parsed.month, parsed.day, count);
  return ymd(next.year, next.month, next.day);
}

// Monday = 0 ... Sunday = 6. Weekday of a civil date does not depend on zone.
export function weekdayMon0(value) {
  const parsed = parseYmd(value);
  const sun0 = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).getUTCDay();
  return (sun0 + 6) % 7;
}

function findUtcHits(year, month, day, hour, minute) {
  const rough = Date.UTC(year, month - 1, day, hour + 8, minute, 0);
  const hits = [];
  for (let delta = -8 * 3600000; delta <= 8 * 3600000; delta += 60000) {
    const instant = rough + delta;
    const parts = pacificParts(new Date(instant));
    if (
      parts.year === year &&
      parts.month === month &&
      parts.day === day &&
      parts.hour === hour &&
      parts.minute === minute &&
      parts.second === 0
    ) {
      hits.push(instant);
    }
  }
  hits.sort((a, b) => a - b);
  return hits;
}

// Convert a Pacific clock time to a UTC instant.
// Fall-back (the repeated hour): the earlier instant is used.
// Spring-forward (the missing hour): the next real local minute is used.
export function pacificLocalToUtc(year, month, day, hour, minute) {
  if (!isValidCivilDate(year, month, day) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error('bad local time');
  }
  const hits = findUtcHits(year, month, day, hour, minute);
  if (hits.length >= 1) {
    return {
      ms: hits[0],
      warning: hits.length > 1
        ? `${formatTime12(hour, minute)} happens twice on this date because clocks fall back. Saved the earlier one.`
        : null,
    };
  }
  // Missing local time (spring forward). Scan real Pacific minutes and keep
  // the first one at or after the requested clock time.
  const rough = Date.UTC(year, month - 1, day, hour + 8, minute, 0);
  for (let delta = -4 * 3600000; delta <= 4 * 3600000; delta += 60000) {
    const parts = pacificParts(new Date(rough + delta));
    if (parts.year !== year || parts.month !== month || parts.day !== day) continue;
    const civil = parts.hour * 60 + parts.minute;
    if (civil >= hour * 60 + minute) {
      const snapped = findUtcHits(year, month, day, parts.hour, parts.minute);
      return {
        ms: snapped[0],
        warning: `${formatTime12(hour, minute)} does not exist on this date because clocks spring forward. Saved as ${formatTime12(parts.hour, parts.minute)}.`,
      };
    }
  }
  throw new Error('could not resolve Pacific time');
}

export function nextPacificMidnight(ms) {
  const next = addDaysYmd(pacificYmd(ms), 1);
  const parsed = parseYmd(next);
  return pacificLocalToUtc(parsed.year, parsed.month, parsed.day, 0, 0).ms;
}

export function midnightsBetween(startMs, endMs) {
  const cuts = [];
  if (!(endMs > startMs)) return cuts;
  let cursor = nextPacificMidnight(startMs);
  let guard = 0;
  while (cursor < endMs && guard < 4000) {
    if (cursor > startMs) cuts.push(cursor);
    const following = nextPacificMidnight(cursor);
    if (following <= cursor) break;
    cursor = following;
    guard += 1;
  }
  return cuts;
}

export function formatTime12(hour, minute) {
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

export function formatTime12FromMs(ms) {
  const parts = pacificParts(new Date(ms));
  return formatTime12(parts.hour, parts.minute);
}

export function formatHm(hour, minute) {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function formatWeekRange(startYmd, endYmd) {
  return `${formatDowMonthDay(startYmd)} – ${formatDowMonthDay(endYmd)}`;
}

export function formatDowMonthDay(value) {
  const parsed = parseYmd(value);
  return `${WEEKDAY_SHORT[weekdayMon0(value)]} ${MONTHS[parsed.month - 1]} ${parsed.day}`;
}

export function formatLongDate(value) {
  const parsed = parseYmd(value);
  return `${WEEKDAY_LONG[weekdayMon0(value)]}, ${MONTHS[parsed.month - 1]} ${parsed.day}, ${parsed.year}`;
}

export function formatDayHeading(value) {
  const parsed = parseYmd(value);
  return `${WEEKDAY_SHORT[weekdayMon0(value)]} ${parsed.month}/${parsed.day}`;
}

export function formatPayFriday(payYmd) {
  const parsed = parseYmd(payYmd);
  return `Pay Friday: ${MONTHS[parsed.month - 1]} ${parsed.day}`;
}

// Pay week is Monday 00:00 through the following Monday 00:00, Pacific.
// Pay date is the Friday AFTER the week ends: Monday + 11 days.
// It is not the Friday inside the week (Monday + 4).
export const PAY_FRIDAY_OFFSET_DAYS = 11;

export function payWeekFromMonday(mondayYmd) {
  if (weekdayMon0(mondayYmd) !== 0) throw new Error('week start must be a Monday');
  const end = addDaysYmd(mondayYmd, 6);
  const payDate = addDaysYmd(mondayYmd, PAY_FRIDAY_OFFSET_DAYS);
  const startParsed = parseYmd(mondayYmd);
  const nextMonday = parseYmd(addDaysYmd(mondayYmd, 7));
  return {
    start: mondayYmd,
    end,
    payDate,
    label: formatWeekRange(mondayYmd, end),
    payLabel: formatPayFriday(payDate),
    startMs: pacificLocalToUtc(startParsed.year, startParsed.month, startParsed.day, 0, 0).ms,
    endMs: pacificLocalToUtc(nextMonday.year, nextMonday.month, nextMonday.day, 0, 0).ms,
  };
}

export function payWeekContaining(ms) {
  const date = pacificYmd(ms);
  const monday = addDaysYmd(date, -weekdayMon0(date));
  return payWeekFromMonday(monday);
}

export function eachDate(startYmd, endYmd) {
  const dates = [];
  let cursor = startYmd;
  while (cursor <= endYmd) {
    dates.push(cursor);
    cursor = addDaysYmd(cursor, 1);
  }
  return dates;
}
