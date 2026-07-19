import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { publicConfig } from "./config.js";
import { parseTopFiveResponse } from "./domain/players.js";
import { cutoffForWeek, dateKey, localParts } from "./domain/calendar.js";
import { seedDemoData } from "./demo-data.js";

const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".svg", "image/svg+xml"]
]);

function jsonResponse(response, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": payload.length,
    "Cache-Control": "no-store"
  });
  response.end(payload);
}

function secureEqual(left, right) {
  const expected = Buffer.from(String(left ?? ""));
  const supplied = Buffer.from(String(right ?? ""));
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

function requireAccess(request, config) {
  if (!config.accessToken) {
    throw Object.assign(new Error("访问密钥未配置，数据读取已锁定"), {
      status: 503,
      code: "ACCESS_NOT_CONFIGURED"
    });
  }
  const supplied = Array.isArray(request.headers["x-access-token"])
    ? request.headers["x-access-token"][0]
    : request.headers["x-access-token"] ?? "";
  if (!secureEqual(config.accessToken, supplied)) {
    throw Object.assign(new Error("访问密钥错误或尚未输入"), {
      status: 401,
      code: "ACCESS_DENIED"
    });
  }
}

function cleanStats(stats, limit = 250) {
  return {
    season: stats.season,
    seasons: stats.seasons,
    arenaKey: stats.arenaKey,
    window: stats.window,
    standings: stats.standings.slice(0, limit),
    candidates: stats.candidates,
    finalizedWeekCount: stats.finalizedWeekCount,
    expectedWeekCount: stats.expectedWeekCount,
    elapsedWeekCount: stats.elapsedWeekCount,
    missingWeekCount: stats.missingWeekCount,
    partialWeekCount: stats.partialWeekCount,
    futureWeekCount: stats.futureWeekCount,
    seatCount: stats.seatCount,
    uniquePlayerCount: stats.uniquePlayerCount,
    weeks: stats.weeks,
    timelineWeeks: stats.timelineWeeks
  };
}

async function readBody(request, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Request body is too large"), { status: 413 });
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON"), { status: 400 });
  }
}

function requireAdmin(request, config) {
  if (!config.adminToken) {
    throw Object.assign(new Error("管理密码未配置，手动写入已锁定"), { status: 503 });
  }
  const bearer = request.headers.authorization?.startsWith("Bearer ")
    ? request.headers.authorization.slice(7)
    : "";
  const supplied = bearer || request.headers["x-admin-token"] || "";
  if (!secureEqual(config.adminToken, supplied)) {
    throw Object.assign(new Error("管理密码错误或尚未输入"), { status: 401 });
  }
}

function configuredArena(config, key) {
  const arena = config.arenas.find((item) => item.key === key);
  if (!arena) throw Object.assign(new Error(`Unknown arena: ${key}`), { status: 400 });
  return arena;
}

function normalizedImportZones(value, arena) {
  if (value.response) return parseTopFiveResponse(value.response, arena);
  if (!Array.isArray(value.zones) || value.zones.length === 0) {
    throw Object.assign(new Error("Import requires response or zones"), { status: 400 });
  }
  return value.zones.map((zone, index) => ({
    index: Number.isInteger(zone.index) ? zone.index : index,
    serverZoneId: Number(zone.serverZoneId ?? arena.zones[index]?.serverZoneId ?? index),
    name: String(zone.name ?? arena.zones[index]?.name ?? `战区 ${index + 1}`),
    players: (Array.isArray(zone.players) ? zone.players : []).map((player) => ({
      rank: Number(player.rank),
      playerId: String(player.playerId ?? "").trim(),
      nickname: String(player.nickname ?? "").trim(),
      playerLabel: String(player.playerLabel ?? "").trim(),
      clothes: String(player.clothes ?? ""),
      vipLevel: Number(player.vipLevel ?? 0),
      unionId: Number(player.unionId ?? 0) || 0,
      unionName: Number(player.unionId ?? 0) > 0
        ? String(player.unionName ?? "").trim() || String(Number(player.unionId))
        : "未加入联盟",
      unionLabel: String(player.unionLabel ?? "").trim(),
      unionIcon: Number(player.unionIcon ?? 0),
      nicknameCard: String(player.nicknameCard ?? "")
    })).filter((player) => player.playerId && Number.isInteger(player.rank) && player.rank >= 1 && player.rank <= 5)
  }));
}

function validateManualImportZones(zones, arena) {
  const expectedIndexes = new Set(arena.zones.map((zone) => zone.index));
  const suppliedIndexes = new Set(zones.map((zone) => zone.index));
  if (
    zones.length !== expectedIndexes.size
    || suppliedIndexes.size !== expectedIndexes.size
    || zones.some((zone) => !expectedIndexes.has(zone.index))
  ) {
    throw Object.assign(new Error("Manual import must include every configured zone"), { status: 400 });
  }
  const playerIds = [];
  const unionLabels = new Map();
  for (const zone of zones) {
    const ranks = zone.players.map((player) => player.rank);
    if (new Set(ranks).size !== ranks.length) {
      throw Object.assign(new Error(`Manual import contains duplicate ranks in zone ${zone.index}`), { status: 400 });
    }
    for (const player of zone.players) {
      playerIds.push(player.playerId);
      if (player.playerLabel.length > 80 || player.unionLabel.length > 80) {
        throw Object.assign(new Error("Manual import labels must be 80 characters or fewer"), { status: 400 });
      }
      if (player.unionId > 0 && player.unionLabel) {
        const existing = unionLabels.get(player.unionId);
        if (existing && existing !== player.unionLabel) {
          throw Object.assign(new Error(`Manual import contains conflicting labels for union ${player.unionId}`), { status: 400 });
        }
        unionLabels.set(player.unionId, player.unionLabel);
      }
    }
  }
  if (new Set(playerIds).size !== playerIds.length) {
    throw Object.assign(new Error("Manual import contains duplicate player IDs"), { status: 400 });
  }
}

function validateSettlementWeek(weekKey, arena, config) {
  try {
    const cutoff = cutoffForWeek(weekKey, arena, config.utcOffsetMinutes);
    if (
      dateKey(cutoff, config.utcOffsetMinutes) !== weekKey
      || localParts(cutoff, config.utcOffsetMinutes).weekday !== arena.settlementWeekday
    ) {
      throw new Error("weekday mismatch");
    }
    return cutoff;
  } catch {
    throw Object.assign(new Error(`Invalid settlement date: ${weekKey}`), { status: 400 });
  }
}

function matrixZones(storage, arena, weekKey, playerIds) {
  const seatCount = arena.zones.length * 5;
  const ids = playerIds.map((value) => String(value ?? "").trim()).filter(Boolean);
  if (new Set(ids).size !== ids.length) {
    throw Object.assign(new Error(`Matrix week ${weekKey} contains duplicate player IDs`), { status: 400 });
  }
  if (ids.length > seatCount) {
    throw Object.assign(new Error(`Matrix week ${weekKey} exceeds ${seatCount} emperor seats`), { status: 400 });
  }

  const existing = storage.getSettlement(arena.key, weekKey)?.snapshot;
  const existingPlayers = new Map();
  const existingSlots = new Map();
  for (const zone of existing?.zones || []) {
    for (const player of zone.players || []) {
      existingPlayers.set(player.playerId, player);
      existingSlots.set(`${zone.index}:${player.rank}`, player.playerId);
    }
  }

  const profiles = new Map();
  for (const playerId of ids) {
    const profile = storage.getPlayerProfile(playerId);
    if (!profile) {
      throw Object.assign(new Error(`Player profile not found: ${playerId}`), { status: 400 });
    }
    profiles.set(playerId, profile);
  }

  const selected = new Set(ids);
  const assignments = new Map();
  const assignedPlayers = new Set();
  for (const [slot, playerId] of existingSlots) {
    if (!selected.has(playerId) || assignedPlayers.has(playerId)) continue;
    assignments.set(slot, playerId);
    assignedPlayers.add(playerId);
  }

  const slots = arena.zones.flatMap((zone) => [1, 2, 3, 4, 5].map((rank) => ({ zone, rank })));
  for (const playerId of ids) {
    if (assignedPlayers.has(playerId)) continue;
    const slot = slots.find(({ zone, rank }) => !assignments.has(`${zone.index}:${rank}`));
    if (!slot) break;
    assignments.set(`${slot.zone.index}:${slot.rank}`, playerId);
    assignedPlayers.add(playerId);
  }

  return arena.zones.map((zone) => ({
    index: zone.index,
    serverZoneId: zone.serverZoneId,
    name: zone.name,
    players: [1, 2, 3, 4, 5].flatMap((rank) => {
      const playerId = assignments.get(`${zone.index}:${rank}`);
      if (!playerId) return [];
      const profile = profiles.get(playerId);
      const previous = existingPlayers.get(playerId);
      const unionId = Number(previous?.unionId ?? profile.latestUnionId) || 0;
      return [{
        rank,
        playerId,
        nickname: previous?.nickname || profile.latestNickname || profile.playerLabel || playerId,
        playerLabel: profile.playerLabel || previous?.playerLabel || previous?.nickname || playerId,
        clothes: previous?.clothes || "",
        vipLevel: Number(previous?.vipLevel) || 0,
        unionId,
        unionName: unionId > 0
          ? previous?.unionName || profile.latestUnionName || profile.unionLabel || String(unionId)
          : "未加入联盟",
        unionLabel: unionId > 0
          ? profile.unionLabel || previous?.unionLabel || previous?.unionName || String(unionId)
          : "",
        unionIcon: Number(previous?.unionIcon) || 0,
        nicknameCard: previous?.nicknameCard || ""
      }];
    })
  }));
}

export function createHttpHandler({ config, storage, scheduler, publicDir }) {
  async function api(request, response, url) {
    const pathname = url.pathname;
    if (request.method === "GET" && pathname === "/api/access/status") {
      jsonResponse(response, 200, { configured: Boolean(config.accessToken) });
      return;
    }
    if (request.method === "POST" && pathname === "/api/access/verify") {
      requireAccess(request, config);
      jsonResponse(response, 200, { ok: true });
      return;
    }
    requireAccess(request, config);
    if (request.method === "GET" && pathname === "/api/bootstrap") {
      const seasons = storage.listSeasons();
      const seasonId = url.searchParams.get("season") || storage.getActiveSeason()?.id;
      const arenas = {};
      for (const arena of config.arenas) {
        arenas[arena.key] = {
          latest: storage.latestSnapshot(arena.key),
          stats: seasonId ? cleanStats(storage.seasonStats(seasonId, arena.key)) : null,
          hall: seasonId ? cleanStats(storage.hallStats({ throughSeasonId: seasonId, arenaKey: arena.key })) : null,
          settlements: storage.listSettlements({ seasonId, arenaKey: arena.key })
        };
      }
      jsonResponse(response, 200, {
        config: publicConfig(config),
        seasons,
        activeSeasonId: seasonId,
        scheduler: scheduler.getState(),
        counts: storage.counts(),
        directory: storage.identityDirectory(),
        arenas,
        events: storage.listEvents(30)
      });
      return;
    }
    if (request.method === "GET" && pathname === "/api/status") {
      jsonResponse(response, 200, { scheduler: scheduler.getState(), counts: storage.counts(), events: storage.listEvents(50) });
      return;
    }
    if (request.method === "GET" && pathname === "/api/settlements") {
      jsonResponse(response, 200, storage.listSettlements({
        seasonId: url.searchParams.get("season"),
        arenaKey: url.searchParams.get("arena")
      }));
      return;
    }
    const settlementMatch = /^\/api\/settlements\/([^/]+)\/(\d{4}-\d{2}-\d{2})$/.exec(pathname);
    if (request.method === "GET" && settlementMatch) {
      const item = storage.getSettlement(decodeURIComponent(settlementMatch[1]), settlementMatch[2]);
      if (!item) throw Object.assign(new Error("Settlement not found"), { status: 404 });
      jsonResponse(response, 200, item);
      return;
    }
    if (request.method === "GET" && pathname === "/api/stats") {
      const seasonId = url.searchParams.get("season") || storage.getActiveSeason()?.id;
      const arenaKey = url.searchParams.get("arena");
      if (!seasonId || !arenaKey) throw Object.assign(new Error("season and arena are required"), { status: 400 });
      jsonResponse(response, 200, cleanStats(storage.seasonStats(seasonId, arenaKey)));
      return;
    }
    if (request.method === "GET" && pathname === "/api/hall") {
      const arenaKey = url.searchParams.get("arena");
      if (!arenaKey) throw Object.assign(new Error("arena is required"), { status: 400 });
      const window = Number.parseInt(url.searchParams.get("window") ?? config.hallSeasonWindow, 10);
      if (!Number.isInteger(window) || window < 1) {
        throw Object.assign(new Error("window must be a positive integer"), { status: 400 });
      }
      jsonResponse(response, 200, cleanStats(storage.hallStats({
        throughSeasonId: url.searchParams.get("season") || storage.getActiveSeason()?.id,
        arenaKey,
        window
      })));
      return;
    }
    if (request.method === "GET" && pathname === "/api/players") {
      const seasonId = url.searchParams.get("season") || storage.getActiveSeason()?.id;
      const result = storage.searchPlayers({
        seasonId,
        arenaKey: url.searchParams.get("arena"),
        query: url.searchParams.get("q") ?? "",
        limit: Number.parseInt(url.searchParams.get("limit") ?? 100, 10)
      });
      jsonResponse(response, 200, cleanStats(result, 500));
      return;
    }
    const playerMatch = /^\/api\/players\/([^/]+)$/.exec(pathname);
    if (request.method === "GET" && playerMatch) {
      const seasonId = url.searchParams.get("season") || storage.getActiveSeason()?.id;
      const result = storage.playerHistory({
        playerId: decodeURIComponent(playerMatch[1]),
        seasonId,
        arenaKey: url.searchParams.get("arena")
      });
      if (!result) throw Object.assign(new Error("Player history not found"), { status: 404 });
      jsonResponse(response, 200, result);
      return;
    }
    if (request.method === "GET" && pathname === "/api/events") {
      jsonResponse(response, 200, storage.listEvents(Number.parseInt(url.searchParams.get("limit") ?? 100, 10)));
      return;
    }
    if (request.method === "POST" && pathname === "/api/admin/verify") {
      requireAdmin(request, config);
      jsonResponse(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && pathname.startsWith("/api/admin/")) requireAdmin(request, config);
    if (request.method === "POST" && pathname === "/api/admin/collect") {
      const body = await readBody(request);
      const result = await scheduler.collectNow(Array.isArray(body.arenaKeys) ? body.arenaKeys : null);
      jsonResponse(response, 201, { result, scheduler: scheduler.getState() });
      return;
    }
    if (request.method === "POST" && pathname === "/api/admin/finalize") {
      const body = await readBody(request);
      jsonResponse(response, 201, scheduler.finalizeNow(body));
      return;
    }
    if (request.method === "POST" && pathname === "/api/admin/labels") {
      const body = await readBody(request);
      try {
        jsonResponse(response, 200, storage.updateIdentityLabels(body));
      } catch (error) {
        error.status ??= error.message.includes("not found") ? 404 : 400;
        throw error;
      }
      return;
    }
    if (request.method === "POST" && pathname === "/api/admin/players") {
      const body = await readBody(request);
      try {
        jsonResponse(response, 201, { player: storage.createPlayerProfile(body) });
      } catch (error) {
        error.status ??= error.message.includes("already exists") ? 409 : 400;
        throw error;
      }
      return;
    }
    if (request.method === "POST" && pathname === "/api/admin/matrix") {
      const body = await readBody(request);
      const arena = configuredArena(config, body.arenaKey);
      const season = storage.getSeason(String(body.seasonId ?? ""));
      if (!season) throw Object.assign(new Error(`Season not found: ${body.seasonId}`), { status: 400 });
      if (!Array.isArray(body.weeks) || body.weeks.length === 0 || body.weeks.length > 60) {
        throw Object.assign(new Error("Matrix import requires 1 to 60 weeks"), { status: 400 });
      }
      const weekKeys = body.weeks.map((item) => String(item.weekKey ?? "").trim());
      if (new Set(weekKeys).size !== weekKeys.length) {
        throw Object.assign(new Error("Matrix import contains duplicate weeks"), { status: 400 });
      }
      const prepared = body.weeks.map((item) => {
        const weekKey = String(item.weekKey ?? "").trim();
        const cutoff = validateSettlementWeek(weekKey, arena, config);
        if (cutoff.toISOString() < season.startsAt || (season.endsAt && cutoff.toISOString() > season.endsAt)) {
          throw Object.assign(new Error(`${weekKey} is outside ${season.label}`), { status: 400 });
        }
        if (!Array.isArray(item.playerIds)) {
          throw Object.assign(new Error(`Matrix week ${weekKey} requires playerIds`), { status: 400 });
        }
        return { weekKey, cutoff, zones: matrixZones(storage, arena, weekKey, item.playerIds) };
      });
      const results = prepared.map(({ weekKey, cutoff, zones }) => {
        const snapshotId = storage.saveSnapshot({
          arena,
          capturedAt: cutoff,
          zones,
          body: { matrix: true, weekKey },
          source: "matrix"
        });
        return scheduler.finalizeNow({
          arenaKey: arena.key,
          weekKey,
          seasonId: season.id,
          snapshotId
        });
      });
      jsonResponse(response, 201, { results });
      return;
    }
    if (request.method === "POST" && pathname === "/api/admin/import") {
      const body = await readBody(request);
      const arena = configuredArena(config, body.arenaKey);
      const finalize = body.finalize === true;
      if (finalize && !String(body.weekKey ?? "").trim()) {
        throw Object.assign(new Error("weekKey is required when finalizing an import"), { status: 400 });
      }
      const zones = normalizedImportZones(body, arena);
      if (!zones.some((zone) => zone.players.length > 0)) {
        throw Object.assign(new Error("Import requires at least one ranked player"), { status: 400 });
      }
      if (body.source === "manual") validateManualImportZones(zones, arena);
      let capturedAt;
      let settlementCutoff = null;
      try {
        if (finalize) {
          const weekKey = String(body.weekKey);
          settlementCutoff = validateSettlementWeek(weekKey, arena, config);
        }
        capturedAt = body.capturedAt
          ? new Date(body.capturedAt)
          : settlementCutoff ?? new Date();
      } catch {
        throw Object.assign(new Error("capturedAt or weekKey is invalid"), { status: 400 });
      }
      if (Number.isNaN(capturedAt.getTime())) {
        throw Object.assign(new Error("capturedAt is invalid"), { status: 400 });
      }
      if (finalize) {
        try {
          storage.seasonForCutoff(settlementCutoff, body.seasonId || null);
        } catch (error) {
          error.status ??= 400;
          throw error;
        }
      }
      const snapshotId = storage.saveSnapshot({
        arena,
        capturedAt,
        zones,
        body: body.response ?? { imported: true },
        source: body.source === "manual" ? "manual" : "import"
      });
      const settlement = finalize
        ? scheduler.finalizeNow({ arenaKey: arena.key, weekKey: body.weekKey, seasonId: body.seasonId, snapshotId })
        : null;
      jsonResponse(response, 201, { snapshot: storage.getSnapshot(snapshotId), settlement });
      return;
    }
    if (request.method === "POST" && pathname === "/api/admin/seasons") {
      const body = await readBody(request);
      try {
        jsonResponse(response, 201, storage.createSeason(body));
      } catch (error) {
        error.status ??= 400;
        throw error;
      }
      return;
    }
    const activateMatch = /^\/api\/admin\/seasons\/([^/]+)\/activate$/.exec(pathname);
    if (request.method === "POST" && activateMatch) {
      jsonResponse(response, 200, storage.activateSeason(decodeURIComponent(activateMatch[1])));
      return;
    }
    if (request.method === "POST" && pathname === "/api/admin/demo") {
      if (!config.demoMode) throw Object.assign(new Error("Demo mode is disabled"), { status: 403 });
      jsonResponse(response, 201, seedDemoData(storage, config));
      return;
    }
    throw Object.assign(new Error("API route not found"), { status: 404 });
  }

  function staticFile(response, pathname) {
    const requested = pathname === "/" ? "index.html" : pathname.slice(1);
    const absolute = path.resolve(publicDir, requested);
    const relative = path.relative(path.resolve(publicDir), absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      jsonResponse(response, 404, { error: "File not found" });
      return true;
    }
    let target = absolute;
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) target = path.join(publicDir, "index.html");
    const content = fs.readFileSync(target);
    const extension = path.extname(target).toLowerCase();
    const mutableAsset = path.basename(target) === "index.html" || extension === ".js" || extension === ".css";
    response.writeHead(200, {
      "Content-Type": MIME.get(extension) ?? "application/octet-stream",
      "Content-Length": content.length,
      "Cache-Control": mutableAsset ? "no-cache" : "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
    });
    response.end(content);
    return true;
  }

  return async function handler(request, response) {
    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
    try {
      if (url.pathname === "/healthz") {
        jsonResponse(response, 200, { ok: true });
      } else if (url.pathname.startsWith("/api/")) {
        await api(request, response, url);
      } else if (request.method === "GET" || request.method === "HEAD") {
        staticFile(response, decodeURIComponent(url.pathname));
      } else {
        throw Object.assign(new Error("Method not allowed"), { status: 405 });
      }
    } catch (error) {
      const status = error.status ?? (error.message?.includes("not found") ? 404 : 500);
      if (status >= 500) storage.addEvent("error", "http", error.stack ?? error.message);
      jsonResponse(response, status, { error: error.message, code: error.code });
    }
  };
}
