import test from "node:test";
import assert from "node:assert/strict";
import {
  cutoffForWeek,
  isFinalCaptureWindow,
  publishedSettlementFor,
  seasonEndForWeeks,
  seasonSettlementWeeks,
  settlementDateFor,
  weekWindow
} from "../src/domain/calendar.js";
import { parsePlayerList, parseTopFiveResponse } from "../src/domain/players.js";
import { calculateStandings } from "../src/domain/stats.js";

const arena = {
  key: "classic",
  settlementWeekday: 4,
  settlementTime: "21:00:00",
  rankingUpdateWeekday: 5,
  rankingUpdateTime: "05:00:00",
  zones: [{ index: 0, serverZoneId: 53, name: "生命战区" }]
};

test("weekly calendar maps Friday through Thursday to the same settlement", () => {
  assert.equal(settlementDateFor(new Date("2026-04-03T04:00:00Z"), arena, 480), "2026-04-09");
  assert.equal(settlementDateFor(new Date("2026-04-09T12:59:00Z"), arena, 480), "2026-04-09");
  assert.equal(cutoffForWeek("2026-04-09", arena, 480).toISOString(), "2026-04-09T13:00:00.000Z");
  assert.equal(weekWindow("2026-04-09", arena, 480).start.toISOString(), "2026-04-02T16:00:00.000Z");
  assert.equal(isFinalCaptureWindow(new Date("2026-04-09T12:50:00Z"), arena, 15, 3, 480), false);
  assert.equal(isFinalCaptureWindow(new Date("2026-04-09T20:50:00Z"), arena, 15, 3, 480), true);
  assert.equal(publishedSettlementFor(new Date("2026-07-16T20:59:59Z"), arena, 480).weekKey, "2026-07-09");
  assert.equal(publishedSettlementFor(new Date("2026-07-16T21:00:00Z"), arena, 480).weekKey, "2026-07-16");
  assert.equal(publishedSettlementFor(new Date("2026-07-18T15:00:00Z"), arena, 480).weekKey, "2026-07-16");
});

test("Top 5 parser decodes player fields and zone fallback metadata", () => {
  const raw = [
    "1|10001|星河|1;2|3|7|九霄|2|card|320000",
    "2|10002|逐风|1;3|0|0|||card2|280000"
  ].join("#");
  const list = parsePlayerList(raw);
  assert.equal(list[0].nickname, "星河");
  assert.equal(list[0].unionName, "九霄");
  assert.equal(list[1].unionName, "未加入联盟");
  const zones = parseTopFiveResponse({ r: 1, zl: [{ ext10: raw }] }, arena);
  assert.equal(zones[0].serverZoneId, 53);
  assert.equal(zones[0].players.length, 2);
});

test("hall candidates use emperor count then longest consecutive streak", () => {
  const weeks = ["2026-04-02", "2026-04-09", "2026-04-16", "2026-04-23"]
    .map((weekKey) => ({ weekKey }));
  const appearances = {
    A: [0, 1, 2],
    B: [0, 1, 2],
    C: [0, 2, 3]
  };
  const rows = Object.entries(appearances).flatMap(([playerId, indices]) => indices.map((index) => ({
    playerId,
    nickname: playerId,
    unionName: "联盟",
    weekKey: weeks[index].weekKey,
    arenaKey: "classic",
    zoneIndex: 0,
    rank: 1,
    capturedAt: `${weeks[index].weekKey}T13:00:00.000Z`
  })));
  const result = calculateStandings(rows, weeks);
  assert.deepEqual(result.candidates.map((player) => player.playerId), ["A", "B"]);
  assert.equal(result.standings.find((player) => player.playerId === "C").longestStreak, 2);
});

test("missing settlement weeks break emperor streaks", () => {
  const weeks = ["2026-04-02", "2026-04-09", "2026-04-16"].map((weekKey) => ({ weekKey }));
  const rows = [weeks[0], weeks[2]].map((week, index) => ({
    playerId: "player-1",
    nickname: "玩家",
    unionName: "未加入联盟",
    weekKey: week.weekKey,
    arenaKey: "classic",
    zoneIndex: 0,
    rank: index + 1,
    capturedAt: `${week.weekKey}T13:00:00.000Z`
  }));
  const result = calculateStandings(rows, [weeks[0], weeks[2]], [
    weeks[0],
    { weekKey: weeks[1].weekKey, status: "missing" },
    weeks[2]
  ]);
  assert.equal(result.standings[0].emperorCount, 2);
  assert.equal(result.standings[0].longestStreak, 1);
  assert.equal(result.standings[0].currentStreak, 1);
});

test("emperor streaks reset when a new season begins", () => {
  const weeks = [
    { seasonId: "29", weekKey: "2026-04-23" },
    { seasonId: "29", weekKey: "2026-04-30" },
    { seasonId: "30", weekKey: "2026-05-07" },
    { seasonId: "30", weekKey: "2026-05-14" }
  ];
  const rows = weeks.map((week) => ({
    ...week,
    playerId: "player-1",
    nickname: "玩家",
    unionName: "联盟",
    arenaKey: "classic",
    zoneIndex: 0,
    rank: 1,
    capturedAt: `${week.weekKey}T13:00:00.000Z`
  }));

  const result = calculateStandings(rows, weeks);
  assert.equal(result.standings[0].emperorCount, 4);
  assert.equal(result.standings[0].longestStreak, 2);
  assert.equal(result.standings[0].currentStreak, 2);
});

test("fixed season weeks produce settlement dates and an end time", () => {
  const season = {
    startsAt: "2026-07-03T12:00:00+08:00",
    endsAt: "2026-07-30T21:30:00+08:00"
  };
  assert.deepEqual(seasonSettlementWeeks(season, arena, 480), [
    "2026-07-09",
    "2026-07-16",
    "2026-07-23",
    "2026-07-30"
  ]);
  assert.equal(
    seasonEndForWeeks("2026-07-03T12:00:00+08:00", 4, [arena], 480).toISOString(),
    "2026-07-30T13:00:00.000Z"
  );
});
