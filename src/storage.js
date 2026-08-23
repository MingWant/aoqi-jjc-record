import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { calculateStandings } from "./domain/stats.js";
import { cutoffForWeek, seasonEndForWeeks, seasonSettlementWeeks, weekWindow } from "./domain/calendar.js";

const HALL_CYCLE_START_SEASON = 29;

function json(value) {
  return JSON.stringify(value, (_key, item) => {
    if (Buffer.isBuffer(item)) return { type: "Buffer", length: item.length, hex: item.toString("hex") };
    if (item instanceof Map) return Object.fromEntries(item);
    return item;
  });
}

function normalizeIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date.toISOString();
}

function mapSnapshotRows(snapshot, rows) {
  if (!snapshot) return null;
  const zones = new Map();
  for (const row of rows) {
    let zone = zones.get(row.zone_index);
    if (!zone) {
      zone = {
        index: row.zone_index,
        serverZoneId: row.server_zone_id,
        name: row.zone_name,
        players: []
      };
      zones.set(row.zone_index, zone);
    }
    zone.players.push({
      rank: row.rank,
      playerId: row.player_id,
      nickname: row.nickname,
      playerLabel: row.player_label || row.nickname || row.player_id,
      clothes: row.clothes,
      vipLevel: row.vip_level,
      unionId: row.union_id,
      unionName: row.union_name,
      unionLabel: row.union_label || row.union_name,
      unionIcon: row.union_icon,
      nicknameCard: row.nickname_card
    });
  }
  return {
    id: snapshot.id,
    arenaKey: snapshot.arena_key,
    capturedAt: snapshot.captured_at,
    source: snapshot.source,
    status: snapshot.status,
    zoneCount: snapshot.zone_count,
    entryCount: snapshot.entry_count,
    expectedEntryCount: snapshot.expected_entry_count,
    error: snapshot.error,
    zones: [...zones.values()].sort((a, b) => a.index - b.index)
  };
}

export class Storage {
  constructor(config) {
    this.config = config;
    fs.mkdirSync(path.dirname(config.dataFile), { recursive: true });
    this.db = new DatabaseSync(config.dataFile);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
    this.ensureInitialSeason(config.initialSeason);
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS seasons (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        starts_at TEXT NOT NULL,
        ends_at TEXT,
        planned_weeks INTEGER,
        active INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        arena_key TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        zone_count INTEGER NOT NULL DEFAULT 0,
        entry_count INTEGER NOT NULL DEFAULT 0,
        expected_entry_count INTEGER NOT NULL DEFAULT 0,
        raw_json TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS snapshots_arena_time ON snapshots(arena_key, captured_at DESC);

      CREATE TABLE IF NOT EXISTS rank_entries (
        snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
        arena_key TEXT NOT NULL,
        zone_index INTEGER NOT NULL,
        server_zone_id INTEGER NOT NULL,
        zone_name TEXT NOT NULL,
        rank INTEGER NOT NULL,
        player_id TEXT NOT NULL,
        nickname TEXT NOT NULL,
        clothes TEXT NOT NULL DEFAULT '',
        vip_level INTEGER NOT NULL DEFAULT 0,
        union_id INTEGER NOT NULL DEFAULT 0,
        union_name TEXT NOT NULL DEFAULT '',
        union_icon INTEGER NOT NULL DEFAULT 0,
        nickname_card TEXT NOT NULL DEFAULT '',
        power INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(snapshot_id, zone_index, rank)
      );
      CREATE INDEX IF NOT EXISTS rank_entries_player ON rank_entries(player_id, snapshot_id);

      CREATE TABLE IF NOT EXISTS player_profiles (
        player_id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        first_nickname TEXT NOT NULL DEFAULT '',
        latest_nickname TEXT NOT NULL DEFAULT '',
        latest_union_id INTEGER NOT NULL DEFAULT 0,
        first_seen_at TEXT NOT NULL,
        latest_seen_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS player_profiles_label ON player_profiles(label);

      CREATE TABLE IF NOT EXISTS union_profiles (
        union_id INTEGER PRIMARY KEY,
        label TEXT NOT NULL,
        first_name TEXT NOT NULL DEFAULT '',
        latest_name TEXT NOT NULL DEFAULT '',
        first_seen_at TEXT NOT NULL,
        latest_seen_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS union_profiles_label ON union_profiles(label);

      CREATE TABLE IF NOT EXISTS weekly_settlements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        season_id TEXT NOT NULL REFERENCES seasons(id),
        arena_key TEXT NOT NULL,
        week_key TEXT NOT NULL,
        cutoff_at TEXT NOT NULL,
        snapshot_id INTEGER REFERENCES snapshots(id),
        status TEXT NOT NULL,
        finalized_at TEXT NOT NULL,
        UNIQUE(arena_key, week_key)
      );
      CREATE INDEX IF NOT EXISTS settlements_season_arena ON weekly_settlements(season_id, arena_key, cutoff_at);

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        level TEXT NOT NULL,
        scope TEXT NOT NULL,
        message TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_created ON events(created_at DESC);
    `);
    const seasonColumns = this.db.prepare("PRAGMA table_info(seasons)").all();
    if (!seasonColumns.some((column) => column.name === "planned_weeks")) {
      this.db.exec("ALTER TABLE seasons ADD COLUMN planned_weeks INTEGER");
    }
    // Keep the legacy column for SQLite compatibility, but stop retaining its meaningless values.
    this.db.exec("UPDATE rank_entries SET power = 0 WHERE power <> 0");
    this.seedIdentityProfiles();
  }

  seedIdentityProfiles() {
    const now = new Date().toISOString();
    const missingPlayers = this.db.prepare(`
      SELECT DISTINCT re.player_id playerId
      FROM rank_entries re
      LEFT JOIN player_profiles pp ON pp.player_id = re.player_id
      WHERE pp.player_id IS NULL
    `).all();
    const playerAt = (direction) => this.db.prepare(`
      SELECT re.nickname, re.union_id unionId, sn.captured_at capturedAt
      FROM rank_entries re
      JOIN snapshots sn ON sn.id = re.snapshot_id
      WHERE re.player_id = ?
      ORDER BY sn.captured_at ${direction}, re.snapshot_id ${direction}, re.zone_index ${direction}, re.rank ${direction}
      LIMIT 1
    `);
    const firstPlayer = playerAt("ASC");
    const latestPlayer = playerAt("DESC");
    const insertPlayer = this.db.prepare(`
      INSERT INTO player_profiles(
        player_id, label, first_nickname, latest_nickname, latest_union_id,
        first_seen_at, latest_seen_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const { playerId } of missingPlayers) {
      const first = firstPlayer.get(playerId);
      const latest = latestPlayer.get(playerId) ?? first;
      if (!first) continue;
      const firstNickname = String(first.nickname ?? "").trim();
      const latestNickname = String(latest.nickname ?? "").trim() || firstNickname;
      insertPlayer.run(
        playerId, firstNickname || latestNickname || playerId, firstNickname, latestNickname,
        Number(latest.unionId) || 0, first.capturedAt, latest.capturedAt, now
      );
    }

    const missingUnions = this.db.prepare(`
      SELECT DISTINCT re.union_id unionId
      FROM rank_entries re
      LEFT JOIN union_profiles up ON up.union_id = re.union_id
      WHERE re.union_id > 0 AND up.union_id IS NULL
    `).all();
    const unionAt = (direction) => this.db.prepare(`
      SELECT re.union_name unionName, sn.captured_at capturedAt
      FROM rank_entries re
      JOIN snapshots sn ON sn.id = re.snapshot_id
      WHERE re.union_id = ?
      ORDER BY sn.captured_at ${direction}, re.snapshot_id ${direction}, re.zone_index ${direction}, re.rank ${direction}
      LIMIT 1
    `);
    const firstUnion = unionAt("ASC");
    const latestUnion = unionAt("DESC");
    const insertUnion = this.db.prepare(`
      INSERT INTO union_profiles(
        union_id, label, first_name, latest_name, first_seen_at, latest_seen_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const { unionId } of missingUnions) {
      const first = firstUnion.get(unionId);
      const latest = latestUnion.get(unionId) ?? first;
      if (!first) continue;
      const firstName = String(first.unionName ?? "").trim();
      const latestName = String(latest.unionName ?? "").trim() || firstName;
      insertUnion.run(
        unionId, firstName || latestName || String(unionId), firstName, latestName,
        first.capturedAt, latest.capturedAt, now
      );
    }
  }

  observeIdentity(player, capturedAt) {
    const playerId = String(player.playerId ?? "").trim();
    if (!playerId) return;
    const observedAt = normalizeIso(capturedAt);
    const updatedAt = new Date().toISOString();
    const nickname = String(player.nickname ?? "").trim();
    const explicitPlayerLabel = String(player.playerLabel ?? "").trim();
    const unionId = Math.max(0, Number.parseInt(player.unionId ?? 0, 10) || 0);
    const existingPlayer = this.db.prepare("SELECT * FROM player_profiles WHERE player_id = ?").get(playerId);
    if (!existingPlayer) {
      this.db.prepare(`
        INSERT INTO player_profiles(
          player_id, label, first_nickname, latest_nickname, latest_union_id,
          first_seen_at, latest_seen_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        playerId, explicitPlayerLabel || nickname || playerId, nickname, nickname, unionId,
        observedAt, observedAt, updatedAt
      );
    } else {
      const isLatest = observedAt >= existingPlayer.latest_seen_at;
      const firstNickname = existingPlayer.first_nickname || nickname;
      const inferredLabel = !existingPlayer.first_nickname && existingPlayer.label === playerId && nickname
        ? nickname
        : existingPlayer.label;
      this.db.prepare(`
        UPDATE player_profiles SET
          label = ?, first_nickname = ?, latest_nickname = ?, latest_union_id = ?,
          latest_seen_at = ?, updated_at = ?
        WHERE player_id = ?
      `).run(
        explicitPlayerLabel || inferredLabel,
        firstNickname,
        isLatest && nickname ? nickname : existingPlayer.latest_nickname,
        isLatest ? unionId : existingPlayer.latest_union_id,
        isLatest ? observedAt : existingPlayer.latest_seen_at,
        updatedAt,
        playerId
      );
    }

    if (unionId <= 0) return;
    const unionName = String(player.unionName ?? "").trim();
    const explicitUnionLabel = String(player.unionLabel ?? "").trim();
    const existingUnion = this.db.prepare("SELECT * FROM union_profiles WHERE union_id = ?").get(unionId);
    if (!existingUnion) {
      this.db.prepare(`
        INSERT INTO union_profiles(
          union_id, label, first_name, latest_name, first_seen_at, latest_seen_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        unionId, explicitUnionLabel || unionName || String(unionId), unionName, unionName,
        observedAt, observedAt, updatedAt
      );
    } else {
      const isLatest = observedAt >= existingUnion.latest_seen_at;
      const firstName = existingUnion.first_name || unionName;
      const inferredLabel = !existingUnion.first_name && existingUnion.label === String(unionId) && unionName
        ? unionName
        : existingUnion.label;
      this.db.prepare(`
        UPDATE union_profiles SET
          label = ?, first_name = ?, latest_name = ?, latest_seen_at = ?, updated_at = ?
        WHERE union_id = ?
      `).run(
        explicitUnionLabel || inferredLabel,
        firstName,
        isLatest && unionName ? unionName : existingUnion.latest_name,
        isLatest ? observedAt : existingUnion.latest_seen_at,
        updatedAt,
        unionId
      );
    }
  }

  getPlayerProfile(playerId) {
    return this.db.prepare(`
      SELECT pp.player_id playerId, pp.label playerLabel,
             pp.first_nickname firstNickname, pp.latest_nickname latestNickname,
             pp.latest_union_id latestUnionId, pp.first_seen_at firstSeenAt,
             pp.latest_seen_at latestSeenAt, pp.updated_at updatedAt,
             up.label unionLabel, up.latest_name latestUnionName
      FROM player_profiles pp
      LEFT JOIN union_profiles up ON up.union_id = pp.latest_union_id
      WHERE pp.player_id = ?
    `).get(String(playerId)) ?? null;
  }

  getUnionProfile(unionId) {
    return this.db.prepare(`
      SELECT union_id unionId, label unionLabel, first_name firstName,
             latest_name latestName, first_seen_at firstSeenAt,
             latest_seen_at latestSeenAt, updated_at updatedAt
      FROM union_profiles WHERE union_id = ?
    `).get(Number(unionId)) ?? null;
  }

  listPlayerProfiles() {
    return this.db.prepare(`
      SELECT pp.player_id playerId, pp.label playerLabel,
             pp.first_nickname firstNickname, pp.latest_nickname latestNickname,
             pp.latest_union_id latestUnionId, pp.first_seen_at firstSeenAt,
             pp.latest_seen_at latestSeenAt,
             up.label unionLabel, up.latest_name latestUnionName
      FROM player_profiles pp
      LEFT JOIN union_profiles up ON up.union_id = pp.latest_union_id
      ORDER BY pp.label COLLATE NOCASE, pp.player_id
    `).all();
  }

  listUnionProfiles() {
    return this.db.prepare(`
      SELECT union_id unionId, label unionLabel, first_name firstName,
             latest_name latestName, first_seen_at firstSeenAt, latest_seen_at latestSeenAt
      FROM union_profiles
      ORDER BY label COLLATE NOCASE, union_id
    `).all();
  }

  identityDirectory() {
    return { players: this.listPlayerProfiles(), unions: this.listUnionProfiles() };
  }

  createPlayerProfile({
    playerId = null,
    nickname = null,
    playerLabel = null,
    unionId = null,
    unionName = null,
    unionLabel = null
  }) {
    const cleanedPlayerId = String(playerId ?? "").trim();
    const cleanedNickname = String(nickname ?? "").trim();
    const cleanedPlayerLabel = String(playerLabel ?? "").trim();
    const cleanedUnionName = String(unionName ?? "").trim();
    const cleanedUnionLabel = String(unionLabel ?? "").trim();
    const rawUnionId = String(unionId ?? "").trim();
    if (!cleanedPlayerId) throw new Error("playerId is required");
    if (cleanedPlayerId.length > 64) throw new Error("playerId must be 64 characters or fewer");
    if (cleanedPlayerId === "0" || cleanedPlayerId === "-2") throw new Error("playerId is invalid");
    if (cleanedNickname.length > 80 || cleanedPlayerLabel.length > 80) {
      throw new Error("Player names and labels must be 80 characters or fewer");
    }
    if (cleanedUnionLabel.length > 80) throw new Error("unionLabel must be 80 characters or fewer");
    if (rawUnionId && !/^\d+$/.test(rawUnionId)) throw new Error("unionId must be a positive integer");
    const numericUnionId = rawUnionId ? Number.parseInt(rawUnionId, 10) : 0;
    if (rawUnionId && (!Number.isSafeInteger(numericUnionId) || numericUnionId <= 0)) {
      throw new Error("unionId must be a positive integer");
    }
    const profileNickname = cleanedNickname || cleanedPlayerLabel || cleanedPlayerId;
    const profileLabel = cleanedPlayerLabel || profileNickname;
    const now = new Date().toISOString();
    return this.transaction(() => {
      if (this.db.prepare("SELECT player_id FROM player_profiles WHERE player_id = ?").get(cleanedPlayerId)) {
        throw new Error(`Player profile already exists: ${cleanedPlayerId}`);
      }
      const existingUnion = numericUnionId > 0 ? this.getUnionProfile(numericUnionId) : null;
      this.observeIdentity({
        playerId: cleanedPlayerId,
        nickname: profileNickname,
        playerLabel: profileLabel,
        unionId: numericUnionId,
        unionName: cleanedUnionName || existingUnion?.latestName || "",
        unionLabel: cleanedUnionLabel || existingUnion?.unionLabel || (numericUnionId > 0 ? String(numericUnionId) : "")
      }, now);
      return this.getPlayerProfile(cleanedPlayerId);
    });
  }

  updateIdentityLabels({ playerId = null, playerLabel = null, unionId = null, unionLabel = null }) {
    const cleanedPlayerId = String(playerId ?? "").trim();
    const cleanedPlayerLabel = String(playerLabel ?? "").trim();
    const cleanedUnionLabel = String(unionLabel ?? "").trim();
    const numericUnionId = Number.parseInt(unionId ?? 0, 10) || 0;
    if (!cleanedPlayerId && numericUnionId <= 0) throw new Error("playerId or unionId is required");
    if (cleanedPlayerLabel.length > 80 || cleanedUnionLabel.length > 80) {
      throw new Error("Labels must be 80 characters or fewer");
    }
    this.transaction(() => {
      if (cleanedPlayerId) {
        if (!cleanedPlayerLabel) throw new Error("playerLabel is required");
        const result = this.db.prepare("UPDATE player_profiles SET label = ?, updated_at = ? WHERE player_id = ?")
          .run(cleanedPlayerLabel, new Date().toISOString(), cleanedPlayerId);
        if (result.changes === 0) throw new Error(`Player profile not found: ${cleanedPlayerId}`);
      }
      if (numericUnionId > 0) {
        if (!cleanedUnionLabel) throw new Error("unionLabel is required");
        const result = this.db.prepare("UPDATE union_profiles SET label = ?, updated_at = ? WHERE union_id = ?")
          .run(cleanedUnionLabel, new Date().toISOString(), numericUnionId);
        if (result.changes === 0) throw new Error(`Union profile not found: ${numericUnionId}`);
      }
    });
    return {
      player: cleanedPlayerId ? this.getPlayerProfile(cleanedPlayerId) : null,
      union: numericUnionId > 0 ? this.getUnionProfile(numericUnionId) : null
    };
  }

  ensureInitialSeason(season) {
    if (!season?.id) return;
    const existing = this.db.prepare("SELECT id FROM seasons WHERE id = ?").get(season.id);
    if (!existing) {
      const activeCount = this.db.prepare("SELECT COUNT(*) count FROM seasons WHERE active = 1").get().count;
      this.createSeason({ ...season, active: activeCount === 0 });
    }
  }

  createSeason({ id, label, startsAt, endsAt = null, weeks, plannedWeeks, active = false }) {
    if (!String(id ?? "").trim()) throw new Error("Season id is required");
    if (!String(label ?? "").trim()) throw new Error("Season label is required");
    const start = normalizeIso(startsAt);
    const requestedWeeks = weeks !== undefined ? weeks : plannedWeeks;
    let fixedWeeks = requestedWeeks == null || String(requestedWeeks).trim() === ""
      ? null
      : Number(requestedWeeks);
    if (fixedWeeks != null && (!Number.isInteger(fixedWeeks) || fixedWeeks < 1 || fixedWeeks > 5200)) {
      throw new Error("Season weeks must be an integer between 1 and 5200");
    }
    let end = normalizeIso(endsAt);
    if (fixedWeeks != null) {
      end = seasonEndForWeeks(start, fixedWeeks, this.config.arenas, this.config.utcOffsetMinutes).toISOString();
    }
    if (end && end <= start) throw new Error("Season end must be after its start");
    this.validateSeasonRange(String(id), start, end);
    this.transaction(() => {
      if (active) this.db.exec("UPDATE seasons SET active = 0");
      this.db.prepare(`
        INSERT INTO seasons(id, label, starts_at, ends_at, planned_weeks, active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          label = excluded.label,
          starts_at = excluded.starts_at,
          ends_at = excluded.ends_at,
          planned_weeks = excluded.planned_weeks,
          active = CASE WHEN excluded.active = 1 THEN 1 ELSE seasons.active END
      `).run(String(id), String(label), start, end, fixedWeeks, active ? 1 : 0, new Date().toISOString());
    });
    return this.getSeason(String(id));
  }

  activateSeason(id) {
    this.transaction(() => {
      const exists = this.db.prepare("SELECT id FROM seasons WHERE id = ?").get(id);
      if (!exists) throw new Error(`Season not found: ${id}`);
      this.db.exec("UPDATE seasons SET active = 0");
      this.db.prepare("UPDATE seasons SET active = 1 WHERE id = ?").run(id);
    });
    return this.getSeason(id);
  }

  getSeason(id) {
    return this.db.prepare(`
      SELECT id, label, starts_at startsAt, ends_at endsAt, planned_weeks plannedWeeks, active, created_at createdAt
      FROM seasons WHERE id = ?
    `).get(id) ?? null;
  }

  getActiveSeason() {
    return this.db.prepare(`
      SELECT id, label, starts_at startsAt, ends_at endsAt, planned_weeks plannedWeeks, active, created_at createdAt
      FROM seasons ORDER BY active DESC, starts_at DESC LIMIT 1
    `).get() ?? null;
  }

  listSeasons() {
    return this.db.prepare(`
      SELECT id, label, starts_at startsAt, ends_at endsAt, planned_weeks plannedWeeks, active, created_at createdAt
      FROM seasons ORDER BY starts_at DESC
    `).all();
  }

  seasonForCutoff(cutoff, explicitSeasonId = null) {
    const at = normalizeIso(cutoff);
    if (explicitSeasonId) {
      const season = this.getSeason(explicitSeasonId);
      if (!season) throw new Error(`Season not found: ${explicitSeasonId}`);
      if (at < season.startsAt || (season.endsAt && at > season.endsAt)) {
        throw new Error(`${season.label} does not cover ${at}`);
      }
      return season;
    }
    return this.db.prepare(`
      SELECT id, label, starts_at startsAt, ends_at endsAt, planned_weeks plannedWeeks, active
      FROM seasons
      WHERE starts_at <= ? AND (ends_at IS NULL OR ends_at >= ?)
      ORDER BY starts_at DESC LIMIT 1
    `).get(at, at) ?? null;
  }

  validateSeasonRange(id, startsAt, endsAt) {
    const others = this.db.prepare(`
      SELECT id, label, starts_at startsAt, ends_at endsAt
      FROM seasons WHERE id <> ?
    `).all(id);
    for (const other of others) {
      if (!endsAt || !other.endsAt) continue;
      const overlaps = startsAt <= (other.endsAt ?? "9999-12-31T23:59:59.999Z")
        && other.startsAt <= (endsAt ?? "9999-12-31T23:59:59.999Z");
      if (overlaps) throw new Error(`Season ${id} overlaps ${other.id} (${other.label})`);
    }
    const bounds = this.db.prepare(`
      SELECT MIN(cutoff_at) minCutoff, MAX(cutoff_at) maxCutoff
      FROM weekly_settlements WHERE season_id = ?
    `).get(id);
    if (bounds?.minCutoff && bounds.minCutoff < startsAt) {
      throw new Error(`Season ${id} starts after an existing settlement`);
    }
    if (bounds?.maxCutoff && endsAt && bounds.maxCutoff > endsAt) {
      throw new Error(`Season ${id} ends before an existing settlement`);
    }
  }

  saveSnapshot({ arena, capturedAt, zones, body = null, source = "scheduled" }) {
    const entries = zones.flatMap((zone) => zone.players.map((player) => ({ zone, player })));
    const expectedZoneCount = Math.max(arena.zones?.length ?? 0, zones.length);
    const expectedEntryCount = expectedZoneCount * 5;
    const capturedIso = normalizeIso(capturedAt);
    return this.transaction(() => {
      const result = this.db.prepare(`
        INSERT INTO snapshots(arena_key, captured_at, source, status, zone_count, entry_count, expected_entry_count, raw_json)
        VALUES (?, ?, ?, 'success', ?, ?, ?, ?)
      `).run(arena.key, capturedIso, source, zones.length, entries.length, expectedEntryCount, json(body));
      const snapshotId = Number(result.lastInsertRowid);
      const insert = this.db.prepare(`
        INSERT INTO rank_entries(
          snapshot_id, arena_key, zone_index, server_zone_id, zone_name, rank, player_id, nickname,
          clothes, vip_level, union_id, union_name, union_icon, nickname_card
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const { zone, player } of entries) {
        insert.run(
          snapshotId, arena.key, zone.index, zone.serverZoneId, zone.name, player.rank,
          String(player.playerId), String(player.nickname ?? ""), String(player.clothes ?? ""),
          Number(player.vipLevel) || 0, Number(player.unionId) || 0,
          String(player.unionName ?? ""), Number(player.unionIcon) || 0, String(player.nicknameCard ?? "")
        );
        this.observeIdentity(player, capturedIso);
      }
      return snapshotId;
    });
  }

  saveFailedSnapshot({ arena, capturedAt, error, source = "scheduled" }) {
    const result = this.db.prepare(`
      INSERT INTO snapshots(arena_key, captured_at, source, status, error)
      VALUES (?, ?, ?, 'error', ?)
    `).run(arena.key, normalizeIso(capturedAt), source, String(error?.message ?? error));
    return Number(result.lastInsertRowid);
  }

  cleanupSnapshots({ before } = {}) {
    const cutoff = normalizeIso(before ?? new Date());
    return this.transaction(() => {
      const result = this.db.prepare(`
        DELETE FROM snapshots
        WHERE captured_at < ?
          AND NOT EXISTS (
            SELECT 1 FROM weekly_settlements ws WHERE ws.snapshot_id = snapshots.id
          )
      `).run(cutoff);
      return Number(result.changes);
    });
  }

  latestSnapshot(arenaKey) {
    const snapshot = this.db.prepare(`
      SELECT * FROM snapshots WHERE arena_key = ? AND status = 'success'
      ORDER BY captured_at DESC LIMIT 1
    `).get(arenaKey);
    if (!snapshot) return null;
    const rows = this.db.prepare(`
      SELECT re.*, pp.label player_label, up.label union_label
      FROM rank_entries re
      LEFT JOIN player_profiles pp ON pp.player_id = re.player_id
      LEFT JOIN union_profiles up ON up.union_id = re.union_id
      WHERE re.snapshot_id = ?
      ORDER BY re.zone_index, re.rank
    `).all(snapshot.id);
    return mapSnapshotRows(snapshot, rows);
  }

  getSnapshot(id) {
    const snapshot = this.db.prepare("SELECT * FROM snapshots WHERE id = ?").get(id);
    if (!snapshot) return null;
    const rows = this.db.prepare(`
      SELECT re.*, pp.label player_label, up.label union_label
      FROM rank_entries re
      LEFT JOIN player_profiles pp ON pp.player_id = re.player_id
      LEFT JOIN union_profiles up ON up.union_id = re.union_id
      WHERE re.snapshot_id = ?
      ORDER BY re.zone_index, re.rank
    `).all(id);
    return mapSnapshotRows(snapshot, rows);
  }

  finalizeWeek({ arena, weekKey, seasonId = null, finalizedAt = new Date(), snapshotId = null }) {
    const { start, cutoff } = weekWindow(weekKey, arena, this.config.utcOffsetMinutes);
    const graceEnd = new Date(cutoff.getTime() + this.config.settlementGraceMinutes * 60_000);
    let snapshot = snapshotId
      ? this.db.prepare("SELECT * FROM snapshots WHERE id = ? AND arena_key = ? AND status = 'success'").get(snapshotId, arena.key)
      : null;
    if (!snapshot && !snapshotId) {
      snapshot = this.db.prepare(`
        SELECT * FROM snapshots
        WHERE arena_key = ? AND status = 'success' AND captured_at >= ? AND captured_at <= ?
        ORDER BY captured_at ASC LIMIT 1
      `).get(arena.key, cutoff.toISOString(), graceEnd.toISOString());
      snapshot ??= this.db.prepare(`
        SELECT * FROM snapshots
        WHERE arena_key = ? AND status = 'success' AND captured_at >= ? AND captured_at < ?
        ORDER BY captured_at DESC LIMIT 1
      `).get(arena.key, start.toISOString(), cutoff.toISOString());
    }
    const season = this.seasonForCutoff(cutoff, seasonId);
    if (!season) throw new Error(`No season covers ${cutoff.toISOString()}`);
    const status = !snapshot
      ? "missing"
      : snapshot.entry_count < snapshot.expected_entry_count ? "partial" : "final";
    this.db.prepare(`
      INSERT INTO weekly_settlements(season_id, arena_key, week_key, cutoff_at, snapshot_id, status, finalized_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(arena_key, week_key) DO UPDATE SET
        season_id = excluded.season_id,
        cutoff_at = excluded.cutoff_at,
        snapshot_id = excluded.snapshot_id,
        status = excluded.status,
        finalized_at = excluded.finalized_at
    `).run(
      season.id, arena.key, weekKey, cutoff.toISOString(), snapshot?.id ?? null,
      status, normalizeIso(finalizedAt)
    );
    this.addEvent(status === "missing" ? "warn" : "info", "settlement", `${arena.name} ${weekKey} settled as ${status}`);
    return this.getSettlement(arena.key, weekKey);
  }

  getSettlement(arenaKey, weekKey) {
    const row = this.db.prepare(`
      SELECT ws.id, ws.season_id seasonId, ws.arena_key arenaKey, ws.week_key weekKey,
             ws.cutoff_at cutoffAt, ws.snapshot_id snapshotId, ws.status, ws.finalized_at finalizedAt,
             s.label seasonLabel, sn.entry_count entryCount, sn.expected_entry_count expectedEntryCount,
             sn.zone_count zoneCount, sn.captured_at capturedAt
      FROM weekly_settlements ws
      JOIN seasons s ON s.id = ws.season_id
      LEFT JOIN snapshots sn ON sn.id = ws.snapshot_id
      WHERE ws.arena_key = ? AND ws.week_key = ?
    `).get(arenaKey, weekKey);
    if (!row) return null;
    return { ...row, snapshot: row.snapshotId ? this.getSnapshot(row.snapshotId) : null };
  }

  listSettlements({ seasonId = null, arenaKey = null } = {}) {
    const where = [];
    const params = [];
    if (seasonId) {
      where.push("ws.season_id = ?");
      params.push(seasonId);
    }
    if (arenaKey) {
      where.push("ws.arena_key = ?");
      params.push(arenaKey);
    }
    return this.db.prepare(`
      SELECT ws.id, ws.season_id seasonId, ws.arena_key arenaKey, ws.week_key weekKey,
             ws.cutoff_at cutoffAt, ws.snapshot_id snapshotId, ws.status, ws.finalized_at finalizedAt,
             s.label seasonLabel, sn.entry_count entryCount, sn.expected_entry_count expectedEntryCount,
             sn.zone_count zoneCount, sn.captured_at capturedAt
      FROM weekly_settlements ws
      JOIN seasons s ON s.id = ws.season_id
      LEFT JOIN snapshots sn ON sn.id = ws.snapshot_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY ws.cutoff_at DESC
    `).all(...params);
  }

  weeklyRows({ seasonIds, arenaKey = null, playerId = null }) {
    if (!seasonIds?.length) return [];
    const placeholders = seasonIds.map(() => "?").join(",");
    const where = [`ws.season_id IN (${placeholders})`, "ws.snapshot_id IS NOT NULL", "re.rank <= 5"];
    const params = [...seasonIds];
    if (arenaKey) {
      where.push("ws.arena_key = ?");
      params.push(arenaKey);
    }
    if (playerId) {
      where.push("re.player_id = ?");
      params.push(playerId);
    }
    return this.db.prepare(`
      SELECT ws.season_id seasonId, ws.arena_key arenaKey, ws.week_key weekKey, ws.cutoff_at cutoffAt,
             sn.captured_at capturedAt, re.zone_index zoneIndex, re.server_zone_id serverZoneId,
             re.zone_name zoneName, re.rank, re.player_id playerId, re.nickname,
             pp.label playerLabel, re.union_id unionId, re.union_name unionName,
             up.label unionLabel, re.clothes
      FROM weekly_settlements ws
      JOIN snapshots sn ON sn.id = ws.snapshot_id
      JOIN rank_entries re ON re.snapshot_id = ws.snapshot_id
      LEFT JOIN player_profiles pp ON pp.player_id = re.player_id
      LEFT JOIN union_profiles up ON up.union_id = re.union_id
      WHERE ${where.join(" AND ")}
      ORDER BY ws.cutoff_at, re.zone_index, re.rank
    `).all(...params);
  }

  stats({ seasonIds, arenaKey = null }) {
    const rows = this.weeklyRows({ seasonIds, arenaKey });
    const placeholders = seasonIds.map(() => "?").join(",");
    const params = [...seasonIds];
    const arenaClause = arenaKey ? "AND arena_key = ?" : "";
    if (arenaKey) params.push(arenaKey);
    const settlementWeeks = this.db.prepare(`
      SELECT DISTINCT season_id seasonId, week_key weekKey, cutoff_at cutoffAt, arena_key arenaKey, status
      FROM weekly_settlements
      WHERE season_id IN (${placeholders}) AND status IN ('final', 'partial') ${arenaClause}
      ORDER BY cutoff_at
    `).all(...params);
    const allWeekRows = this.db.prepare(`
      SELECT DISTINCT season_id seasonId, week_key weekKey, cutoff_at cutoffAt, arena_key arenaKey, status
      FROM weekly_settlements
      WHERE season_id IN (${placeholders}) ${arenaClause}
      ORDER BY cutoff_at
    `).all(...params);
    const timeline = this.buildStatsTimeline(seasonIds, arenaKey, allWeekRows);
    const uniqueTimeline = new Map(timeline.map((week) => [`${week.seasonId}:${week.weekKey}`, week]));
    const elapsedTimeline = timeline.filter((week) => week.status !== "future");
    return {
      ...calculateStandings(rows, settlementWeeks, elapsedTimeline),
      weeks: settlementWeeks,
      timelineWeeks: timeline,
      expectedWeekCount: uniqueTimeline.size,
      elapsedWeekCount: elapsedTimeline.length,
      missingWeekCount: [...uniqueTimeline.values()].filter((week) => week.status === "missing").length,
      partialWeekCount: [...uniqueTimeline.values()].filter((week) => week.status === "partial").length,
      futureWeekCount: [...uniqueTimeline.values()].filter((week) => week.status === "future").length,
      rows
    };
  }

  buildStatsTimeline(seasonIds, arenaKey, recordedWeeks, now = new Date()) {
    const recorded = new Map(recordedWeeks.map((week) => [
      `${week.seasonId}:${week.arenaKey}:${week.weekKey}`,
      week
    ]));
    const timeline = new Map(recorded);
    for (const seasonId of seasonIds) {
      const season = this.getSeason(seasonId);
      if (!season) continue;
      const arenas = arenaKey
        ? this.config.arenas.filter((arena) => arena.key === arenaKey)
        : this.config.arenas;
      for (const arena of arenas) {
        const scoped = recordedWeeks.filter((week) => week.seasonId === seasonId && week.arenaKey === arena.key);
        const timelineNow = season.endsAt || season.active || !scoped.length
          ? now
          : new Date(scoped.at(-1).cutoffAt);
        for (const weekKey of seasonSettlementWeeks(season, arena, this.config.utcOffsetMinutes, timelineNow)) {
          const key = `${seasonId}:${arena.key}:${weekKey}`;
          if (!timeline.has(key)) {
            timeline.set(key, {
              seasonId,
              arenaKey: arena.key,
              weekKey,
              cutoffAt: cutoffForWeek(weekKey, arena, this.config.utcOffsetMinutes).toISOString(),
              status: cutoffForWeek(weekKey, arena, this.config.utcOffsetMinutes).getTime() > now.getTime()
                ? "future"
                : "missing"
            });
          }
        }
      }
    }
    return [...timeline.values()].sort((a, b) => a.cutoffAt.localeCompare(b.cutoffAt));
  }

  seasonStats(seasonId, arenaKey) {
    const season = this.getSeason(seasonId);
    if (!season) throw new Error(`Season not found: ${seasonId}`);
    return { season, arenaKey, ...this.stats({ seasonIds: [seasonId], arenaKey }) };
  }

  hallStats({ throughSeasonId = null, arenaKey, window = this.config.hallSeasonWindow }) {
    const seasons = this.listSeasons();
    const through = throughSeasonId
      ? seasons.find((season) => season.id === String(throughSeasonId))
      : seasons[0];
    if (!through) throw new Error(`Season not found: ${throughSeasonId}`);
    if (!Number.isInteger(window) || window < 1) throw new Error("Hall season window must be a positive integer");

    const numericId = (season) => /^\d+$/.test(season.id) ? Number.parseInt(season.id, 10) : null;
    const throughNumber = numericId(through);
    let selected = [through];

    // The H5 client combines seasons from season 29 in fixed blocks, not a rolling window.
    if (window > 1 && throughNumber != null && throughNumber >= HALL_CYCLE_START_SEASON) {
      const cycleStart = HALL_CYCLE_START_SEASON
        + Math.floor((throughNumber - HALL_CYCLE_START_SEASON) / window) * window;
      selected = seasons
        .filter((season) => {
          const seasonNumber = numericId(season);
          return seasonNumber != null && seasonNumber >= cycleStart && seasonNumber <= throughNumber;
        })
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    }

    return { seasons: selected, arenaKey, window, ...this.stats({ seasonIds: selected.map((season) => season.id), arenaKey }) };
  }

  searchPlayers({ seasonId, arenaKey = null, query = "", limit = 100 }) {
    const stats = this.seasonStats(seasonId, arenaKey);
    const needle = query.trim().toLowerCase();
    const contains = (value) => String(value ?? "").toLowerCase().includes(needle);
    return {
      ...stats,
      standings: stats.standings.filter((player) =>
        !needle
        || contains(player.playerId)
        || contains(player.nickname)
        || contains(player.playerLabel)
        || contains(player.unionName)
        || contains(player.unionLabel)
      ).slice(0, Math.min(Math.max(limit, 1), 500)),
      rows: undefined
    };
  }

  playerHistory({ playerId, seasonId, arenaKey = null }) {
    const rows = this.weeklyRows({ seasonIds: [seasonId], arenaKey, playerId });
    if (rows.length === 0) {
      const profile = this.getPlayerProfile(playerId);
      if (!profile) return null;
      return {
        player: {
          playerId: profile.playerId,
          nickname: profile.latestNickname || profile.playerLabel || profile.playerId,
          playerLabel: profile.playerLabel || profile.latestNickname || profile.playerId,
          unionId: Number(profile.latestUnionId) || 0,
          unionName: profile.latestUnionName || "未加入联盟",
          unionLabel: profile.unionLabel || profile.latestUnionName || "未加入联盟",
          emperorCount: 0,
          rankOneCount: 0,
          currentStreak: 0,
          longestStreak: 0,
          weeks: [],
          arenas: [],
          zones: [],
          lastSeenAt: profile.latestSeenAt || profile.firstSeenAt,
          lastRank: null
        },
        history: []
      };
    }
    const stats = this.seasonStats(seasonId, arenaKey).standings.find((item) => item.playerId === playerId);
    return { player: stats, history: rows.sort((a, b) => b.cutoffAt.localeCompare(a.cutoffAt)) };
  }

  addEvent(level, scope, message, createdAt = new Date()) {
    this.db.prepare(`INSERT INTO events(created_at, level, scope, message) VALUES (?, ?, ?, ?)`)
      .run(normalizeIso(createdAt), level, scope, String(message));
  }

  listEvents(limit = 100) {
    return this.db.prepare(`
      SELECT id, created_at createdAt, level, scope, message
      FROM events ORDER BY created_at DESC LIMIT ?
    `).all(Math.min(Math.max(limit, 1), 500));
  }

  counts() {
    return {
      snapshots: this.db.prepare("SELECT COUNT(*) count FROM snapshots WHERE status = 'success'").get().count,
      settlements: this.db.prepare("SELECT COUNT(*) count FROM weekly_settlements WHERE status IN ('final', 'partial')").get().count,
      players: this.db.prepare("SELECT COUNT(DISTINCT player_id) count FROM rank_entries").get().count
    };
  }

  transaction(callback) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.db.close();
  }
}
