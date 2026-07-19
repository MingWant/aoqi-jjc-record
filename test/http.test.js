import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { seedDemoData } from "../src/demo-data.js";
import { createHttpHandler } from "../src/http-app.js";
import { Storage } from "../src/storage.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("HTTP app serves a protected dashboard and admin API", async () => {
  const config = loadConfig({
    dataFile: ":memory:",
    demoMode: true,
    accessToken: "view-token",
    adminToken: "test-token"
  });
  const storage = new Storage(config);
  seedDemoData(storage, config);
  const scheduler = {
    getState: () => ({ credentialsConfigured: false, collector: { phase: "idle" }, nextPollAt: null }),
    collectNow: async () => [],
    finalizeNow: ({ arenaKey, weekKey, seasonId, snapshotId }) => storage.finalizeWeek({
      arena: config.arenas.find((arena) => arena.key === arenaKey),
      weekKey,
      seasonId,
      snapshotId
    })
  };
  const server = http.createServer(createHttpHandler({ config, storage, scheduler, publicDir: path.join(root, "public") }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const authenticatedFetch = (url, options = {}) => {
    const headers = new Headers(options.headers || {});
    headers.set("X-Access-Token", "view-token");
    return fetch(url, { ...options, headers });
  };
  try {
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    const pageText = await page.text();
    assert.match(pageText, /战皇档案/);
    assert.match(pageText, /历史补录/);
    assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
    const script = await fetch(`http://127.0.0.1:${port}/app.js`);
    assert.equal(script.headers.get("cache-control"), "no-cache");
    const scriptText = await script.text();
    assert.match(scriptText, /backfill-player-options/);
    assert.match(scriptText, /playerLabel/);
    assert.match(scriptText, /data-matrix-toggle/);
    assert.match(scriptText, /data-inline-player-id/);
    assert.match(scriptText, /union-label-directory/);
    assert.match(scriptText, /data-inline-union-id/);
    assert.match(scriptText, /save-inline-union-label/);
    assert.match(scriptText, /new-player-form/);
    assert.match(scriptText, /api\/admin\/players/);
    assert.match(scriptText, /name="weeks"/);
    assert.match(scriptText, /data-edit-season/);
    assert.match(scriptText, /admin-lock-notice/);
    assert.match(scriptText, /验证并解锁/);
    assert.match(scriptText, /data-hall-mode/);
    assert.match(scriptText, /hall-matrix/);
    assert.match(scriptText, /access-form/);
    assert.match(scriptText, /X-Access-Token/);
    assert.match(pageText, /输入访问密钥/);
    assert.doesNotMatch(scriptText, /data-action="save-inline-labels" data-player-id/);
    assert.doesNotMatch(scriptText, /backfill-col-power/);

    const accessStatus = await fetch(`http://127.0.0.1:${port}/api/access/status`).then((response) => response.json());
    assert.equal(accessStatus.configured, true);
    const health = await fetch(`http://127.0.0.1:${port}/healthz`).then((response) => response.json());
    assert.deepEqual(health, { ok: true });
    const blockedBootstrap = await fetch(`http://127.0.0.1:${port}/api/bootstrap?season=29`);
    assert.equal(blockedBootstrap.status, 401);
    assert.equal((await blockedBootstrap.json()).code, "ACCESS_DENIED");
    const wrongAccess = await fetch(`http://127.0.0.1:${port}/api/access/verify`, {
      method: "POST",
      headers: { "X-Access-Token": "wrong-view-token" },
      body: "{}"
    });
    assert.equal(wrongAccess.status, 401);
    const verifiedAccess = await fetch(`http://127.0.0.1:${port}/api/access/verify`, {
      method: "POST",
      headers: { "X-Access-Token": "view-token" },
      body: "{}"
    });
    assert.equal(verifiedAccess.status, 200);

    const bootstrap = await authenticatedFetch(`http://127.0.0.1:${port}/api/bootstrap?season=29`).then((response) => response.json());
    assert.equal(bootstrap.config.accessProtected, true);
    assert.equal(Object.hasOwn(bootstrap.config, "accessToken"), false);
    assert.equal(Object.hasOwn(bootstrap.config, "adminToken"), false);
    assert.equal(bootstrap.arenas.classic.stats.seatCount, 90);
    assert.equal(bootstrap.arenas.legend.latest.zones.length, 3);

    const unauthorized = await authenticatedFetch(`http://127.0.0.1:${port}/api/admin/collect`, { method: "POST", body: "{}" });
    assert.equal(unauthorized.status, 401);

    const wrongVerify = await fetch(`http://127.0.0.1:${port}/api/admin/verify`, {
      method: "POST",
      headers: { "Authorization": "Bearer wrong-token", "X-Access-Token": "view-token", "Content-Type": "application/json" },
      body: "{}"
    });
    assert.equal(wrongVerify.status, 401);
    const verified = await fetch(`http://127.0.0.1:${port}/api/admin/verify`, {
      method: "POST",
      headers: { "Authorization": "Bearer test-token", "X-Access-Token": "view-token", "Content-Type": "application/json" },
      body: "{}"
    });
    assert.equal(verified.status, 200);

    const createdSeason = await authenticatedFetch(`http://127.0.0.1:${port}/api/admin/seasons`, {
      method: "POST",
      headers: { "Authorization": "Bearer test-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "40",
        label: "第40届",
        startsAt: "2026-07-03T12:00:00+08:00",
        weeks: 4
      })
    }).then(async (response) => ({ status: response.status, body: await response.json() }));
    assert.equal(createdSeason.status, 201);
    assert.equal(createdSeason.body.plannedWeeks, 4);
    assert.equal(createdSeason.body.endsAt, "2026-07-30T13:30:00.000Z");

    const overlappingSeason = await authenticatedFetch(`http://127.0.0.1:${port}/api/admin/seasons`, {
      method: "POST",
      headers: { "Authorization": "Bearer test-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "41",
        label: "重叠赛季",
        startsAt: "2026-07-10T12:00:00+08:00",
        endsAt: "2026-07-20T23:00:00+08:00"
      })
    });
    assert.equal(overlappingSeason.status, 400);

    const classic = config.arenas.find((arena) => arena.key === "classic");
    const zones = classic.zones.map((zone) => ({
      ...zone,
      players: [1, 2, 3, 4, 5].map((rank) => ({
        rank,
        playerId: `${zone.serverZoneId}${rank}`,
        nickname: `${zone.name}${rank}`,
        playerLabel: `${zone.name}${rank}标注`,
        unionId: 9000 + zone.index,
        unionName: "补录联盟",
        unionLabel: `联盟${zone.index}标注`
      }))
    }));
    const imported = await authenticatedFetch(`http://127.0.0.1:${port}/api/admin/import`, {
      method: "POST",
      headers: { "Authorization": "Bearer test-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        arenaKey: "classic",
        seasonId: "32",
        weekKey: "2026-07-16",
        source: "manual",
        finalize: true,
        zones
      })
    }).then((response) => response.json());
    assert.equal(imported.snapshot.source, "manual");
    assert.equal(imported.snapshot.capturedAt, "2026-07-16T13:00:00.000Z");
    assert.equal(imported.settlement.status, "final");
    assert.equal(imported.snapshot.zones[0].players[0].playerLabel, "希望战区1标注");
    assert.equal(imported.snapshot.zones[0].players[0].unionLabel, "联盟0标注");
    assert.equal(Object.hasOwn(imported.snapshot.zones[0].players[0], "power"), false);

    const importedBootstrap = await authenticatedFetch(`http://127.0.0.1:${port}/api/bootstrap?season=32`).then((response) => response.json());
    assert.equal(importedBootstrap.directory.players.some((player) => player.playerId === "1001"), true);
    assert.equal(importedBootstrap.directory.unions.some((union) => union.unionId === 9000), true);

    const relabeled = await authenticatedFetch(`http://127.0.0.1:${port}/api/admin/labels`, {
      method: "POST",
      headers: { "Authorization": "Bearer test-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        playerId: "1001",
        playerLabel: "固定玩家标注",
        unionId: 9000,
        unionLabel: "固定联盟标注"
      })
    }).then((response) => response.json());
    assert.equal(relabeled.player.playerLabel, "固定玩家标注");
    assert.equal(relabeled.union.unionLabel, "固定联盟标注");

    const stats = await authenticatedFetch(`http://127.0.0.1:${port}/api/stats?season=32&arena=classic`).then((response) => response.json());
    assert.equal(stats.finalizedWeekCount, 1);
    assert.equal(stats.seatCount, 15);
    assert.equal(stats.standings.find((player) => player.playerId === "1001").playerLabel, "固定玩家标注");
    assert.equal(stats.standings.find((player) => player.playerId === "1002").unionLabel, "固定联盟标注");

    const unionRelabeled = await authenticatedFetch(`http://127.0.0.1:${port}/api/admin/labels`, {
      method: "POST",
      headers: { "Authorization": "Bearer test-token", "Content-Type": "application/json" },
      body: JSON.stringify({ unionId: 9000, unionLabel: "统一联盟备注" })
    }).then((response) => response.json());
    assert.equal(unionRelabeled.player, null);
    assert.equal(unionRelabeled.union.unionLabel, "统一联盟备注");
    const syncedStats = await authenticatedFetch(`http://127.0.0.1:${port}/api/stats?season=32&arena=classic`).then((response) => response.json());
    assert.equal(syncedStats.standings.find((player) => player.playerId === "1001").unionLabel, "统一联盟备注");
    assert.equal(syncedStats.standings.find((player) => player.playerId === "1002").unionLabel, "统一联盟备注");

    const createdPlayer = await authenticatedFetch(`http://127.0.0.1:${port}/api/admin/players`, {
      method: "POST",
      headers: { "Authorization": "Bearer test-token", "Content-Type": "application/json" },
      body: JSON.stringify({ playerId: "manual-new-player", nickname: "新手玩家", unionId: 9000 })
    }).then(async (response) => ({ status: response.status, body: await response.json() }));
    assert.equal(createdPlayer.status, 201);
    assert.equal(createdPlayer.body.player.playerLabel, "新手玩家");
    assert.equal(createdPlayer.body.player.latestUnionId, 9000);

    const createdBootstrap = await authenticatedFetch(`http://127.0.0.1:${port}/api/bootstrap?season=32`).then((response) => response.json());
    assert.equal(createdBootstrap.directory.players.some((player) => player.playerId === "manual-new-player"), true);

    const emptyHistory = await authenticatedFetch(`http://127.0.0.1:${port}/api/players/manual-new-player?season=32&arena=classic`).then(async (response) => ({ status: response.status, body: await response.json() }));
    assert.equal(emptyHistory.status, 200);
    assert.equal(emptyHistory.body.player.emperorCount, 0);
    assert.deepEqual(emptyHistory.body.history, []);

    const duplicatePlayer = await authenticatedFetch(`http://127.0.0.1:${port}/api/admin/players`, {
      method: "POST",
      headers: { "Authorization": "Bearer test-token", "Content-Type": "application/json" },
      body: JSON.stringify({ playerId: "manual-new-player" })
    });
    assert.equal(duplicatePlayer.status, 409);

    const invalidWeek = await authenticatedFetch(`http://127.0.0.1:${port}/api/admin/import`, {
      method: "POST",
      headers: { "Authorization": "Bearer test-token", "Content-Type": "application/json" },
      body: JSON.stringify({ arenaKey: "classic", seasonId: "32", weekKey: "2026-07-18", finalize: true, zones })
    });
    assert.equal(invalidWeek.status, 400);

    zones[0].players[0] = {
      ...zones[0].players[0],
      playerId: "replacement",
      nickname: "修正后玩家",
      playerLabel: "修正后玩家标注"
    };
    const replaced = await authenticatedFetch(`http://127.0.0.1:${port}/api/admin/import`, {
      method: "POST",
      headers: { "Authorization": "Bearer test-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        arenaKey: "classic",
        seasonId: "32",
        weekKey: "2026-07-16",
        source: "manual",
        finalize: true,
        zones
      })
    }).then((response) => response.json());
    assert.notEqual(replaced.settlement.snapshotId, imported.settlement.snapshotId);
    const replacedStats = await authenticatedFetch(`http://127.0.0.1:${port}/api/stats?season=32&arena=classic`).then((response) => response.json());
    assert.equal(replacedStats.seatCount, 15);
    assert.equal(replacedStats.standings.some((player) => player.playerId === "replacement"), true);
    assert.equal(replacedStats.standings.some((player) => player.playerId === "1001"), false);

    const matrix = await authenticatedFetch(`http://127.0.0.1:${port}/api/admin/matrix`, {
      method: "POST",
      headers: { "Authorization": "Bearer test-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        arenaKey: "classic",
        seasonId: "32",
        weeks: [{ weekKey: "2026-07-09", playerIds: ["1001", "1002"] }]
      })
    }).then((response) => response.json());
    assert.equal(matrix.results.length, 1);
    assert.equal(matrix.results[0].weekKey, "2026-07-09");
    assert.equal(matrix.results[0].status, "partial");
    assert.equal(matrix.results[0].entryCount, 2);

    const clearedMatrix = await authenticatedFetch(`http://127.0.0.1:${port}/api/admin/matrix`, {
      method: "POST",
      headers: { "Authorization": "Bearer test-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        arenaKey: "classic",
        seasonId: "32",
        weeks: [{ weekKey: "2026-07-09", playerIds: [] }]
      })
    }).then((response) => response.json());
    assert.equal(clearedMatrix.results[0].status, "partial");
    assert.equal(clearedMatrix.results[0].entryCount, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    storage.close();
  }
});

test("admin writes stay locked when no admin token is configured", async () => {
  const config = loadConfig({ dataFile: ":memory:", demoMode: false, accessToken: "view-token", adminToken: "" });
  const storage = new Storage(config);
  const scheduler = {
    getState: () => ({ credentialsConfigured: false, collector: { phase: "idle" }, nextPollAt: null }),
    collectNow: async () => [],
    finalizeNow: () => null
  };
  const server = http.createServer(createHttpHandler({ config, storage, scheduler, publicDir: path.join(root, "public") }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/admin/players`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Access-Token": "view-token" },
      body: JSON.stringify({ playerId: "locked-player" })
    });
    assert.equal(response.status, 503);
    const verify = await fetch(`http://127.0.0.1:${port}/api/admin/verify`, {
      method: "POST",
      headers: { "X-Access-Token": "view-token" },
      body: "{}"
    });
    assert.equal(verify.status, 503);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    storage.close();
  }
});

test("read APIs stay locked when no access token is configured", async () => {
  const config = loadConfig({ dataFile: ":memory:", demoMode: false, accessToken: "", adminToken: "test-token" });
  const storage = new Storage(config);
  const scheduler = {
    getState: () => ({ credentialsConfigured: false, collector: { phase: "idle" }, nextPollAt: null }),
    collectNow: async () => [],
    finalizeNow: () => null
  };
  const server = http.createServer(createHttpHandler({ config, storage, scheduler, publicDir: path.join(root, "public") }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    const status = await fetch(`http://127.0.0.1:${port}/api/access/status`).then((response) => response.json());
    assert.equal(status.configured, false);
    const bootstrap = await fetch(`http://127.0.0.1:${port}/api/bootstrap`);
    assert.equal(bootstrap.status, 503);
    assert.equal((await bootstrap.json()).code, "ACCESS_NOT_CONFIGURED");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    storage.close();
  }
});
