import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../src/config.js";
import { seedDemoData } from "../src/demo-data.js";
import { Storage } from "../src/storage.js";

test("legacy season tables gain the planned weeks column on startup", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "arena-tracker-migration-"));
  const dataFile = path.join(directory, "legacy.sqlite");
  const legacy = new DatabaseSync(dataFile);
  legacy.exec(`
    CREATE TABLE seasons (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      ends_at TEXT,
      active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `);
  legacy.prepare(`
    INSERT INTO seasons(id, label, starts_at, ends_at, active, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    "31",
    "第31届",
    "2026-05-01T04:00:00.000Z",
    "2026-05-28T13:30:00.000Z",
    1,
    "2026-05-01T04:00:00.000Z"
  );
  legacy.close();

  let storage;
  try {
    const config = loadConfig({ dataFile, initialSeason: null });
    storage = new Storage(config);
    const columns = storage.db.prepare("PRAGMA table_info(seasons)").all().map((column) => column.name);
    assert.equal(columns.includes("planned_weeks"), true);
    assert.equal(storage.getSeason("31").plannedWeeks, null);
  } finally {
    storage?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a snapshot missing a configured zone remains partial", () => {
  const config = loadConfig({ dataFile: ":memory:" });
  const storage = new Storage(config);
  const arena = config.arenas.find((item) => item.key === "classic");
  const zones = arena.zones.slice(0, -1).map((zone) => ({
    ...zone,
    players: [1, 2, 3, 4, 5].map((rank) => ({
      rank,
      playerId: `${zone.serverZoneId}-${rank}`,
      nickname: `${zone.name}${rank}`,
      unionId: 0,
      unionName: "未加入联盟"
    }))
  }));

  try {
    const snapshotId = storage.saveSnapshot({
      arena,
      capturedAt: new Date("2026-07-17T05:00:00.000Z"),
      zones,
      source: "test"
    });
    const snapshot = storage.getSnapshot(snapshotId);
    const settlement = storage.finalizeWeek({
      arena,
      weekKey: "2026-07-16",
      seasonId: "32",
      snapshotId
    });
    assert.equal(snapshot.entryCount, 10);
    assert.equal(snapshot.expectedEntryCount, 15);
    assert.equal(settlement.status, "partial");
  } finally {
    storage.close();
  }
});

test("snapshot cleanup deletes only old snapshots not referenced by settlements", () => {
  const config = loadConfig({ dataFile: ":memory:" });
  const storage = new Storage(config);
  const arena = config.arenas.find((item) => item.key === "classic");
  const zones = [{
    ...arena.zones[0],
    players: [{
      rank: 1,
      playerId: "cleanup-player",
      nickname: "清理测试玩家",
      unionId: 0,
      unionName: "未加入联盟"
    }]
  }];

  try {
    storage.createSeason({
      id: "31",
      label: "第31届",
      startsAt: "2026-05-29T12:00:00+08:00",
      endsAt: "2026-07-02T23:59:59+08:00"
    });
    const referencedId = storage.saveSnapshot({
      arena,
      capturedAt: new Date("2026-06-26T05:00:00.000Z"),
      zones,
      source: "test"
    });
    storage.finalizeWeek({ arena, weekKey: "2026-06-25", seasonId: "31", snapshotId: referencedId });
    const unreferencedId = storage.saveSnapshot({
      arena,
      capturedAt: new Date("2026-06-26T06:00:00.000Z"),
      zones,
      source: "test"
    });
    const recentId = storage.saveSnapshot({
      arena,
      capturedAt: new Date("2026-07-20T06:00:00.000Z"),
      zones,
      source: "test"
    });

    const deleted = storage.cleanupSnapshots({ before: new Date("2026-07-01T00:00:00.000Z") });
    assert.equal(deleted, 1);
    assert.notEqual(storage.getSnapshot(referencedId), null);
    assert.equal(storage.getSnapshot(unreferencedId), null);
    assert.notEqual(storage.getSnapshot(recentId), null);
    assert.equal(storage.db.prepare("SELECT COUNT(*) count FROM rank_entries WHERE snapshot_id = ?").get(unreferencedId).count, 0);
  } finally {
    storage.close();
  }
});

test("demo snapshots use the configured zones and independent arena standings", () => {
  const config = loadConfig({ dataFile: ":memory:", demoMode: true });
  const storage = new Storage(config);
  try {
    const seeded = seedDemoData(storage, config);
    assert.equal(seeded.snapshotCount, 28);
    const classic = storage.seasonStats("29", "classic");
    assert.equal(classic.finalizedWeekCount, 6);
    assert.equal(classic.seatCount, 90);
    assert.equal(classic.candidates[0].playerId, "10001");
    assert.equal(classic.candidates[0].longestStreak, 6);
    const hall = storage.hallStats({ throughSeasonId: "29", arenaKey: "classic", window: 3 });
    assert.deepEqual(hall.seasons.map((season) => season.id), ["29"]);
    assert.equal(hall.finalizedWeekCount, 6);
  } finally {
    storage.close();
  }
});

test("hall standings use fixed three-season cycles from season 29", () => {
  const config = loadConfig({ dataFile: ":memory:" });
  const storage = new Storage(config);
  try {
    const starts = [
      ["28", "2026-02-20T12:00:00+08:00"],
      ["29", "2026-03-27T12:00:00+08:00"],
      ["30", "2026-05-01T12:00:00+08:00"],
      ["31", "2026-05-29T12:00:00+08:00"],
      ["32", "2026-07-03T12:00:00+08:00"],
      ["33", "2026-08-07T12:00:00+08:00"],
      ["34", "2026-09-11T12:00:00+08:00"]
    ];
    for (const [id, startsAt] of starts) {
      storage.createSeason({ id, label: `第${id}届`, startsAt });
    }

    const seasonIds = (throughSeasonId, window = 3) => storage
      .hallStats({ throughSeasonId, arenaKey: "classic", window })
      .seasons.map((season) => season.id);

    assert.deepEqual(seasonIds("28"), ["28"]);
    assert.deepEqual(seasonIds("29"), ["29"]);
    assert.deepEqual(seasonIds("31"), ["29", "30", "31"]);
    assert.deepEqual(seasonIds("32"), ["32"]);
    assert.deepEqual(seasonIds("34"), ["32", "33", "34"]);
    assert.deepEqual(seasonIds("34", 1), ["34"]);
  } finally {
    storage.close();
  }
});

test("hall streaks restart at each season boundary", () => {
  const config = loadConfig({ dataFile: ":memory:" });
  const storage = new Storage(config);
  const arena = config.arenas.find((item) => item.key === "classic");
  const zones = [
    {
      ...arena.zones[0],
      players: [{
        rank: 1,
        playerId: "season-streak-player",
        nickname: "跨届玩家",
        unionId: 0,
        unionName: "未加入联盟",
        clothes: "",
        vipLevel: 0,
        unionIcon: 0,
        nicknameCard: ""
      }]
    }
  ];

  try {
    storage.createSeason({
      id: "29",
      label: "第29届",
      startsAt: "2026-04-17T12:00:00+08:00",
      endsAt: "2026-04-30T21:00:00+08:00"
    });
    storage.createSeason({
      id: "30",
      label: "第30届",
      startsAt: "2026-05-01T12:00:00+08:00",
      endsAt: "2026-05-14T21:00:00+08:00"
    });

    for (const [seasonId, weekKeys] of [
      ["29", ["2026-04-23", "2026-04-30"]],
      ["30", ["2026-05-07", "2026-05-14"]]
    ]) {
      for (const weekKey of weekKeys) {
        const capturedAt = new Date(`${weekKey}T14:00:00.000Z`);
        const snapshotId = storage.saveSnapshot({ arena, capturedAt, zones, source: "test" });
        storage.finalizeWeek({ arena, weekKey, seasonId, snapshotId, finalizedAt: capturedAt });
      }
    }

    const hall = storage.hallStats({ throughSeasonId: "30", arenaKey: "classic", window: 3 });
    const standing = hall.standings.find((player) => player.playerId === "season-streak-player");
    assert.equal(standing.emperorCount, 4);
    assert.equal(standing.longestStreak, 2);
    assert.equal(standing.currentStreak, 2);
  } finally {
    storage.close();
  }
});

test("player and union labels remain stable when game names change", () => {
  const config = loadConfig({ dataFile: ":memory:" });
  const storage = new Storage(config);
  const arena = config.arenas.find((item) => item.key === "classic");
  const ranking = (nickname, unionName) => [{
    ...arena.zones[0],
    players: [{
      rank: 1,
      playerId: "90001",
      nickname,
      unionId: 7001,
      unionName,
      clothes: "",
      vipLevel: 0,
      unionIcon: 0,
      nicknameCard: "",
      power: 999999
    }]
  }];

  try {
    const firstSnapshot = storage.saveSnapshot({
      arena,
      capturedAt: new Date("2026-07-10T05:00:00.000Z"),
      zones: ranking("初见昵称", "初见联盟"),
      source: "test"
    });
    storage.finalizeWeek({ arena, weekKey: "2026-07-09", seasonId: "32", snapshotId: firstSnapshot });

    const renamedSnapshot = storage.saveSnapshot({
      arena,
      capturedAt: new Date("2026-07-17T05:00:00.000Z"),
      zones: ranking("游戏改名后", "联盟改名后"),
      source: "test"
    });
    storage.finalizeWeek({ arena, weekKey: "2026-07-16", seasonId: "32", snapshotId: renamedSnapshot });

    let player = storage.getPlayerProfile("90001");
    let union = storage.getUnionProfile(7001);
    assert.equal(player.playerLabel, "初见昵称");
    assert.equal(player.latestNickname, "游戏改名后");
    assert.equal(union.unionLabel, "初见联盟");
    assert.equal(union.latestName, "联盟改名后");
    assert.equal(Object.hasOwn(storage.getSnapshot(renamedSnapshot).zones[0].players[0], "power"), false);
    assert.equal(storage.db.prepare("SELECT power FROM rank_entries WHERE snapshot_id = ?").get(renamedSnapshot).power, 0);

    storage.updateIdentityLabels({
      playerId: "90001",
      playerLabel: "固定玩家标注",
      unionId: 7001,
      unionLabel: "固定联盟标注"
    });
    const standing = storage.seasonStats("32", "classic").standings[0];
    assert.equal(standing.playerLabel, "固定玩家标注");
    assert.equal(standing.nickname, "游戏改名后");
    assert.equal(standing.unionLabel, "固定联盟标注");
    assert.equal(standing.unionName, "联盟改名后");

    storage.saveSnapshot({
      arena,
      capturedAt: new Date("2026-07-03T05:00:00.000Z"),
      zones: ranking("旧周昵称", "旧周联盟名"),
      source: "manual"
    });
    player = storage.getPlayerProfile("90001");
    union = storage.getUnionProfile(7001);
    assert.equal(player.playerLabel, "固定玩家标注");
    assert.equal(player.latestNickname, "游戏改名后");
    assert.equal(union.unionLabel, "固定联盟标注");
    assert.equal(union.latestName, "联盟改名后");
  } finally {
    storage.close();
  }
});

test("a manually created player without a union gains the collected union by player ID", () => {
  const config = loadConfig({ dataFile: ":memory:" });
  const storage = new Storage(config);
  const arena = config.arenas.find((item) => item.key === "classic");

  try {
    const created = storage.createPlayerProfile({
      playerId: "manual-no-union",
      nickname: "手动昵称",
      playerLabel: "固定玩家标注"
    });
    assert.equal(created.latestUnionId, 0);
    assert.equal(created.latestUnionName, null);

    storage.saveSnapshot({
      arena,
      capturedAt: new Date(Date.now() + 60_000),
      zones: [{
        ...arena.zones[0],
        players: [{
          rank: 1,
          playerId: "manual-no-union",
          nickname: "采集昵称",
          unionId: 8123,
          unionName: "采集联盟"
        }]
      }],
      source: "test"
    });

    const updated = storage.getPlayerProfile("manual-no-union");
    assert.equal(updated.playerLabel, "固定玩家标注");
    assert.equal(updated.latestNickname, "采集昵称");
    assert.equal(updated.latestUnionId, 8123);
    assert.equal(updated.latestUnionName, "采集联盟");
    assert.equal(updated.unionLabel, "采集联盟");
  } finally {
    storage.close();
  }
});

test("creating a season with planned weeks calculates and persists its end", () => {
  const config = loadConfig({ dataFile: ":memory:" });
  const storage = new Storage(config);
  try {
    const season = storage.createSeason({
      id: "40",
      label: "第40届",
      startsAt: "2026-07-03T12:00:00+08:00",
      weeks: 4
    });
    assert.equal(season.plannedWeeks, 4);
    assert.equal(season.endsAt, "2026-07-30T13:30:00.000Z");
    assert.equal(storage.seasonForCutoff(new Date("2026-07-30T13:10:00.000Z"), "40").id, "40");
    assert.throws(
      () => storage.seasonForCutoff(new Date("2026-08-06T13:10:00.000Z"), "40"),
      /does not cover/
    );
  } finally {
    storage.close();
  }
});
