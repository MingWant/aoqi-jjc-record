import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const appRoot = path.resolve(moduleDir, "..");

const envFile = path.join(appRoot, ".env");
if (fs.existsSync(envFile) && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(envFile);
}

function integer(name, fallback, minimum = Number.MIN_SAFE_INTEGER) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function text(name, fallback = "") {
  const value = process.env[name];
  return value == null ? fallback : value.trim();
}

function resolveDataFile(value) {
  return path.isAbsolute(value) ? value : path.resolve(appRoot, value);
}

function loadArenas() {
  const configuredPath = text("ARENA_CONFIG_FILE", path.join("config", "arenas.json"));
  const absolutePath = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(appRoot, configuredPath);
  const parsed = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Arena configuration must contain at least one arena");
  }
  const keys = new Set();
  for (const arena of parsed) {
    if (!arena.key || !arena.name || !Number.isInteger(arena.protocolType)) {
      throw new Error("Each arena requires key, name, and integer protocolType");
    }
    if (keys.has(arena.key)) throw new Error(`Duplicate arena key: ${arena.key}`);
    keys.add(arena.key);
    arena.settlementWeekday ??= 4;
    arena.settlementTime ??= "21:00:00";
    arena.rankingUpdateWeekday ??= 5;
    arena.rankingUpdateTime ??= "05:00:00";
    arena.zones = Array.isArray(arena.zones) ? arena.zones : [];
  }
  return parsed;
}

export function loadConfig(overrides = {}) {
  const loginMode = text("ARENA_LOGIN_MODE", "account");
  if (!new Set(["account", "username"]).has(loginMode)) {
    throw new Error("ARENA_LOGIN_MODE must be account or username");
  }

  const config = {
    host: text("HOST", "127.0.0.1"),
    port: integer("PORT", 8787, 1),
    dataFile: resolveDataFile(text("DATA_FILE", "./data/arena-tracker.sqlite")),
    timezone: text("ARENA_TIMEZONE", "Asia/Shanghai"),
    utcOffsetMinutes: integer("ARENA_UTC_OFFSET_MINUTES", 480, -720),
    pollIntervalSeconds: integer("ARENA_POLL_INTERVAL_SECONDS", 300, 15),
    finalPollIntervalSeconds: integer("ARENA_FINAL_POLL_INTERVAL_SECONDS", 30, 10),
    finalCaptureWindowMinutes: integer("ARENA_FINAL_CAPTURE_WINDOW_MINUTES", 15, 1),
    settlementGraceMinutes: integer("ARENA_SETTLEMENT_GRACE_MINUTES", 3, 0),
    requestTimeoutMs: integer("ARENA_REQUEST_TIMEOUT_MS", 12000, 1000),
    collectionRetries: integer("ARENA_COLLECTION_RETRIES", 1, 0),
    hallSeasonWindow: integer("ARENA_HALL_SEASON_WINDOW", 3, 1),
    accessToken: text("ACCESS_TOKEN"),
    adminToken: text("ADMIN_TOKEN"),
    logLevel: text("LOG_LEVEL", "info"),
    demoMode: text("ARENA_DEMO_MODE") === "1",
    login: {
      mode: loginMode,
      account: text("ARENA_ACCOUNT"),
      username: text("ARENA_USERNAME"),
      password: process.env.ARENA_PASSWORD ?? "",
      zonePreference: text("ARENA_ZONE_PREFERENCE"),
      baseUrl: text("ARENA_LOGIN_BASE_URL", "http://login2-aoqi.100bt.com"),
      path: text("ARENA_LOGIN_PATH", "/newLogin")
    },
    initialSeason: {
      id: text("ARENA_SEASON_ID", "32"),
      label: text("ARENA_SEASON_LABEL", "第32届"),
      startsAt: text("ARENA_SEASON_START", "2026-07-03T12:00:00+08:00"),
      endsAt: text("ARENA_SEASON_END") || null,
      weeks: integer("ARENA_SEASON_WEEKS", null, 1)
    },
    arenas: loadArenas()
  };
  return Object.assign(config, overrides);
}

export function hasCollectorCredentials(config) {
  const identity = config.login.mode === "username"
    ? config.login.username
    : config.login.account;
  return Boolean(identity && config.login.password);
}

export function publicConfig(config) {
  return {
    timezone: config.timezone,
    utcOffsetMinutes: config.utcOffsetMinutes,
    pollIntervalSeconds: config.pollIntervalSeconds,
    collectionRetries: config.collectionRetries,
    hallSeasonWindow: config.hallSeasonWindow,
    credentialsConfigured: hasCollectorCredentials(config),
    accessProtected: Boolean(config.accessToken),
    adminProtected: Boolean(config.adminToken),
    demoMode: config.demoMode,
    arenas: config.arenas
  };
}
