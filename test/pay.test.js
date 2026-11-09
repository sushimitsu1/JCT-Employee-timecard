import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWeekCsv } from '../src/csv.js';
import {
  buildWeekView,
  dollarsToCents,
  formatHours,
  payForMinutes,
} from '../src/pay.js';
import {
  pacificLocalToUtc,
  payWeekContaining,
  payWeekFromMonday,
} from '../src/time.js';
import { csvObjects } from './helpers.js';

const RATE_20 = [{ effectiveOn: '2020-01-01', hourlyCents: 2000 }];
const RATE_2250 = [{ effectiveOn: '2020-01-01', hourlyCents: 2250 }];
const AFTER = pacificLocalToUtc(2026, 11, 16, 8, 0).ms;

function at(year, month, day, hour, minute, extraMs = 0) {
  return pacificLocalToUtc(year, month, day, hour, minute).ms + extraMs;
}

let punchId = 1;
function punch(kind, atMs) {
  punchId += 1;
  return { kind, atMs, id: punchId };
}

function shift(year, month, day, start, end, lunch = null) {
  const punches = [punch('clock_in', at(year, month, day, start[0], start[1]))];
  if (lunch) {
    punches.push(punch('lunch_out', at(year, month, day, lunch[0][0], lunch[0][1])));
    punches.push(punch('lunch_in', at(year, month, day, lunch[1][0], lunch[1][1])));
  }
  punches.push(punch('clock_out', at(year, month, day, end[0], end[1], end[2] || 0)));
  return punches;
}

function viewOf(punches, rates, monday, asOf = AFTER) {
  return buildWeekView({ punches, rates, weekStartYmd: monday, asOfMs: asOf });
}

test('pay Friday is the Friday after Sunday, 11 days after Monday', () => {
  const current = payWeekFromMonday('2026-11-09');
  assert.equal(current.start, '2026-11-09');
  assert.equal(current.end, '2026-11-15');
  assert.equal(current.payDate, '2026-11-20');
  assert.notEqual(current.payDate, '2026-11-13');
  assert.equal(payWeekFromMonday('2026-11-02').payDate, '2026-11-13');
  assert.equal(payWeekContaining(at(2026, 11, 9, 12, 0)).start, '2026-11-09');
});

test('spring-forward gap and fall-back repeated hour', () => {
  const gap = pacificLocalToUtc(2026, 3, 8, 2, 30);
  assert.equal(new Date(gap.ms).toISOString(), '2026-03-08T10:00:00.000Z');
  assert.match(gap.warning, /spring forward/);
  const first = pacificLocalToUtc(2026, 11, 1, 1, 30);
  assert.equal(new Date(first.ms).toISOString(), '2026-11-01T08:30:00.000Z');
  assert.match(first.warning, /earlier/);
  const start = pacificLocalToUtc(2026, 3, 8, 1, 0);
  const end = pacificLocalToUtc(2026, 3, 8, 4, 0);
  assert.equal(end.ms - start.ms, 2 * 60 * 60 * 1000);
  const fallStart = pacificLocalToUtc(2026, 11, 1, 0, 30);
  const fallEnd = pacificLocalToUtc(2026, 11, 1, 3, 30);
  assert.equal(fallEnd.ms - fallStart.ms, 4 * 60 * 60 * 1000);
});

test('under 40: 8 hours at $20 is $160 regular and no overtime', () => {
  const totals = viewOf(shift(2026, 11, 9, [8, 0], [16, 0]), RATE_20, '2026-11-09').totals;
  assert.equal(totals.regularMinutes, 480);
  assert.equal(totals.otMinutes, 0);
  assert.equal(totals.regularPayCents, 16000);
  assert.equal(totals.otPayCents, 0);
  assert.equal(totals.grossPayCents, 16000);
});

test('exactly 40 hours has no overtime', () => {
  const punches = [9, 10, 11, 12, 13].flatMap((day) => shift(2026, 11, day, [8, 0], [16, 0]));
  const totals = viewOf(punches, RATE_20, '2026-11-09').totals;
  assert.equal(totals.regularMinutes, 2400);
  assert.equal(totals.otMinutes, 0);
  assert.equal(totals.grossPayCents, 80000);
});

test('one minute over 40 is one overtime minute', () => {
  const punches = [9, 10, 11, 12, 13].flatMap((day) => shift(2026, 11, day, [8, 0], [16, 0]));
  punches.push(...shift(2026, 11, 14, [8, 0], [8, 1]));
  const totals = viewOf(punches, RATE_20, '2026-11-09').totals;
  assert.equal(totals.regularMinutes, 2400);
  assert.equal(totals.otMinutes, 1);
  assert.equal(totals.regularPayCents, 80000);
  assert.equal(totals.otPayCents, 50);
  assert.equal(totals.grossPayCents, 80050);
});

test('over 40: 48 hours is 40 regular and 8 overtime', () => {
  const punches = [9, 10, 11, 12, 13, 14].flatMap((day) => shift(2026, 11, day, [8, 0], [16, 0]));
  const totals = viewOf(punches, RATE_20, '2026-11-09').totals;
  assert.equal(totals.regularMinutes, 2400);
  assert.equal(totals.otMinutes, 480);
  assert.equal(totals.regularPayCents, 80000);
  assert.equal(totals.otPayCents, 24000);
  assert.equal(totals.grossPayCents, 104000);
});

test('a 12-hour day is not daily overtime when the week is under 40', () => {
  const punches = [
    ...shift(2026, 11, 9, [8, 0], [20, 0]),
    ...shift(2026, 11, 10, [8, 0], [16, 0]),
    ...shift(2026, 11, 11, [8, 0], [16, 0]),
    ...shift(2026, 11, 12, [8, 0], [16, 0]),
  ];
  const totals = viewOf(punches, RATE_20, '2026-11-09').totals;
  assert.equal(totals.totalMinutes, 2160);
  assert.equal(totals.otMinutes, 0);
  assert.equal(totals.grossPayCents, 72000);
});

test('unpaid lunch is subtracted', () => {
  // 8:00 AM–5:00 PM is 9 hours on the clock. A 30-minute lunch leaves 8.5 paid hours.
  const totals = viewOf(
    shift(2026, 11, 9, [8, 0], [17, 0], [[12, 0], [12, 30]]),
    RATE_2250,
    '2026-11-09',
  ).totals;
  assert.equal(totals.totalMinutes, 510);
  assert.equal(totals.grossPayCents, 19125);
});

test('two shifts in one day are added', () => {
  const punches = [
    ...shift(2026, 11, 9, [8, 0], [12, 0]),
    ...shift(2026, 11, 9, [13, 0], [17, 30]),
  ];
  const totals = viewOf(punches, RATE_2250, '2026-11-09').totals;
  assert.equal(totals.totalMinutes, 510);
  assert.equal(totals.grossPayCents, 19125);
  assert.equal(formatHours(510, 2), '8.50');
});

test('midnight crossing stays in one pay week and splits the calendar days', () => {
  const punches = [
    punch('clock_in', at(2026, 11, 11, 22, 0)),
    punch('clock_out', at(2026, 11, 12, 6, 0)),
  ];
  const view = viewOf(punches, RATE_20, '2026-11-09');
  assert.equal(view.totals.totalMinutes, 480);
  assert.equal(view.totals.grossPayCents, 16000);
  assert.equal(view.days.find((day) => day.date === '2026-11-11').minutes, 120);
  assert.equal(view.days.find((day) => day.date === '2026-11-12').minutes, 360);
});

test('Sunday night into Monday splits across pay weeks', () => {
  const punches = [
    punch('clock_in', at(2026, 11, 8, 22, 0)),
    punch('clock_out', at(2026, 11, 9, 6, 0)),
  ];
  const first = viewOf(punches, RATE_20, '2026-11-02');
  const second = viewOf(punches, RATE_20, '2026-11-09');
  assert.equal(first.totals.totalMinutes, 120);
  assert.equal(first.totals.grossPayCents, 4000);
  assert.equal(first.days.find((day) => day.date === '2026-11-08').minutes, 120);
  assert.equal(second.totals.totalMinutes, 360);
  assert.equal(second.totals.grossPayCents, 12000);
  assert.equal(second.days.find((day) => day.date === '2026-11-09').minutes, 360);
});

test('DST spring-forward week pays real elapsed time, not the clock difference', () => {
  const punches = [
    punch('clock_in', at(2026, 3, 8, 1, 0)),
    punch('clock_out', at(2026, 3, 8, 4, 0)),
  ];
  const totals = viewOf(punches, RATE_20, '2026-03-02', at(2026, 3, 9, 12, 0)).totals;
  assert.equal(totals.totalMinutes, 120);
  assert.equal(totals.grossPayCents, 4000);
});

test('DST fall-back week pays the extra real hour', () => {
  const punches = [
    punch('clock_in', at(2026, 11, 1, 0, 30)),
    punch('clock_out', at(2026, 11, 1, 3, 30)),
  ];
  const totals = viewOf(punches, RATE_20, '2026-10-26', at(2026, 11, 2, 12, 0)).totals;
  assert.equal(totals.totalMinutes, 240);
  assert.equal(totals.grossPayCents, 8000);
});

test('a past week uses the rate that was in effect then', () => {
  const rates = [
    { effectiveOn: '2025-01-01', hourlyCents: 2000 },
    { effectiveOn: '2026-01-01', hourlyCents: 2250 },
  ];
  const sample = payWeekContaining(at(2025, 6, 15, 12, 0));
  const monday = sample.start.split('-').map(Number);
  const punches = shift(monday[0], monday[1], monday[2], [8, 0], [16, 0]);
  const totals = viewOf(punches, rates, sample.start, at(2025, 6, 22, 12, 0)).totals;
  assert.equal(totals.mondayRateCents, 2000);
  assert.equal(totals.grossPayCents, 16000);
});

test('a rate that changes on Thursday splits regular and overtime pay', () => {
  const rates = [
    { effectiveOn: '2020-01-01', hourlyCents: 2000 },
    { effectiveOn: '2026-11-12', hourlyCents: 3000 },
  ];
  const punches = [9, 10, 11, 12, 13, 14].flatMap((day) => shift(2026, 11, day, [8, 0], [16, 0]));
  const view = viewOf(punches, rates, '2026-11-09');
  assert.equal(view.totals.regularMinutes, 2400);
  assert.equal(view.totals.otMinutes, 480);
  assert.equal(view.totals.regularPayCents, 96000);
  assert.equal(view.totals.otPayCents, 36000);
  assert.equal(view.totals.grossPayCents, 132000);
  assert.equal(view.totals.byRate.length, 2);
  assert.equal(view.totals.mondayRateCents, 2000);
});

test('half-up rounding: 7 minutes at $22.50 is $2.63', () => {
  const totals = viewOf(shift(2026, 11, 9, [8, 0], [8, 7]), RATE_2250, '2026-11-09').totals;
  assert.equal(totals.totalMinutes, 7);
  assert.equal(payForMinutes(7, 2250, 'regular'), 263);
  assert.equal(totals.grossPayCents, 263);
});

test('one overtime minute at $22.50 rounds 56.25 cents down to 56', () => {
  const punches = [9, 10, 11, 12, 13].flatMap((day) => shift(2026, 11, day, [8, 0], [16, 0]));
  punches.push(...shift(2026, 11, 14, [8, 0], [8, 1]));
  const totals = viewOf(punches, RATE_2250, '2026-11-09').totals;
  assert.equal(totals.regularPayCents, 90000);
  assert.equal(totals.otPayCents, 56);
  assert.equal(totals.grossPayCents, 90056);
});

test('a half cent rounds up, and same-rate minutes are pooled before rounding', () => {
  const one = viewOf(shift(2026, 11, 9, [8, 0], [8, 1]), [{ effectiveOn: '2020-01-01', hourlyCents: 30 }], '2026-11-09');
  assert.equal(one.totals.grossPayCents, 1);
  const two = viewOf(
    [...shift(2026, 11, 9, [8, 0], [8, 1]), ...shift(2026, 11, 9, [9, 0], [9, 1])],
    [{ effectiveOn: '2020-01-01', hourlyCents: 30 }],
    '2026-11-09',
  );
  assert.equal(two.totals.totalMinutes, 2);
  assert.equal(two.totals.grossPayCents, 1);
});

test('an open shift counts until as-of and is marked in progress', () => {
  const punches = [punch('clock_in', at(2026, 11, 9, 8, 0))];
  const view = viewOf(punches, RATE_20, '2026-11-09', at(2026, 11, 9, 10, 30));
  assert.equal(view.totals.totalMinutes, 150);
  assert.equal(view.totals.grossPayCents, 5000);
  const monday = view.days.find((day) => day.date === '2026-11-09');
  assert.equal(monday.status, 'In progress');
  assert.equal(monday.hoursLabel, '2.50+');
});

test('clocking out while still at lunch does not pay the lunch', () => {
  const punches = [
    punch('clock_in', at(2026, 11, 9, 8, 0)),
    punch('lunch_out', at(2026, 11, 9, 12, 0)),
    punch('clock_out', at(2026, 11, 9, 12, 20)),
  ];
  const totals = viewOf(punches, RATE_20, '2026-11-09').totals;
  assert.equal(totals.totalMinutes, 240);
  assert.equal(totals.grossPayCents, 8000);
});

test('a shift under one minute pays nothing, and a brand-new open shift still renders', () => {
  const closed = viewOf([
    punch('clock_in', at(2026, 11, 9, 8, 0)),
    punch('clock_out', at(2026, 11, 9, 8, 0, 20000)),
  ], RATE_20, '2026-11-09');
  assert.equal(closed.totals.totalMinutes, 0);
  const start = at(2026, 11, 9, 8, 0);
  const open = viewOf([punch('clock_in', start)], RATE_20, '2026-11-09', start + 5000);
  assert.equal(open.totals.totalMinutes, 0);
  assert.equal(open.days.find((day) => day.date === '2026-11-09').status, 'In progress');
  assert.equal(open.days.find((day) => day.date === '2026-11-09').hoursLabel, '0.00+');
});

test('leftover seconds are dropped, not rounded up to a minute', () => {
  const punches = [
    punch('clock_in', at(2026, 11, 9, 8, 0, 30000)),
    punch('clock_out', at(2026, 11, 9, 8, 2, 20000)),
  ];
  const totals = viewOf(punches, RATE_20, '2026-11-09').totals;
  assert.equal(totals.totalMinutes, 1);
});

test('double clock-in and clock-out without clock-in are rejected', () => {
  assert.throws(
    () => viewOf([
      punch('clock_in', at(2026, 11, 9, 8, 0)),
      punch('clock_in', at(2026, 11, 9, 9, 0)),
    ], RATE_20, '2026-11-09'),
    /Already clocked in/,
  );
  assert.throws(
    () => viewOf([punch('clock_out', at(2026, 11, 9, 16, 0))], RATE_20, '2026-11-09'),
    /Can't clock out before clocking in/,
  );
});

test('dollars convert to integer cents without binary float error', () => {
  assert.equal(dollarsToCents('22.50'), 2250);
  assert.equal(dollarsToCents('22.5'), 2250);
  assert.equal(dollarsToCents('0.30'), 30);
  assert.equal(dollarsToCents('22.505'), null);
  assert.equal(dollarsToCents('-1'), null);
});

test('CSV lists the week, each day, punches, rate, and pay', () => {
  const built = viewOf(
    shift(2026, 11, 9, [8, 0], [16, 30], [[12, 0], [12, 30]]),
    RATE_2250,
    '2026-11-09',
  );
  const csv = buildWeekCsv(built, 'Sample Employee');
  const rows = csvObjects(csv);
  const summary = rows.find((row) => row.row_type === 'summary');
  assert.equal(summary.employee, 'Sample Employee');
  assert.equal(summary.week_start, '2026-11-09');
  assert.equal(summary.week_end, '2026-11-15');
  assert.equal(summary.pay_date, '2026-11-20');
  assert.equal(summary.regular_hours, '8.00');
  assert.equal(summary.ot_hours, '0.00');
  assert.equal(summary.hourly_rate, '22.50');
  assert.equal(summary.regular_pay, '180.00');
  assert.equal(summary.ot_pay, '0.00');
  assert.equal(summary.gross_pay, '180.00');
  const rate = rows.find((row) => row.row_type === 'rate');
  assert.equal(rate.hourly_rate, '22.50');
  assert.equal(rate.gross_pay, '180.00');
  const days = rows.filter((row) => row.row_type === 'day');
  assert.equal(days.length, 7);
  assert.deepEqual(days.map((row) => row.day), [
    '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15',
  ]);
  assert.equal(days[0].day_minutes, '480');
  assert.equal(days[0].day_hours, '8.00');
  assert.equal(days[0].status, 'OK');
  assert.equal(days[1].status, 'Off');
  const punches = rows.filter((row) => row.row_type === 'punch');
  assert.deepEqual(punches.map((row) => row.punch_kind), ['clock_in', 'lunch_out', 'lunch_in', 'clock_out']);
  assert.equal(punches[0].punch_time_pacific, '2026-11-09 8:00 AM');
  assert.equal(punches[3].punch_time_pacific, '2026-11-09 4:30 PM');

  const mixed = viewOf(
    [9, 10, 11, 12, 13, 14].flatMap((day) => shift(2026, 11, day, [8, 0], [16, 0])),
    [
      { effectiveOn: '2020-01-01', hourlyCents: 2000 },
      { effectiveOn: '2026-11-12', hourlyCents: 3000 },
    ],
    '2026-11-09',
  );
  const mixedRows = csvObjects(buildWeekCsv(mixed, 'Sample, Employee'));
  assert.equal(mixedRows[0].employee, 'Sample, Employee');
  assert.equal(mixedRows.find((row) => row.row_type === 'summary').gross_pay, '1320.00');
  assert.equal(mixedRows.find((row) => row.row_type === 'summary').hourly_rate, 'mixed');
  const rateRows = mixedRows.filter((row) => row.row_type === 'rate');
  assert.deepEqual(rateRows.map((row) => row.hourly_rate), ['20.00', '30.00']);
  assert.equal(rateRows[0].regular_pay, '480.00');
  assert.equal(rateRows[1].regular_pay, '480.00');
  assert.equal(rateRows[1].ot_pay, '360.00');
  assert.match(buildWeekCsv(mixed, 'Sample, Employee'), /"Sample, Employee"/);
});
