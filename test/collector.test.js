import test from "node:test";
import assert from "node:assert/strict";
import { ArenaCollector } from "../src/collector.js";
import { loadConfig } from "../src/config.js";
import { Storage } from "../src/storage.js";

function rankingBody(arena) {
  return {
    r: 1,
    zl: arena.zones.map((zone) => ({
      serverZoneId: zone.serverZoneId,
      zoneName: zone.name,
      ext10: `1|${zone.serverZoneId}001|测试玩家|||0|未加入联盟|0|`
    }))
  };
}

test("collector retries independently and closes the game session after collection", async () => {
  const config = loadConfig({ dataFile: ":memory:", collectionRetries: 1 });
  const storage = new Storage(config);
  const attempts = new Map();
  let closeCount = 0;
  const gameClient = {
    fetchTopFive: async (protocolType) => {
      const count = (attempts.get(protocolType) ?? 0) + 1;
      attempts.set(protocolType, count);
      if (protocolType === 1 && count === 1) throw new Error("temporary socket failure");
      return rankingBody(config.arenas.find((arena) => arena.protocolType === protocolType));
    },
    close: () => { closeCount += 1; }
  };
  const collector = new ArenaCollector(config, storage, {
    gameClient,
    now: () => new Date("2026-07-19T00:00:00.000Z")
  });

  try {
    const result = await collector.collect({ source: "test" });
    assert.equal(result.length, 2);
    assert.equal(attempts.get(1), 2);
    assert.equal(attempts.get(2), 1);
    assert.equal(collector.getState().phase, "ready");
    assert.equal(storage.counts().snapshots, 2);
    assert.ok(closeCount >= 2);
  } finally {
    storage.close();
  }
});

test("collector keeps a successful arena when another arena fails", async () => {
  const config = loadConfig({ dataFile: ":memory:", collectionRetries: 0 });
  const storage = new Storage(config);
  const gameClient = {
    fetchTopFive: async (protocolType) => {
      if (protocolType === 2) throw new Error("legend unavailable");
      return rankingBody(config.arenas.find((arena) => arena.protocolType === protocolType));
    },
    close: () => {}
  };
  const collector = new ArenaCollector(config, storage, { gameClient });

  try {
    const result = await collector.collect({ source: "test" });
    assert.deepEqual(result.map((item) => item.arenaKey), ["classic"]);
    assert.equal(collector.getState().phase, "partial");
    assert.match(collector.getState().lastError, /传奇竞技场/);
    assert.equal(storage.counts().snapshots, 1);
  } finally {
    storage.close();
  }
});
