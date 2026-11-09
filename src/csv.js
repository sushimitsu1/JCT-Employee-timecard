// One CSV per employee per Monday–Sunday pay week.
// Money columns are dollars with two decimals (not cents). Hours are display
// hours; day_minutes / regular_minutes / ot_minutes are the integer minutes
// the pay math actually uses.

import { centsToDollars, formatHours } from './pay.js';

export const CSV_COLUMNS = [
  'employee',
  'week_start',
  'week_end',
  'pay_date',
  'row_type',
  'day',
  'status',
  'punch_kind',
  'punch_time_pacific',
  'day_minutes',
  'day_hours',
  'day_regular_minutes',
  'day_ot_minutes',
  'regular_minutes',
  'regular_hours',
  'ot_minutes',
  'ot_hours',
  'hourly_rate',
  'regular_pay',
  'ot_pay',
  'gross_pay',
];

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function line(fields) {
  const row = Object.fromEntries(CSV_COLUMNS.map((column) => [column, '']));
  Object.assign(row, fields);
  return CSV_COLUMNS.map((column) => csvEscape(row[column])).join(',');
}

export function buildWeekCsv(view, employeeName) {
  const base = {
    employee: employeeName,
    week_start: view.week.start,
    week_end: view.week.end,
    pay_date: view.week.payDate,
  };
  const totals = view.totals;
  const lines = [
    line({
      ...base,
      row_type: 'summary',
      regular_minutes: totals.regularMinutes,
      regular_hours: formatHours(totals.regularMinutes, 2),
      ot_minutes: totals.otMinutes,
      ot_hours: formatHours(totals.otMinutes, 2),
      hourly_rate: totals.byRate.length === 1 ? centsToDollars(totals.byRate[0].hourlyCents) : totals.byRate.length > 1 ? 'mixed' : '',
      regular_pay: centsToDollars(totals.regularPayCents),
      ot_pay: centsToDollars(totals.otPayCents),
      gross_pay: centsToDollars(totals.grossPayCents),
    }),
  ];
  for (const rate of totals.byRate) {
    lines.push(line({
      ...base,
      row_type: 'rate',
      regular_minutes: rate.regularMinutes,
      regular_hours: formatHours(rate.regularMinutes, 2),
      ot_minutes: rate.otMinutes,
      ot_hours: formatHours(rate.otMinutes, 2),
      hourly_rate: centsToDollars(rate.hourlyCents),
      regular_pay: centsToDollars(rate.regularPayCents),
      ot_pay: centsToDollars(rate.otPayCents),
      gross_pay: centsToDollars(rate.grossPayCents),
    }));
  }
  for (const day of view.days) {
    lines.push(line({
      ...base,
      row_type: 'day',
      day: day.date,
      status: day.status,
      day_minutes: day.minutes,
      day_hours: day.hoursLabel,
      day_regular_minutes: day.regularMinutes,
      day_ot_minutes: day.otMinutes,
    }));
    for (const punch of day.punches) {
      lines.push(line({
        ...base,
        row_type: 'punch',
        day: day.date,
        punch_kind: punch.kind,
        punch_time_pacific: `${day.date} ${punch.timeLabel}`,
      }));
    }
  }
  return `${CSV_COLUMNS.join(',')}\n${lines.join('\n')}\n`;
}
