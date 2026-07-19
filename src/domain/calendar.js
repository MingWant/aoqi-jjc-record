const DAY_MS = 24 * 60 * 60 * 1000;

export function parseClock(value) {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value ?? "");
  if (!match) throw new Error(`Invalid clock value: ${value}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? 0);
  if (hour > 23 || minute > 59 || second > 59) {
    throw new Error(`Invalid clock value: ${value}`);
  }
  return { hour, minute, second, totalSeconds: hour * 3600 + minute * 60 + second };
}

export function localParts(date, utcOffsetMinutes = 480) {
  const shifted = new Date(date.getTime() + utcOffsetMinutes * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds()
  };
}

export function localDateToUtc(parts, utcOffsetMinutes = 480) {
  return new Date(Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0
  ) - utcOffsetMinutes * 60_000);
}

export function dateKey(date, utcOffsetMinutes = 480) {
  const p = localParts(date, utcOffsetMinutes);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function parseDateKey(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!match) throw new Error(`Invalid date key: ${value}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

export function addLocalDays(value, days, utcOffsetMinutes = 480) {
  const base = typeof value === "string"
    ? localDateToUtc(parseDateKey(value), utcOffsetMinutes)
    : value;
  return dateKey(new Date(base.getTime() + days * DAY_MS), utcOffsetMinutes);
}

export function settlementDateFor(date, arena, utcOffsetMinutes = 480) {
  const local = localParts(date, utcOffsetMinutes);
  const targetWeekday = arena.settlementWeekday ?? 4;
  const daysUntil = (targetWeekday - local.weekday + 7) % 7;
  return addLocalDays(dateKey(date, utcOffsetMinutes), daysUntil, utcOffsetMinutes);
}

export function rankingUpdateFor(date, arena, utcOffsetMinutes = 480) {
  const local = localParts(date, utcOffsetMinutes);
  const targetWeekday = arena.rankingUpdateWeekday ?? 5;
  const daysUntil = (targetWeekday - local.weekday + 7) % 7;
  const updateKey = addLocalDays(dateKey(date, utcOffsetMinutes), daysUntil, utcOffsetMinutes);
  const clock = parseClock(arena.rankingUpdateTime ?? "05:00:00");
  return localDateToUtc({ ...parseDateKey(updateKey), ...clock }, utcOffsetMinutes);
}

export function publishedSettlementFor(date, arena, utcOffsetMinutes = 480) {
  let publishedAt = rankingUpdateFor(date, arena, utcOffsetMinutes);
  if (date.getTime() < publishedAt.getTime()) {
    publishedAt = new Date(publishedAt.getTime() - 7 * DAY_MS);
  }
  const updateWeekday = arena.rankingUpdateWeekday ?? 5;
  const settlementWeekday = arena.settlementWeekday ?? 4;
  const daysAfterSettlement = (updateWeekday - settlementWeekday + 7) % 7;
  const publishedKey = dateKey(publishedAt, utcOffsetMinutes);
  return {
    weekKey: addLocalDays(publishedKey, -daysAfterSettlement, utcOffsetMinutes),
    publishedAt
  };
}

export function cutoffForWeek(weekKey, arena, utcOffsetMinutes = 480) {
  const date = parseDateKey(weekKey);
  const clock = parseClock(arena.settlementTime);
  return localDateToUtc({ ...date, ...clock }, utcOffsetMinutes);
}

export function weekWindow(weekKey, arena, utcOffsetMinutes = 480) {
  const cutoff = cutoffForWeek(weekKey, arena, utcOffsetMinutes);
  const startKey = addLocalDays(weekKey, -6, utcOffsetMinutes);
  const start = localDateToUtc(parseDateKey(startKey), utcOffsetMinutes);
  return { start, cutoff };
}

export function isFinalCaptureWindow(date, arena, windowMinutes, graceMinutes, utcOffsetMinutes = 480) {
  const update = rankingUpdateFor(date, arena, utcOffsetMinutes);
  const start = update.getTime() - windowMinutes * 60_000;
  const end = update.getTime() + graceMinutes * 60_000;
  return date.getTime() >= start && date.getTime() <= end;
}

export function isSettlementReady(date, arena, graceMinutes, utcOffsetMinutes = 480) {
  const weekKey = settlementDateFor(date, arena, utcOffsetMinutes);
  const cutoff = cutoffForWeek(weekKey, arena, utcOffsetMinutes);
  return {
    ready: date.getTime() >= cutoff.getTime() + graceMinutes * 60_000,
    weekKey,
    cutoff
  };
}

export function formatOffsetDate(date, utcOffsetMinutes = 480) {
  const p = localParts(date, utcOffsetMinutes);
  const sign = utcOffsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(utcOffsetMinutes);
  const offset = `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}T${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}:${String(p.second).padStart(2, "0")}${offset}`;
}

function requiredDate(value, label) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} is invalid`);
  return date;
}

export function seasonSettlementWeeks(season, arena, utcOffsetMinutes = 480, now = new Date()) {
  const start = requiredDate(season?.startsAt, "Season start");
  const current = requiredDate(now, "Current time");
  const end = season?.endsAt ? requiredDate(season.endsAt, "Season end") : current;
  if (end.getTime() < start.getTime()) return [];

  let weekKey = settlementDateFor(start, arena, utcOffsetMinutes);
  let cutoff = cutoffForWeek(weekKey, arena, utcOffsetMinutes);
  if (cutoff.getTime() < start.getTime()) {
    weekKey = addLocalDays(weekKey, 7, utcOffsetMinutes);
    cutoff = cutoffForWeek(weekKey, arena, utcOffsetMinutes);
  }

  const result = [];
  for (let guard = 0; guard < 5200 && cutoff.getTime() <= end.getTime(); guard += 1) {
    result.push(weekKey);
    weekKey = addLocalDays(weekKey, 7, utcOffsetMinutes);
    cutoff = cutoffForWeek(weekKey, arena, utcOffsetMinutes);
  }
  return result;
}

export function seasonEndForWeeks(startsAt, weeks, arenas, utcOffsetMinutes = 480) {
  const count = Number(weeks);
  if (!Number.isInteger(count) || count < 1 || count > 5200) {
    throw new Error("Season weeks must be an integer between 1 and 5200");
  }
  const configured = Array.isArray(arenas) ? arenas.filter(Boolean) : [arenas].filter(Boolean);
  if (!configured.length) throw new Error("At least one arena is required to calculate season weeks");
  const start = requiredDate(startsAt, "Season start");
  const cutoffs = configured.map((arena) => {
    let weekKey = settlementDateFor(start, arena, utcOffsetMinutes);
    const cutoff = cutoffForWeek(weekKey, arena, utcOffsetMinutes);
    if (cutoff.getTime() < start.getTime()) weekKey = addLocalDays(weekKey, 7, utcOffsetMinutes);
    weekKey = addLocalDays(weekKey, (count - 1) * 7, utcOffsetMinutes);
    return cutoffForWeek(weekKey, arena, utcOffsetMinutes);
  });
  return new Date(Math.max(...cutoffs.map((date) => date.getTime())));
}
