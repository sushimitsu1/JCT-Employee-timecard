// Pay and time math. No database and no Worker APIs.
//
// Rules (decided for this build; Jay can change them before payroll use):
// - Time zone is America/Los_Angeles. DST is handled by using real instants.
// - A pay week is Monday 00:00 through Sunday 24:00 Pacific.
// - Pay date is the Friday after that Sunday (Monday + 11 days).
// - Punches are not rounded to 5 or 15 minutes. The exact instant is kept.
// - Paid time is whole minutes: floor((end - start) / 60 seconds). Leftover
//   seconds are dropped, never rounded up.
// - Lunch (lunch out → lunch in, or lunch out → clock out) is unpaid.
// - A shift that crosses midnight, including Sunday night into Monday, is
//   split at each Pacific midnight. The whole-minute total of that paid
//   stretch is divided across the pieces by largest remainder, so the
//   pieces add up to the same total. Ties go to the earlier piece.
//   Minutes before Monday 00:00 belong to the previous pay week.
// - An open shift (no clock out yet) counts up to "as of", then stops.
//   It keeps counting until someone clocks out or an owner edits it.
// - Weekly overtime only. Minutes after 2,400 in the pay week (40 hours)
//   are overtime. There is no daily overtime and no 7th-day rule.
// - Money is integer cents.
//   Regular pay = half-up(regularMinutes * hourlyCents / 60)
//   OT pay      = half-up(otMinutes * hourlyCents * 3 / 120)
//   OT pay is minutes × rate × 1.5 / 60.
//   Half-up: a remainder of exactly 1/2 rounds away from zero.
//   Rounding happens once per hourly rate for the week's regular minutes,
//   and once per hourly rate for the week's overtime minutes. Days are not
//   rounded into money separately and then added.
// - The rate is the latest one whose effective date is on or before that
//   Pacific calendar date. A rate covers the whole local date.

import {
  addDaysYmd,
  eachDate,
  formatDayHeading,
  formatHm,
  formatLongDate,
  formatTime12FromMs,
  midnightsBetween,
  pacificLocalToUtc,
  pacificParts,
  pacificYmd,
  parseYmd,
  payWeekContaining,
  payWeekFromMonday,
  weekdayMon0,
} from './time.js';

export const WEEKLY_OT_AFTER_MINUTES = 40 * 60;

export const NEXT_STATE = {
  out: { clock_in: 'in' },
  in: { lunch_out: 'lunch', clock_out: 'out' },
  lunch: { lunch_in: 'in', clock_out: 'out' },
};

export function transitionError(state, kind) {
  if (kind === 'clock_in' && state !== 'out') return 'Already clocked in.';
  if (kind === 'clock_out' && state === 'out') return "Can't clock out before clocking in.";
  if (kind === 'lunch_out' && state !== 'in') {
    return state === 'lunch' ? 'Already at lunch.' : 'Clock in before lunch.';
  }
  if (kind === 'lunch_in' && state !== 'lunch') return 'Not at lunch.';
  return 'That punch is not allowed right now.';
}

export function validatePunches(punches) {
  const sorted = sortPunches(punches);
  const errors = [];
  let state = 'out';
  let last = null;
  for (const punch of sorted) {
    if (last !== null && punch.atMs === last) {
      errors.push('Two punches are at the same time.');
      break;
    }
    if (last !== null && punch.atMs < last) {
      errors.push('Punches go backwards.');
      break;
    }
    const next = NEXT_STATE[state]?.[punch.kind];
    if (!next) {
      errors.push(transitionError(state, punch.kind));
      break;
    }
    state = next;
    last = punch.atMs;
  }
  return errors;
}

export function divRoundHalfUp(numerator, denominator) {
  if (!Number.isSafeInteger(denominator) || denominator <= 0) throw new Error('bad denominator');
  if (numerator < 0) return -divRoundHalfUp(-numerator, denominator);
  return Math.floor((numerator + Math.floor(denominator / 2)) / denominator);
}

export function payForMinutes(minutes, hourlyCents, kind) {
  if (minutes <= 0 || hourlyCents <= 0) return 0;
  if (kind === 'ot') return divRoundHalfUp(minutes * hourlyCents * 3, 120);
  return divRoundHalfUp(minutes * hourlyCents, 60);
}

export function centsToDollars(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function formatDollars(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

export function dollarsToCents(input) {
  const text = String(input ?? '').trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents > 100000) return null;
  return cents;
}

export function formatHours(minutes, decimals) {
  const sign = minutes < 0 ? '-' : '';
  const scale = 10 ** decimals;
  const scaled = divRoundHalfUp(Math.abs(minutes) * scale, 60);
  const whole = Math.floor(scaled / scale);
  const frac = String(scaled % scale).padStart(decimals, '0');
  return `${sign}${whole}.${frac}`;
}

export function rateForDate(rates, dateYmd) {
  let chosen = null;
  for (const rate of rates) {
    if (rate.effectiveOn <= dateYmd && (chosen === null || rate.effectiveOn >= chosen.effectiveOn)) {
      chosen = rate;
    }
  }
  return chosen;
}

function sortPunches(punches) {
  return [...punches].sort((a, b) => a.atMs - b.atMs || (a.id || 0) - (b.id || 0));
}

export function walkPunches(punches, asOfMs) {
  const sorted = sortPunches(punches).filter((punch) => punch.atMs <= asOfMs);
  const paid = [];
  let state = 'out';
  let segmentStart = null;
  let shiftStart = null;
  let shiftPaidMs = 0;
  let lastOutAt = null;
  for (const punch of sorted) {
    if (punch.kind === 'clock_in' && state === 'out') {
      segmentStart = punch.atMs;
      shiftStart = punch.atMs;
      shiftPaidMs = 0;
      state = 'in';
    } else if (punch.kind === 'lunch_out' && state === 'in') {
      paid.push({ start: segmentStart, end: punch.atMs, open: false, shiftStart });
      shiftPaidMs += punch.atMs - segmentStart;
      state = 'lunch';
    } else if (punch.kind === 'lunch_in' && state === 'lunch') {
      segmentStart = punch.atMs;
      state = 'in';
    } else if (punch.kind === 'clock_out' && state === 'in') {
      paid.push({ start: segmentStart, end: punch.atMs, open: false, shiftStart });
      shiftPaidMs += punch.atMs - segmentStart;
      lastOutAt = punch.atMs;
      state = 'out';
      segmentStart = null;
      shiftStart = null;
      shiftPaidMs = 0;
    } else if (punch.kind === 'clock_out' && state === 'lunch') {
      lastOutAt = punch.atMs;
      state = 'out';
      segmentStart = null;
      shiftStart = null;
      shiftPaidMs = 0;
    } else {
      const error = new Error(transitionError(state, punch.kind));
      error.code = 'invalid_timeline';
      throw error;
    }
  }
  if (state === 'in' && segmentStart != null && asOfMs > segmentStart) {
    paid.push({ start: segmentStart, end: asOfMs, open: true, shiftStart });
    shiftPaidMs += asOfMs - segmentStart;
  }
  return { paid, state, shiftStart, shiftPaidMs: state === 'out' ? 0 : shiftPaidMs, lastOutAt };
}

function allocateMinutes(startMs, endMs, cuts) {
  const points = [startMs, ...cuts.filter((cut) => cut > startMs && cut < endMs), endMs];
  const unique = [points[0]];
  for (const point of points.slice(1)) {
    if (point > unique[unique.length - 1]) unique.push(point);
  }
  const spans = [];
  for (let i = 0; i < unique.length - 1; i += 1) spans.push(unique[i + 1] - unique[i]);
  const totalMs = endMs - startMs;
  const totalMin = totalMs > 0 ? Math.floor(totalMs / 60000) : 0;
  if (spans.length === 0 || totalMs <= 0) return [];
  if (totalMin <= 0) {
    return spans.map((_, index) => ({
      start: unique[index],
      end: unique[index + 1],
      minutes: 0,
    }));
  }
  const raw = spans.map((ms) => (totalMin * ms) / totalMs);
  const floors = raw.map((value) => Math.floor(value));
  let leftover = totalMin - floors.reduce((sum, value) => sum + value, 0);
  const order = raw
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);
  for (let i = 0; i < leftover; i += 1) floors[order[i].index] += 1;
  return floors.map((minutes, index) => ({
    start: unique[index],
    end: unique[index + 1],
    minutes,
  }));
}

function piecesOf(segment) {
  const cuts = midnightsBetween(segment.start, segment.end);
  return allocateMinutes(segment.start, segment.end, cuts).map((piece) => ({
    ...piece,
    date: pacificYmd(piece.start),
    open: segment.open,
  }));
}

export function buildWeekView({ punches, rates, weekStartYmd, asOfMs }) {
  const week = payWeekFromMonday(weekStartYmd);
  const visible = punches.filter((punch) => punch.atMs <= asOfMs);
  const errors = validatePunches(visible);
  if (errors.length) {
    const error = new Error(errors[0]);
    error.code = 'invalid_timeline';
    throw error;
  }
  const walked = walkPunches(visible, asOfMs);
  const pieces = [];
  for (const segment of walked.paid) {
    for (const piece of piecesOf(segment)) {
      if (piece.date >= week.start && piece.date <= week.end && (piece.minutes > 0 || piece.open)) {
        pieces.push(piece);
      }
    }
  }
  pieces.sort((a, b) => a.start - b.start || a.date.localeCompare(b.date));

  const days = new Map();
  for (const date of eachDate(week.start, week.end)) {
    days.set(date, {
      date,
      label: formatDayHeading(date),
      regularMinutes: 0,
      otMinutes: 0,
      open: false,
    });
  }
  let regularLeft = WEEKLY_OT_AFTER_MINUTES;
  const buckets = new Map();
  for (const piece of pieces) {
    let regular = 0;
    if (regularLeft > 0) {
      regular = Math.min(piece.minutes, regularLeft);
      regularLeft -= regular;
    }
    const ot = piece.minutes - regular;
    const day = days.get(piece.date);
    day.regularMinutes += regular;
    day.otMinutes += ot;
    if (piece.open) day.open = true;
    if (piece.minutes > 0) {
      const rate = rateForDate(rates, piece.date);
      const hourlyCents = rate ? rate.hourlyCents : 0;
      const bucket = buckets.get(hourlyCents) || { hourlyCents, regularMinutes: 0, otMinutes: 0 };
      bucket.regularMinutes += regular;
      bucket.otMinutes += ot;
      buckets.set(hourlyCents, bucket);
    }
  }

  const byRate = [...buckets.values()]
    .sort((a, b) => a.hourlyCents - b.hourlyCents)
    .map((bucket) => {
      const regularPayCents = payForMinutes(bucket.regularMinutes, bucket.hourlyCents, 'regular');
      const otPayCents = payForMinutes(bucket.otMinutes, bucket.hourlyCents, 'ot');
      return { ...bucket, regularPayCents, otPayCents, grossPayCents: regularPayCents + otPayCents };
    });

  const regularMinutes = byRate.reduce((sum, bucket) => sum + bucket.regularMinutes, 0);
  const otMinutes = byRate.reduce((sum, bucket) => sum + bucket.otMinutes, 0);
  const regularPayCents = byRate.reduce((sum, bucket) => sum + bucket.regularPayCents, 0);
  const otPayCents = byRate.reduce((sum, bucket) => sum + bucket.otPayCents, 0);
  const mondayRate = rateForDate(rates, week.start);
  const rateCentsUsed = new Set(byRate.map((bucket) => bucket.hourlyCents));
  const rateNote = rateCentsUsed.size > 1
    ? 'This week uses more than one rate. Each day is paid at the rate in effect that day. The box shows the Monday rate.'
    : null;

  const dayRows = [...days.values()].map((day) => {
    const minutes = day.regularMinutes + day.otMinutes;
    const dayPunches = sortPunches(visible).filter((punch) => pacificYmd(punch.atMs) === day.date);
    let status = 'OK';
    if (day.open) status = 'In progress';
    else if (dayPunches.length === 0 && minutes === 0) status = 'Off';
    const labels = (kind) => dayPunches.filter((punch) => punch.kind === kind).map((punch) => formatTime12FromMs(punch.atMs));
    return {
      date: day.date,
      label: day.label,
      minutes,
      regularMinutes: day.regularMinutes,
      otMinutes: day.otMinutes,
      hoursLabel: `${formatHours(minutes, 2)}${status === 'In progress' ? '+' : ''}`,
      status,
      overnight: minutes > 0 && !dayPunches.some((punch) => punch.kind === 'clock_in'),
      in: labels('clock_in'),
      lunchOut: labels('lunch_out'),
      lunchIn: labels('lunch_in'),
      out: labels('clock_out'),
      punches: dayPunches.map((punch) => {
        const parts = pacificParts(new Date(punch.atMs));
        return {
          id: punch.id ?? null,
          kind: punch.kind,
          time: formatHm(parts.hour, parts.minute),
          timeLabel: formatTime12FromMs(punch.atMs),
        };
      }),
    };
  });

  return {
    week,
    days: dayRows,
    totals: {
      regularMinutes,
      otMinutes,
      totalMinutes: regularMinutes + otMinutes,
      regularPayCents,
      otPayCents,
      grossPayCents: regularPayCents + otPayCents,
      byRate,
      mondayRateCents: mondayRate ? mondayRate.hourlyCents : null,
      rateNote,
    },
  };
}

export function sincePhrase(atMs, nowMs) {
  const day = pacificYmd(atMs);
  const today = pacificYmd(nowMs);
  const time = formatTime12FromMs(atMs);
  if (day === today) return `Since ${time}`;
  if (day === addDaysYmd(today, -1)) return `Since yesterday ${time}`;
  const parsed = parseYmd(day);
  const dow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][weekdayMon0(day)];
  return `Since ${dow} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][parsed.month - 1]} ${parsed.day}, ${time}`;
}

export function elapsedLabel(minutes) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const hourText = hours === 1 ? '1 hr' : `${hours} hrs`;
  return `${hourText} ${mins} min so far`;
}

const CLOCK_LABEL = { out: 'Clocked out', in: 'Clocked in', lunch: 'At lunch' };

export function describeClock(punches, nowMs) {
  const visible = punches.filter((punch) => punch.atMs <= nowMs);
  const errors = validatePunches(visible);
  if (errors.length) {
    return {
      state: 'out',
      label: 'Needs review',
      sinceLabel: errors[0],
      elapsedLabel: null,
      primary: { action: 'clock_in', label: 'Clock In', tone: 'in', disabled: true },
      secondary: { action: 'lunch_out', label: 'Lunch Out', disabled: true },
    };
  }
  const walked = walkPunches(visible, nowMs);
  let sinceLabel = 'No punches yet';
  let elapsed = null;
  if (walked.state === 'out' && walked.lastOutAt != null) {
    sinceLabel = sincePhrase(walked.lastOutAt, nowMs);
  } else if (walked.state !== 'out' && walked.shiftStart != null) {
    elapsed = Math.floor(walked.shiftPaidMs / 60000);
    sinceLabel = `${sincePhrase(walked.shiftStart, nowMs)} · ${elapsedLabel(elapsed)}`;
  }
  const primary = walked.state === 'out'
    ? { action: 'clock_in', label: 'Clock In', tone: 'in', disabled: false }
    : { action: 'clock_out', label: 'Clock Out', tone: 'out', disabled: false };
  const secondary = walked.state === 'lunch'
    ? { action: 'lunch_in', label: 'Lunch In', disabled: false }
    : { action: 'lunch_out', label: 'Lunch Out', disabled: walked.state !== 'in' };
  return {
    state: walked.state,
    label: CLOCK_LABEL[walked.state],
    sinceLabel,
    elapsedLabel: elapsed == null ? null : elapsedLabel(elapsed),
    primary,
    secondary,
  };
}

export function buildEmployeeView({ punches, rates, nowMs }) {
  const week = payWeekContaining(nowMs);
  const view = buildWeekView({ punches, rates, weekStartYmd: week.start, asOfMs: nowMs });
  const clock = describeClock(punches, nowMs);
  const today = pacificYmd(nowMs);
  const todayRow = view.days.find((day) => day.date === today);
  return {
    todayLabel: formatLongDate(today),
    status: clock,
    week: {
      start: view.week.start,
      end: view.week.end,
      label: view.week.label,
      payLabel: view.week.payLabel,
      hoursLabel: `${formatHours(view.totals.totalMinutes, 1)} hrs`,
    },
    todayPunches: (todayRow ? todayRow.punches : []).map((punch) => ({
      kind: punch.kind,
      badge: punch.kind === 'lunch_out' ? 'LUNCH' : punch.kind === 'clock_out' ? 'OUT' : 'IN',
      badgeClass: punch.kind === 'lunch_out' ? 'lunch' : punch.kind === 'clock_out' ? 'out' : 'in',
      label: {
        clock_in: 'Clock In',
        clock_out: 'Clock Out',
        lunch_out: 'Lunch Out',
        lunch_in: 'Lunch In',
      }[punch.kind],
      timeLabel: punch.timeLabel,
    })),
  };
}

export function localTimeOnDate(dateYmd, hhmm) {
  const parsed = parseYmd(dateYmd);
  const match = /^(\d{2}):(\d{2})$/.exec(hhmm || '');
  if (!parsed || !match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return pacificLocalToUtc(parsed.year, parsed.month, parsed.day, hour, minute);
}
