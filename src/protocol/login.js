import crypto from "node:crypto";

function decodeXml(value) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

export function parseFlatXml(xml) {
  const result = {};
  const cdata = /<([A-Za-z_][\w.-]*)\b[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/\1>/g;
  let match;
  while ((match = cdata.exec(xml)) !== null) result[match[1]] = match[2];
  const child = /<([A-Za-z_][\w.-]*)\b[^>]*>([^<]*)<\/\1>/g;
  while ((match = child.exec(xml)) !== null) {
    if (!(match[1] in result)) result[match[1]] = decodeXml(match[2].trim());
  }
  if (Object.keys(result).length === 0) throw new Error("Login response was not recognized as flat XML");
  return result;
}

export function parseServers(raw) {
  return String(raw ?? "")
    .split(";")
    .map((item) => item.trim())
    .filter((item) => item && item.endsWith(":0"))
    .map((item) => {
      const parts = item.split(":");
      return { host: parts[0].trim(), port: Number.parseInt(parts[1], 10) };
    })
    .filter((server) => server.host && Number.isInteger(server.port) && server.port > 0);
}

export function resolveServer(loginResponse, preferredZone = "") {
  const servers = parseServers(loginResponse?.svr);
  const zones = String(loginResponse?.zn ?? "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [zone, ...rawValues] = item.split("/");
      const values = rawValues.filter((value) => value.trim() !== "").map(Number);
      const server = servers[values[0]];
      return server && zone && !zone.toLowerCase().includes("test")
        ? { zone: zone.trim(), values, ...server }
        : null;
    })
    .filter(Boolean);
  if (zones.length === 0) return null;
  const wanted = preferredZone.trim().toLowerCase();
  if (!wanted) return zones[0];
  return zones.find((item) => item.zone.toLowerCase() === wanted)
    ?? zones.find((item) => item.zone.toLowerCase().includes(wanted))
    ?? zones[0];
}

async function fetchText(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveAccount(username, timeoutMs) {
  const url = new URL("http://login2-aoqi.100bt.com/newUserQuery.jsp");
  url.searchParams.set("name", username.trim());
  const raw = await fetchText(url, { method: "GET" }, timeoutMs);
  const result = JSON.parse(raw);
  if (Number(result?.code) !== 0 || !result?.duoduoId) {
    throw new Error(`Username lookup failed: ${result?.detail ?? raw.slice(0, 200)}`);
  }
  return String(result.duoduoId);
}

export async function loginHttp(config, logger = () => {}) {
  const timeoutMs = config.requestTimeoutMs ?? 12000;
  const account = config.login.mode === "username"
    ? await resolveAccount(config.login.username, timeoutMs)
    : config.login.account;
  if (!account || !config.login.password) throw new Error("Collector account credentials are not configured");

  const url = new URL(config.login.path, config.login.baseUrl.endsWith("/") ? config.login.baseUrl : `${config.login.baseUrl}/`);
  const form = new URLSearchParams({
    account,
    password: crypto.createHash("md5").update(config.login.password, "utf8").digest("hex"),
    logintype: "",
    wyToken: "",
    fromurl: "",
    webSite: "",
    token: "",
    cookieId: "",
    pi: "",
    sessionId: "",
    content: ""
  });
  logger("info", `HTTP login started for account ${account}`);
  const raw = await fetchText(url, {
    method: "POST",
    headers: {
      Accept: "*/*",
      "Accept-Language": "zh-CN",
      "Content-Type": "application/x-www-form-urlencoded",
      Pragma: "no-cache",
      Referer: "http://aoqi.100bt.com/play/start.swf/1/1",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ArenaRankTracker/1.0",
      "x-flash-version": "34,0,0,321"
    },
    body: form
  }, timeoutMs);
  const response = parseFlatXml(raw);
  if (response.c !== "ok") throw new Error(`HTTP login failed with c=${response.c ?? "missing"}`);
  if (!response.sid) throw new Error("HTTP login succeeded without sid");
  const server = resolveServer(response, config.login.zonePreference);
  if (!server) throw new Error("HTTP login succeeded without a usable game server");
  return { account, sessionId: response.sid, server, raw: response };
}
