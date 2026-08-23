import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { CollectorScheduler } from "../src/scheduler.js";
import { Storage } from "../src/storage.js";

function rankingZones(arena) {
  return arena.zones.map((zone) => ({
    ...zone,
    players: [1, 2, 3, 4, 5].map((rank) => ({
      rank,
      playerId: `${arena.protocolType}${zone.serverZoneId}${rank}`,
      nickname: `${zone.name}${rank}`,
      clothes: "",
      vipLevel: 0,
      unionId: 0,
      unionName: "自动结算联盟",
      unionIcon: 0,
      nicknameCard: ""
    }))
  }));
}

test("successful Friday ranking collection automatically settles the previous Thursday", async () => {
  const config = loadConfig({ dataFile: ":memory:" });
  const storage = new Storage(config);
  const now = new Date("2026-07-18T15:00:00.000Z");
  const collector = {
    running: false,
    collect: async () => config.arenas.map((arena) => {
      const zones = rankingZones(arena);
      const snapshotId = storage.saveSnapshot({ arena, capturedAt: now, zones, source: "test" });
      return { arenaKey: arena.key, snapshotId, capturedAt: now.toISOString(), zones };
    }),
    getState: () => ({ phase: "ready", running: false }),
    close: () => {}
  };
  const scheduler = new CollectorScheduler(config, collector, storage, { now: () => now });

  try {
    await scheduler.collectNow();
    const settlements = storage.listSettlements({ seasonId: "32" });
    assert.equal(settlements.length, 2);
    assert.deepEqual(new Set(settlements.map((item) => item.weekKey)), new Set(["2026-07-16"]));
    assert.equal(settlements.every((item) => item.status === "final"), true);
    assert.equal(storage.seasonStats("32", "classic").seatCount, 15);
    assert.equal(storage.seasonStats("32", "legend").seatCount, 15);

    const originalSnapshotIds = new Map(settlements.map((item) => [item.arenaKey, item.snapshotId]));
    await scheduler.collectNow();
    const unchanged = storage.listSettlements({ seasonId: "32" });
    assert.equal(unchanged.length, 2);
    assert.equal(unchanged.every((item) => item.snapshotId === originalSnapshotIds.get(item.arenaKey)), true);
  } finally {
    storage.close();
  }
});

test("Friday pre-update data cannot settle before the updated board passes the grace period", async () => {
  const config = loadConfig({ dataFile: ":memory:" });
  const storage = new Storage(config);
  let now = new Date("2026-07-16T20:50:00.000Z");
  const collector = {
    running: false,
    collect: async () => config.arenas.map((arena) => {
      const zones = rankingZones(arena);
      const snapshotId = storage.saveSnapshot({ arena, capturedAt: now, zones, source: "test" });
      return { arenaKey: arena.key, snapshotId, capturedAt: now.toISOString(), zones };
    }),
    getState: () => ({ phase: "ready", running: false }),
    close: () => {}
  };
  const scheduler = new CollectorScheduler(config, collector, storage, { now: () => now });

  try {
    await scheduler.collectNow();
    assert.equal(storage.listSettlements({ seasonId: "32" }).length, 0);

    now = new Date("2026-07-16T21:04:00.000Z");
    await scheduler.collectNow();
    assert.equal(storage.listSettlements({ seasonId: "32" }).length, 0);

    now = new Date("2026-07-16T22:01:00.000Z");
    await scheduler.collectNow();
    const settlements = storage.listSettlements({ seasonId: "32" });
    assert.equal(settlements.length, 2);
    assert.deepEqual(new Set(settlements.map((item) => item.weekKey)), new Set(["2026-07-16"]));
    assert.equal(settlements.every((item) => item.status === "final"), true);
  } finally {
    storage.close();
  }
});

test("an unchanged board after the stability period is treated as stale", async () => {
  const config = loadConfig({ dataFile: ":memory:" });
  const storage = new Storage(config);
  let fresh = false;
  const now = new Date("2026-07-17T22:01:00.000Z");

  for (const arena of config.arenas) {
    const zones = rankingZones(arena);
    const snapshotId = storage.saveSnapshot({
      arena,
      capturedAt: new Date("2026-07-10T22:01:00.000Z"),
      zones,
      source: "test"
    });
    storage.finalizeWeek({ arena, weekKey: "2026-07-09", seasonId: "32", snapshotId });
  }

  const collector = {
    running: false,
    collect: async () => config.arenas.map((arena) => {
      const zones = rankingZones(arena);
      if (fresh) zones[0].players[0].playerId += "-updated";
      const snapshotId = storage.saveSnapshot({ arena, capturedAt: now, zones, source: "test" });
      return { arenaKey: arena.key, snapshotId, capturedAt: now.toISOString(), zones };
    }),
    getState: () => ({ phase: "ready", running: false }),
    close: () => {}
  };
  const scheduler = new CollectorScheduler(config, collector, storage, { now: () => now });

  try {
    await scheduler.collectNow();
    assert.equal(storage.listSettlements({ seasonId: "32" }).length, 2);

    fresh = true;
    await scheduler.collectNow();
    const settlements = storage.listSettlements({ seasonId: "32" });
    assert.equal(settlements.length, 4);
    assert.equal(settlements.filter((item) => item.weekKey === "2026-07-16").length, 2);
  } finally {
    storage.close();
  }
});

test("the scheduler cleans expired unreferenced snapshots at most once per day", async () => {
  const config = loadConfig({
    dataFile: ":memory:",
    snapshotRetentionDays: 1,
    login: { mode: "account", account: "", password: "" }
  });
  const storage = new Storage(config);
  const arena = config.arenas[0];
  let now = new Date("2026-07-20T00:00:00.000Z");
  const collector = {
    running: false,
    collect: async () => [],
    getState: () => ({ phase: "idle", running: false }),
    close: () => {}
  };
  const scheduler = new CollectorScheduler(config, collector, storage, { now: () => now });
  const addExpiredSnapshot = () => storage.saveSnapshot({
    arena,
    capturedAt: new Date("2026-07-18T00:00:00.000Z"),
    zones: rankingZones(arena),
    source: "test"
  });

  try {
    const firstId = addExpiredSnapshot();
    await scheduler.tick();
    assert.equal(storage.getSnapshot(firstId), null);

    const secondId = addExpiredSnapshot();
    now = new Date("2026-07-20T01:00:00.000Z");
    await scheduler.tick();
    assert.notEqual(storage.getSnapshot(secondId), null);

    now = new Date("2026-07-21T01:00:00.000Z");
    await scheduler.tick();
    assert.equal(storage.getSnapshot(secondId), null);
    assert.equal(scheduler.getState().lastCleanupAt, now.toISOString());
  } finally {
    storage.close();
  }
});
