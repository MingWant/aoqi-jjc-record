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
