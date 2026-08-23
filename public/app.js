import { formElementId, plannedEndLocalValue } from "./form-utils.js";

const state = {
  view: "overview",
  arenaKey: "classic",
  seasonId: null,
  hallWindow: null,
  hallMode: "matrix",
  bootstrap: null,
  weekKey: null,
  weekDetail: null,
  playerQuery: "",
  selectedPlayerId: null,
  playerDetail: null,
  backfillWeekKey: null,
  backfillMode: "matrix",
  backfillRows: null,
  backfillLoadedKey: null,
  backfillDirty: false,
  backfillLoading: false,
  matrixSignature: null,
  matrixWeekKeys: [],
  matrixPlayerIds: [],
  matrixSelections: null,
  matrixOriginalSelections: null,
  matrixDirty: false,
  seasonEditingId: null,
  accessConfigured: null,
  accessVerified: false,
  adminVerified: false,
  loading: false
};

const viewTitles = {
  overview: ["竞技场统计", "竞技场届次总览"],
  weeks: ["竞技场统计", "周结算"],
  players: ["竞技场统计", "玩家档案"],
  hall: ["竞技场统计", "名人堂候选"],
  backfill: ["数据维护", "历史周榜补录"],
  system: ["运行状态", "采集与届次管理"]
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const ACCESS_TOKEN_KEY = "arenaAccessToken";
const ADMIN_TOKEN_KEY = "arenaAdminToken";
const BACKFILL_FIELDS = ["playerId", "nickname", "playerLabel", "unionId", "unionName", "unionLabel"];

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function number(value) {
  return new Intl.NumberFormat("zh-CN").format(Number(value) || 0);
}

function shortDate(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: state.bootstrap?.config?.timezone || "Asia/Shanghai",
    month: "numeric",
    day: "numeric"
  }).format(date);
}

function dateTime(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: state.bootstrap?.config?.timezone || "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function dateTimeLocalValue(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en", {
    timeZone: state.bootstrap?.config?.timezone || "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function currentArena() {
  return state.bootstrap?.config?.arenas?.find((arena) => arena.key === state.arenaKey)
    || state.bootstrap?.config?.arenas?.[0]
    || { key: state.arenaKey, name: state.arenaKey, zones: [] };
}

function playerDirectory() {
  return state.bootstrap?.directory?.players || [];
}

function unionDirectory() {
  return state.bootstrap?.directory?.unions || [];
}

function findPlayerProfile(playerId) {
  const id = String(playerId ?? "").trim();
  return playerDirectory().find((profile) => profile.playerId === id) || null;
}

function findUnionProfile(unionId) {
  const id = Number.parseInt(unionId ?? 0, 10) || 0;
  return unionDirectory().find((profile) => Number(profile.unionId) === id) || null;
}

function hydrateUnionRow(row, { onlyEmpty = false } = {}) {
  const profile = findUnionProfile(row.unionId);
  if (!profile) return false;
  if (!onlyEmpty || !row.unionName.trim()) row.unionName = profile.latestName || profile.unionLabel || "";
  if (!onlyEmpty || !row.unionLabel.trim()) row.unionLabel = profile.unionLabel || profile.latestName || "";
  return true;
}

function hydratePlayerRow(row, { onlyEmpty = false } = {}) {
  const profile = findPlayerProfile(row.playerId);
  if (!profile) return false;
  if (!onlyEmpty || !row.nickname.trim()) row.nickname = profile.latestNickname || profile.playerLabel || row.playerId;
  if (!onlyEmpty || !row.playerLabel.trim()) row.playerLabel = profile.playerLabel || profile.latestNickname || row.playerId;
  if (!onlyEmpty || !row.unionId.trim()) {
    row.unionId = Number(profile.latestUnionId) > 0 ? String(profile.latestUnionId) : "";
  }
  if (row.unionId) hydrateUnionRow(row, { onlyEmpty });
  else if (!onlyEmpty) {
    row.unionName = "";
    row.unionLabel = "";
  }
  return true;
}

function mostRecentSettlementKey(arena, now = new Date()) {
  const offsetMinutes = state.bootstrap?.config?.utcOffsetMinutes ?? 480;
  const local = new Date(now.getTime() + offsetMinutes * 60_000);
  const updateWeekday = arena.rankingUpdateWeekday ?? 5;
  let daysBack = (local.getUTCDay() - updateWeekday + 7) % 7;
  if (daysBack === 0) {
    const [hour = 5, minute = 0, second = 0] = String(arena.rankingUpdateTime ?? "05:00:00")
      .split(":")
      .map((value) => Number.parseInt(value, 10));
    const currentSeconds = local.getUTCHours() * 3600 + local.getUTCMinutes() * 60 + local.getUTCSeconds();
    if (currentSeconds < hour * 3600 + minute * 60 + second) daysBack = 7;
  }
  local.setUTCDate(local.getUTCDate() - daysBack);
  local.setUTCDate(local.getUTCDate() - ((updateWeekday - (arena.settlementWeekday ?? 4) + 7) % 7));
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, "0")}-${String(local.getUTCDate()).padStart(2, "0")}`;
}

function dateKeyFromLocal(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function addLocalDateKey(key, days) {
  const [year, month, day] = key.split("-").map((value) => Number.parseInt(value, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return dateKeyFromLocal(date);
}

function settlementWeekKeys() {
  const arena = currentArena();
  const season = state.bootstrap?.seasons?.find((item) => item.id === state.seasonId);
  if (!season) return [];
  const offsetMinutes = state.bootstrap?.config?.utcOffsetMinutes ?? 480;
  const startLocal = new Date(new Date(season.startsAt).getTime() + offsetMinutes * 60_000);
  const targetWeekday = arena.settlementWeekday ?? 4;
  let first = dateKeyFromLocal(startLocal);
  let daysUntil = (targetWeekday - startLocal.getUTCDay() + 7) % 7;
  if (daysUntil === 0) {
    const [hour = 21, minute = 0, second = 0] = String(arena.settlementTime ?? "21:00:00")
      .split(":")
      .map((value) => Number.parseInt(value, 10));
    const seconds = startLocal.getUTCHours() * 3600 + startLocal.getUTCMinutes() * 60 + startLocal.getUTCSeconds();
    if (seconds > hour * 3600 + minute * 60 + second) daysUntil = 7;
  }
  first = addLocalDateKey(first, daysUntil);
  const last = season.endsAt
    ? dateKeyFromLocal(new Date(new Date(season.endsAt).getTime() + offsetMinutes * 60_000))
    : mostRecentSettlementKey(arena);
  const keys = [];
  for (let key = first; key <= last; key = addLocalDateKey(key, 7)) keys.push(key);
  for (const item of arenaData().settlements || []) {
    if (!keys.includes(item.weekKey) && item.weekKey <= last) keys.push(item.weekKey);
  }
  return keys.sort();
}

function matrixSelectionSignature(selections, weekKeys) {
  return weekKeys.map((weekKey) => [...(selections?.[weekKey] || new Set())].sort().join(",")).join("|");
}

function ensureBackfillMatrix() {
  const weekKeys = settlementWeekKeys();
  const statsPlayerIds = (arenaData().stats?.standings || []).map((player) => player.playerId).sort();
  const signature = `${state.seasonId}:${state.arenaKey}:${weekKeys.join(",")}:${statsPlayerIds.join(",")}`;
  if (state.matrixSignature === signature && state.matrixSelections) return;
  const stats = arenaData().stats;
  const selections = Object.fromEntries(weekKeys.map((weekKey) => [weekKey, new Set()]));
  for (const player of stats?.standings || []) {
    for (const weekKey of player.weeks || []) {
      if (selections[weekKey]) selections[weekKey].add(player.playerId);
    }
  }
  state.matrixSignature = signature;
  state.matrixWeekKeys = weekKeys;
  state.matrixPlayerIds = (stats?.standings || []).map((player) => player.playerId);
  state.matrixSelections = selections;
  state.matrixOriginalSelections = Object.fromEntries(weekKeys.map((weekKey) => [weekKey, new Set(selections[weekKey])]));
  state.matrixDirty = false;
}

function resetBackfillMatrix() {
  state.matrixSignature = null;
  state.matrixWeekKeys = [];
  state.matrixPlayerIds = [];
  state.matrixSelections = null;
  state.matrixOriginalSelections = null;
  state.matrixDirty = false;
}

function emptyBackfillRows() {
  return currentArena().zones.flatMap((zone) => [1, 2, 3, 4, 5].map((rank) => ({
    zoneIndex: zone.index,
    rank,
    playerId: "",
    nickname: "",
    playerLabel: "",
    unionId: "",
    unionName: "",
    unionLabel: ""
  })));
}

function resetBackfillEditor(weekKey = null) {
  state.backfillWeekKey = weekKey || mostRecentSettlementKey(currentArena());
  state.backfillRows = emptyBackfillRows();
  state.backfillLoadedKey = null;
  state.backfillDirty = false;
}

function ensureBackfillEditor() {
  if (!state.backfillWeekKey || !Array.isArray(state.backfillRows)) resetBackfillEditor();
}

function filledBackfillCount() {
  return (state.backfillRows || []).filter((row) => row.playerId.trim()).length;
}

function canDiscardBackfillDraft() {
  return (!state.backfillDirty && !state.matrixDirty)
    || window.confirm("当前补录表有未保存修改，确定放弃吗？");
}

function arenaData() {
  return state.bootstrap?.arenas?.[state.arenaKey] || { latest: null, stats: null, hall: null, settlements: [] };
}

function accessToken() {
  return sessionStorage.getItem(ACCESS_TOKEN_KEY) || "";
}

function showAccessGate(message = "", { disabled = false } = {}) {
  state.accessVerified = false;
  $(".app-shell").hidden = true;
  $("#access-gate").hidden = false;
  $("#access-message").textContent = message;
  $("#access-token").disabled = disabled;
  $("#access-submit").disabled = disabled;
  if (!disabled) requestAnimationFrame(() => $("#access-token")?.focus());
}

function showApplication() {
  state.accessConfigured = true;
  state.accessVerified = true;
  $("#access-gate").hidden = true;
  $(".app-shell").hidden = false;
}

function accessRequestError(response, body) {
  const error = new Error(body.error || `请求失败 (${response.status})`);
  error.status = response.status;
  error.code = body.code;
  error.isAccessError = error.code === "ACCESS_DENIED" || error.code === "ACCESS_NOT_CONFIGURED";
  return error;
}

async function verifyAccess(value) {
  const response = await fetch("/api/access/verify", {
    method: "POST",
    headers: { "X-Access-Token": value }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw accessRequestError(response, body);
  return true;
}

async function initializeAccess() {
  try {
    const response = await fetch("/api/access/status", { headers: { "Accept": "application/json" } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw accessRequestError(response, body);
    state.accessConfigured = Boolean(body.configured);
    if (!state.accessConfigured) {
      showAccessGate("服务端尚未配置 ACCESS_TOKEN，请配置后重启服务。", { disabled: true });
      return;
    }
    const stored = accessToken();
    if (!stored) {
      showAccessGate();
      return;
    }
    await verifyAccess(stored);
    showApplication();
    await loadBootstrap();
  } catch (error) {
    sessionStorage.removeItem(ACCESS_TOKEN_KEY);
    sessionStorage.removeItem(ADMIN_TOKEN_KEY);
    showAccessGate(error.message || "无法连接服务");
  }
}

async function submitAccessForm() {
  const input = $("#access-token");
  const button = $("#access-submit");
  const value = input.value.trim();
  if (!value) return;
  button.disabled = true;
  $("#access-message").textContent = "";
  try {
    await verifyAccess(value);
    sessionStorage.setItem(ACCESS_TOKEN_KEY, value);
    input.value = "";
    showApplication();
    await loadBootstrap();
  } catch (error) {
    sessionStorage.removeItem(ACCESS_TOKEN_KEY);
    if (error.code === "ACCESS_NOT_CONFIGURED") state.accessConfigured = false;
    showAccessGate(error.message || "访问密钥验证失败", {
      disabled: error.code === "ACCESS_NOT_CONFIGURED"
    });
  } finally {
    button.disabled = state.accessConfigured === false;
  }
}

function adminToken() {
  return sessionStorage.getItem(ADMIN_TOKEN_KEY) || "";
}

function adminConfigured() {
  return Boolean(state.bootstrap?.config?.adminProtected);
}

function adminUnlocked() {
  return adminConfigured() && state.adminVerified;
}

function renderAdminLockNotice(title) {
  const configured = adminConfigured();
  const message = configured
    ? "请先在系统页输入并验证管理密码。"
    : "服务端尚未配置管理密码，请在 tracker/.env 设置 ADMIN_TOKEN 并重启服务。";
  return `<div class="admin-lock-notice"><div><strong>${escapeHtml(title)}已锁定</strong><span>${escapeHtml(message)}</span></div>${configured ? `<button type="button" class="secondary-button" data-view="system">前往验证</button>` : ""}</div>`;
}

async function verifyStoredAdminToken() {
  state.adminVerified = false;
  if (!adminConfigured() || !adminToken()) return false;
  try {
    await api("/api/admin/verify", { method: "POST", body: "{}" });
    state.adminVerified = true;
    return true;
  } catch {
    return false;
  }
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const viewToken = accessToken();
  if (viewToken) headers.set("X-Access-Token", viewToken);
  const token = adminToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(path, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = accessRequestError(response, body);
    if (error.isAccessError) {
      sessionStorage.removeItem(ACCESS_TOKEN_KEY);
      sessionStorage.removeItem(ADMIN_TOKEN_KEY);
      state.accessConfigured = error.code !== "ACCESS_NOT_CONFIGURED";
      showAccessGate(error.message, { disabled: !state.accessConfigured });
    }
    throw error;
  }
  return body;
}

function showToast(message, isError = false) {
  const region = $("#toast-region");
  const toast = document.createElement("div");
  toast.className = `toast${isError ? " is-error" : ""}`;
  toast.textContent = message;
  region.append(toast);
  setTimeout(() => toast.remove(), 3400);
}

async function loadBootstrap({ quiet = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  if (!quiet) $("#refresh-button").disabled = true;
  try {
    const query = state.seasonId ? `?season=${encodeURIComponent(state.seasonId)}` : "";
    const data = await api(`/api/bootstrap${query}`);
    state.bootstrap = data;
    state.seasonId = data.activeSeasonId || data.seasons?.[0]?.id || null;
    await verifyStoredAdminToken();
    if (!state.hallWindow) state.hallWindow = data.config.hallSeasonWindow;
    if (!data.arenas[state.arenaKey]) state.arenaKey = data.config.arenas[0]?.key || "classic";
    ensureBackfillEditor();
    renderAll();
  } catch (error) {
    if (!error.isAccessError) {
      if (!quiet) showToast(error.message, true);
      $("#overview-content").innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    }
  } finally {
    state.loading = false;
    if (!quiet) $("#refresh-button").disabled = false;
  }
}

function setView(view) {
  state.view = view;
  $$(".nav-tab").forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
  $$("[data-view-panel]").forEach((panel) => panel.classList.toggle("is-active", panel.dataset.viewPanel === view));
  const [eyebrow, title] = viewTitles[view] || viewTitles.overview;
  $("#page-eyebrow").textContent = eyebrow;
  $("#page-title").textContent = title;
  renderView();
}

function renderTopbar() {
  const seasons = state.bootstrap?.seasons || [];
  $("#season-select").innerHTML = seasons.map((season) =>
    `<option value="${escapeHtml(season.id)}" ${season.id === state.seasonId ? "selected" : ""}>${escapeHtml(season.label)}${season.active ? " · 当前届次" : ""}</option>`
  ).join("");
  $("#arena-switch").innerHTML = (state.bootstrap?.config?.arenas || []).map((arena) =>
    `<button type="button" class="segment-button${arena.key === state.arenaKey ? " is-active" : ""}" data-arena="${escapeHtml(arena.key)}">${escapeHtml(arena.name)}</button>`
  ).join("");
}

function renderStatus() {
  const scheduler = state.bootstrap?.scheduler;
  const collector = scheduler?.collector;
  const dot = $("#sidebar-status-dot");
  dot.className = "status-dot";
  let label = "未连接";
  if (!scheduler?.credentialsConfigured) label = "未配置账号";
  else if (collector?.phase === "collecting") {
    label = "采集中";
    dot.classList.add("is-running");
  } else if (collector?.phase === "partial") {
    label = "部分成功";
    dot.classList.add("is-partial");
  } else if (collector?.phase === "error") {
    label = "采集异常";
    dot.classList.add("is-error");
  } else if (collector?.lastSuccessAt) {
    label = "运行正常";
    dot.classList.add("is-ready");
  }
  $("#sidebar-status-text").textContent = label;
  $("#sidebar-status-time").textContent = collector?.lastSuccessAt ? `更新 ${dateTime(collector.lastSuccessAt)}` : "等待首轮采集";
}

function renderAll() {
  renderTopbar();
  renderStatus();
  renderView();
}

function renderView() {
  if (!state.bootstrap) return;
  if (state.view === "overview") renderOverview();
  if (state.view === "weeks") renderWeeks();
  if (state.view === "players") renderPlayers();
  if (state.view === "hall") renderHall();
  if (state.view === "backfill") renderBackfill();
  if (state.view === "system") renderSystem();
}

function renderMetrics(stats, latest) {
  return `<div class="metric-strip">
    <div class="metric"><span>已结算周</span><strong>${number(stats?.finalizedWeekCount)}</strong><small>${stats?.elapsedWeekCount ? `${number(stats.finalizedWeekCount)}/${number(stats.elapsedWeekCount)} 个已到期周` : stats?.weeks?.at(-1) ? `最近 ${escapeHtml(shortDate(stats.weeks.at(-1).cutoffAt))}` : "尚无截止"}</small></div>
    <div class="metric"><span>战皇席位</span><strong>${number(stats?.seatCount)}</strong><small>每周前五席位</small></div>
    <div class="metric"><span>参榜玩家</span><strong>${number(stats?.uniquePlayerCount)}</strong><small>按玩家 ID 去重</small></div>
    <div class="metric"><span>最新采集</span><strong>${latest ? escapeHtml(shortDate(latest.capturedAt)) : "--"}</strong><small>${latest ? escapeHtml(dateTime(latest.capturedAt).split(" ").at(-1) || "") : "等待数据"}</small></div>
  </div>`;
}

function renderCandidate(stats) {
  const candidates = stats?.candidates || [];
  if (!candidates.length) return `<div class="candidate-band is-empty"><div><div class="candidate-label">名人堂候选</div><p class="candidate-names">暂无完成周结算</p></div></div>`;
  const names = candidates.map((player) => escapeHtml(player.playerLabel || player.nickname || player.playerId)).join("、");
  const first = candidates[0];
  return `<div class="candidate-band">
    <div><div class="candidate-label">${candidates.length > 1 ? "并列名人堂候选" : "当前名人堂候选"}</div><p class="candidate-names">${names}</p></div>
    <div class="candidate-stats">
      <div class="candidate-stat"><strong>${number(first.emperorCount)}</strong><span>战皇数</span></div>
      <div class="candidate-stat"><strong>${number(first.longestStreak)}</strong><span>最长连皇</span></div>
    </div>
  </div>`;
}

function playerButton(player) {
  const label = player.playerLabel || player.nickname || player.playerId;
  const currentName = player.nickname && player.nickname !== label ? `${player.nickname} · ${player.playerId}` : player.playerId;
  return `<button type="button" class="player-button" data-player-id="${escapeHtml(player.playerId)}">${escapeHtml(label)}</button><span class="player-id">${escapeHtml(currentName)}</span>`;
}

function renderUnion(player, { compact = false } = {}) {
  if (!Number(player.unionId)) return "未加入联盟";
  const label = player.unionLabel || player.unionName || String(player.unionId);
  if (compact || !player.unionName || player.unionName === label) return escapeHtml(label);
  return `${escapeHtml(label)}<span class="player-id">现名 ${escapeHtml(player.unionName)}</span>`;
}

function renderStandingsTable(stats, { limit = 10, hall = false } = {}) {
  const rows = (stats?.standings || []).slice(0, limit);
  if (!rows.length) return `<div class="empty-state">暂无结算数据</div>`;
  const maxCount = Math.max(1, ...rows.map((row) => row.emperorCount));
  return `<div class="data-table-wrap"><table class="data-table"><thead><tr>
    <th>#</th><th>玩家</th><th>战皇数</th><th>最长连皇</th><th>当前连皇</th><th>联盟</th>
  </tr></thead><tbody>${rows.map((row, index) => `<tr>
    <td><span class="rank-number${index < 3 ? " is-top" : ""}">${index + 1}</span></td>
    <td>${playerButton(row)}</td>
    <td><div class="count-bar"><strong>${number(row.emperorCount)}</strong><span class="count-track"><i class="count-fill" style="width:${Math.round(row.emperorCount / maxCount * 100)}%"></i></span></div></td>
    <td>${number(row.longestStreak)} 周</td><td>${number(row.currentStreak)} 周</td><td>${renderUnion(row)}</td>
  </tr>`).join("")}</tbody></table></div>`;
}

function renderZoneGrid(snapshot) {
  if (!snapshot?.zones?.length) return `<div class="empty-state">暂无最新榜单</div>`;
  return `<div class="zone-grid-wrap"><div class="zone-grid" style="--zone-count:${snapshot.zones.length}">${snapshot.zones.map((zone) => `<article class="zone-column">
    <div class="zone-title"><strong>${escapeHtml(zone.name)}</strong><span>前五 · ${escapeHtml(zone.serverZoneId)}</span></div>
    ${[1, 2, 3, 4, 5].map((rank) => {
      const player = zone.players.find((item) => item.rank === rank);
      return player ? `<div class="zone-player"><span class="rank-number${rank <= 3 ? " is-top" : ""}">${rank}</span><div>${playerButton(player)}<span>${renderUnion(player, { compact: true })}</span></div></div>` : `<div class="zone-player"><span class="rank-number">${rank}</span><div><strong>空缺</strong><span>未返回玩家</span></div></div>`;
    }).join("")}
  </article>`).join("")}</div></div>`;
}

function renderOverview() {
  const data = arenaData();
  const stats = data.stats;
  $("#overview-content").innerHTML = `<div class="section-header"><div><h2>${escapeHtml(currentArena().name)} · 当前届次</h2><p>${escapeHtml(state.bootstrap.seasons.find((season) => season.id === state.seasonId)?.label || "")}</p></div><span class="status-badge ${data.latest ? "is-final" : ""}">${data.latest ? `采集于 ${escapeHtml(dateTime(data.latest.capturedAt))}` : "暂无采集"}</span></div>
    ${renderMetrics(stats, data.latest)}
    ${renderCandidate(stats)}
    <div class="content-grid"><section class="section-block"><div class="section-header"><h2>战皇统计</h2><p>按战皇数排序</p></div>${renderStandingsTable(stats)}</section><section class="section-block"><div class="section-header"><h2>最近榜单</h2><p>每个战区前五</p></div>${renderZoneGrid(data.latest)}</section></div>`;
}

function renderWeekDetail(detail) {
  if (!detail) return `<div class="empty-state">选择一周查看榜单</div>`;
  return `<div class="section-header"><div><h2>${escapeHtml(detail.weekKey)} · ${escapeHtml(currentArena().name)}</h2><p>截止 ${escapeHtml(dateTime(detail.cutoffAt))} · 采集 ${escapeHtml(dateTime(detail.capturedAt))}</p></div><span class="status-badge ${detail.status === "final" ? "is-final" : detail.status === "partial" ? "is-partial" : "is-missing"}">${escapeHtml(detail.status)}</span></div>${renderZoneGrid(detail.snapshot)}`;
}

function renderWeeks() {
  const settlements = arenaData().settlements || [];
  if (!state.weekKey && settlements[0]) state.weekKey = settlements[0].weekKey;
  const list = settlements.length ? `<div class="week-list">${settlements.map((item) => `<button type="button" class="week-item${item.weekKey === state.weekKey ? " is-active" : ""}" data-week-key="${item.weekKey}"><span><strong>${escapeHtml(item.weekKey)}</strong><span>${escapeHtml(item.seasonLabel || "")}</span></span><span class="status-badge ${item.status === "final" ? "is-final" : item.status === "partial" ? "is-partial" : "is-missing"}">${escapeHtml(item.status)}</span></button>`).join("")}</div>` : `<div class="empty-state">暂无周结算</div>`;
  $("#weeks-content").innerHTML = `<div class="weeks-layout"><section>${list}</section><section class="section-block" id="week-detail">${renderWeekDetail(state.weekDetail)}</section></div>`;
  if (state.weekKey && (!state.weekDetail || state.weekDetail.weekKey !== state.weekKey)) loadWeekDetail(state.weekKey);
}

async function loadWeekDetail(weekKey) {
  try {
    state.weekDetail = await api(`/api/settlements/${encodeURIComponent(state.arenaKey)}/${weekKey}`);
    renderWeeks();
  } catch (error) {
    showToast(error.message, true);
  }
}

function archiveUnionRows(rows, sourceRows = rows) {
  const visibleUnionIds = new Set(rows.map((player) => Number(player.unionId) || 0).filter((unionId) => unionId > 0));
  const unions = new Map();
  for (const player of sourceRows) {
    const unionId = Number(player.unionId) || 0;
    if (unionId <= 0 || !visibleUnionIds.has(unionId)) continue;
    const profile = findUnionProfile(unionId);
    const existing = unions.get(unionId);
    if (existing) {
      existing.memberCount += 1;
      continue;
    }
    const unionName = profile?.latestName || player.unionName || String(unionId);
    unions.set(unionId, {
      unionId,
      unionLabel: profile?.unionLabel || player.unionLabel || unionName || String(unionId),
      unionName,
      memberCount: 1
    });
  }
  return [...unions.values()].sort((a, b) =>
    a.unionLabel.localeCompare(b.unionLabel, "zh-CN") || a.unionId - b.unionId
  );
}

function renderUnionArchiveLabels(rows, sourceRows = rows) {
  const unions = archiveUnionRows(rows, sourceRows);
  if (!unions.length) return "";
  const editable = adminUnlocked();
  const body = unions.map((union) => `<tr>
    <td class="union-label-edit-cell">${editable ? `<input class="inline-label-input union-label-input" data-inline-union-label value="${escapeHtml(union.unionLabel)}" maxlength="80" aria-label="联盟 ${escapeHtml(union.unionId)} 备注">` : `<strong class="archive-union-label">${escapeHtml(union.unionLabel)}</strong>`}</td>
    <td class="archive-union-name-cell"><strong>${escapeHtml(union.unionName)}</strong><span class="player-id">ID ${escapeHtml(union.unionId)}</span></td>
    <td>${number(union.memberCount)} 名玩家</td>
    <td>${editable ? `<button type="button" class="icon-button" data-action="save-inline-union-label" data-inline-union-id="${escapeHtml(union.unionId)}" title="保存联盟备注" aria-label="保存联盟 ${escapeHtml(union.unionId)} 备注">✓</button>` : ""}</td>
  </tr>`).join("");
  return `<section class="section-block union-label-directory"><div class="section-header"><div><h2>联盟备注</h2><p>按联盟 ID 统一管理</p></div><span class="status-badge">${number(unions.length)} 个联盟</span></div><div class="data-table-wrap"><table class="data-table union-label-table"><colgroup><col class="union-label-col-edit"><col class="union-label-col-name"><col class="union-label-col-members"><col class="union-label-col-action"></colgroup><thead><tr><th>联盟备注</th><th>游戏联盟名 / ID</th><th>玩家数</th><th></th></tr></thead><tbody>${body}</tbody></table></div></section>`;
}

function playerArchiveRows(stats) {
  const rows = new Map((stats?.standings || []).map((player) => [player.playerId, player]));
  for (const profile of playerDirectory()) {
    if (rows.has(profile.playerId)) continue;
    const unionId = Number(profile.latestUnionId) || 0;
    rows.set(profile.playerId, {
      playerId: profile.playerId,
      nickname: profile.latestNickname || profile.playerLabel || profile.playerId,
      playerLabel: profile.playerLabel || profile.latestNickname || profile.playerId,
      unionId,
      unionName: unionId > 0 ? profile.latestUnionName || String(unionId) : "未加入联盟",
      unionLabel: unionId > 0 ? profile.unionLabel || profile.latestUnionName || String(unionId) : "未加入联盟",
      emperorCount: 0,
      rankOneCount: 0,
      currentStreak: 0,
      longestStreak: 0,
      weeks: [],
      arenas: [],
      zones: []
    });
  }
  return [...rows.values()].sort((a, b) =>
    (b.emperorCount || 0) - (a.emperorCount || 0)
    || String(a.playerLabel || a.nickname || a.playerId).localeCompare(String(b.playerLabel || b.nickname || b.playerId), "zh-CN")
  );
}

function renderNewPlayerForm() {
  const unionOptions = unionDirectory().map((union) => `<option value="${escapeHtml(union.unionId)}" label="${escapeHtml(`${union.unionLabel}${union.latestName && union.latestName !== union.unionLabel ? ` · ${union.latestName}` : ""}`)}"></option>`).join("");
  return `<section class="section-block new-player-block"><div class="section-header"><div><h2>添加玩家档案</h2><p>先建立身份档案，再到历史补录中勾选该玩家</p></div></div><form class="new-player-form" id="new-player-form"><label class="form-field"><span>玩家 ID</span><input class="text-input" name="playerId" required maxlength="64" placeholder="必填"></label><label class="form-field"><span>游戏昵称</span><input class="text-input" name="nickname" maxlength="80" placeholder="可选"></label><label class="form-field"><span>玩家标注</span><input class="text-input" name="playerLabel" maxlength="80" placeholder="默认使用游戏昵称或 ID"></label><label class="form-field"><span>联盟 ID</span><input class="text-input" name="unionId" list="new-player-union-options" inputmode="numeric" placeholder="可选"><datalist id="new-player-union-options">${unionOptions}</datalist></label><button class="command-button" type="submit">添加到档案</button></form></section>`;
}

function renderPlayerArchiveMatrix(stats, rows) {
  const weekKeys = settlementWeekKeys();
  const editable = adminUnlocked();
  const body = rows.length
    ? rows.map((player, index) => {
      const label = player.playerLabel || player.nickname || player.playerId;
      const unionId = Number(player.unionId) || 0;
      const unionLabel = player.unionLabel || player.unionName || (unionId ? String(unionId) : "");
      return `<tr>
        <td><span class="rank-number${index < 3 ? " is-top" : ""}">${index + 1}</span></td>
        <td class="archive-label-cell">${editable ? `<input class="inline-label-input" data-inline-player-label value="${escapeHtml(label)}" maxlength="80" aria-label="${escapeHtml(label)}玩家标注">` : `<strong class="archive-player-label">${escapeHtml(label)}</strong>`}</td>
        <td><div>${playerButton({ ...player, playerLabel: player.nickname || player.playerId })}</div></td>
        <td class="archive-union-cell">${unionId ? `<strong class="archive-union-label">${escapeHtml(unionLabel)}</strong><span class="player-id">${escapeHtml(player.unionName || "")} · ${escapeHtml(unionId)}</span>` : "未加入联盟"}</td>
        ${weekKeys.map((weekKey) => `<td class="archive-mark-cell"><span class="matrix-mark${(player.weeks || []).includes(weekKey) ? " is-active" : ""}" title="${escapeHtml(weekKey)}">${(player.weeks || []).includes(weekKey) ? "✓" : "·"}</span></td>`).join("")}
        <td>${number(player.emperorCount)}</td><td>${number(player.longestStreak)} 周</td><td>${editable ? `<button type="button" class="icon-button" data-action="save-inline-labels" data-inline-player-id="${escapeHtml(player.playerId)}" title="保存玩家备注" aria-label="保存 ${escapeHtml(label)} 的玩家备注">✓</button>` : ""}</td>
      </tr>`;
    }).join("")
    : `<tr><td class="matrix-empty" colspan="${weekKeys.length + 8}">暂无匹配玩家</td></tr>`;
  const weekHeaders = weekKeys.map((weekKey) => `<th class="archive-week-head" title="结算周 ${escapeHtml(weekKey)}">${escapeHtml(weekKey.slice(5).replace("-", "/"))}</th>`).join("");
  return `<div class="data-table-wrap archive-matrix-wrap"><table class="data-table archive-matrix"><colgroup><col class="archive-col-rank"><col class="archive-col-label"><col class="archive-col-current"><col class="archive-col-union">${weekKeys.map(() => "<col class=\"archive-col-week\">").join("")}<col class="archive-col-count"><col class="archive-col-streak"><col class="archive-col-action"></colgroup><thead><tr><th>#</th><th>玩家标注</th><th>游戏昵称 / ID</th><th>联盟备注 / 现名</th>${weekHeaders}<th>战皇数</th><th>最长连皇</th><th></th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderPlayers() {
  const stats = arenaData().stats;
  const archiveRows = playerArchiveRows(stats);
  const filtered = filterPlayerArchiveRows(archiveRows);
  const maintenance = adminUnlocked() ? renderNewPlayerForm() : renderAdminLockNotice("档案维护");
  $("#players-content").innerHTML = `<div class="section-header"><div><h2>${escapeHtml(currentArena().name)} · 玩家档案</h2><p id="player-search-summary">${playerSearchSummary(filtered.length)}</p></div></div>${maintenance}<div class="search-row"><input class="text-input" id="player-search" type="search" value="${escapeHtml(state.playerQuery)}" placeholder="搜索标注、游戏昵称或玩家 ID" aria-label="搜索玩家"><span class="status-badge">${number(archiveRows.length)} 位档案</span></div><div id="player-search-results">${renderPlayerSearchResults(stats, archiveRows, filtered)}</div>`;
}

function filterPlayerArchiveRows(archiveRows) {
  const query = state.playerQuery.trim().toLowerCase();
  const contains = (value) => String(value ?? "").toLowerCase().includes(query);
  return archiveRows.filter((player) => !query
    || contains(player.nickname)
    || contains(player.playerLabel)
    || contains(player.playerId)
    || contains(player.unionName)
    || contains(player.unionLabel));
}

function playerSearchSummary(filteredCount) {
  return `共 ${number(filteredCount)} 位匹配玩家 · 勾选列显示每周战皇记录`;
}

function renderPlayerSearchResults(stats, archiveRows, filtered) {
  const visibleRows = filtered.slice(0, 500);
  return `${renderUnionArchiveLabels(filtered, archiveRows)}${renderPlayerArchiveMatrix(stats, visibleRows)}<div id="player-detail-slot" class="player-detail">${state.playerDetail ? renderPlayerDetail(state.playerDetail) : ""}</div>`;
}

function updatePlayerSearch(input) {
  state.playerQuery = input.value;
  const stats = arenaData().stats;
  const archiveRows = playerArchiveRows(stats);
  const filtered = filterPlayerArchiveRows(archiveRows);
  const summary = $("#player-search-summary");
  const results = $("#player-search-results");
  if (summary) summary.textContent = playerSearchSummary(filtered.length);
  if (results) results.innerHTML = renderPlayerSearchResults(stats, archiveRows, filtered);
}

function renderPlayerDetail(detail) {
  const player = detail.player;
  const label = player.playerLabel || player.nickname || player.playerId;
  const unionId = Number(player.unionId) || 0;
  const history = detail.history?.length
    ? `<div class="data-table-wrap"><table class="data-table"><thead><tr><th>周次</th><th>竞技场</th><th>战区</th><th>游戏昵称</th><th>联盟名</th><th>排名</th></tr></thead><tbody>${detail.history.map((row) => `<tr><td>${escapeHtml(row.weekKey)}</td><td>${escapeHtml(row.arenaKey)}</td><td>${escapeHtml(row.zoneName)}</td><td>${escapeHtml(row.nickname)}</td><td>${escapeHtml(row.unionName || "未加入联盟")}</td><td><span class="rank-number is-top">${row.rank}</span></td></tr>`).join("")}</tbody></table></div>`
    : `<div class="empty-state player-history-empty">暂无战皇记录，可在历史补录中添加</div>`;
  const identityForm = adminUnlocked()
    ? `<form class="identity-form" id="identity-label-form" data-player-id="${escapeHtml(player.playerId)}"><label class="form-field"><span>玩家标注</span><input class="text-input" name="playerLabel" maxlength="80" required value="${escapeHtml(label)}"></label><button class="secondary-button" type="submit">保存玩家标注</button></form>`
    : "";
  return `<div class="player-profile"><div class="profile-summary"><h3>${escapeHtml(label)}</h3><p>游戏昵称 ${escapeHtml(player.nickname || "--")} · ID ${escapeHtml(player.playerId)}</p><p>${unionId ? `联盟 ${renderUnion(player)} · ID ${unionId}` : "未加入联盟"}</p><div class="profile-numbers"><div class="profile-number"><strong>${number(player.emperorCount)}</strong><span>战皇数</span></div><div class="profile-number"><strong>${number(player.longestStreak)}</strong><span>最长连皇</span></div><div class="profile-number"><strong>${number(player.currentStreak)}</strong><span>当前连皇</span></div></div>${identityForm}</div>${history}</div>`;
}

function hallModeTabs() {
  return `<div class="segmented hall-mode-switch" role="tablist" aria-label="名人堂显示模式"><button type="button" class="segment-button${state.hallMode === "matrix" ? " is-active" : ""}" data-hall-mode="matrix" role="tab" aria-selected="${state.hallMode === "matrix"}">时间矩阵</button><button type="button" class="segment-button${state.hallMode === "table" ? " is-active" : ""}" data-hall-mode="table" role="tab" aria-selected="${state.hallMode === "table"}">候选排行</button></div>`;
}

function hallMatrixWeekKeys(stats) {
  return [...new Set((stats?.timelineWeeks || stats?.weeks || [])
    .map((week) => String(week.weekKey ?? "").trim())
    .filter(Boolean))].sort();
}

function renderHallMatrix(stats) {
  const weekKeys = hallMatrixWeekKeys(stats);
  const candidateIds = new Set((stats?.candidates || []).map((player) => player.playerId));
  const rows = (stats?.standings || []).filter((player, index) => index < 25 || candidateIds.has(player.playerId));
  if (!rows.length || !weekKeys.length) return `<div class="empty-state">暂无可展示的名人堂周榜</div>`;
  const weekHeaders = weekKeys.map((weekKey) => `<th class="hall-matrix-week-head" title="结算周 ${escapeHtml(weekKey)}"><span>${escapeHtml(weekKey.slice(5).replace("-", "/"))}</span></th>`).join("");
  const body = rows.map((player, index) => {
    const activeWeeks = new Set(player.weeks || []);
    return `<tr${candidateIds.has(player.playerId) ? " class=\"is-candidate\" title=\"当前名人堂候选\"" : ""}>
      <td class="hall-matrix-rank"><span class="rank-number${index < 3 ? " is-top" : ""}">${index + 1}</span></td>
      <td class="hall-matrix-player"><div class="hall-matrix-player-name">${playerButton(player)}</div></td>
      <td class="hall-matrix-union">${renderUnion(player)}</td>
      ${weekKeys.map((weekKey) => {
        const active = activeWeeks.has(weekKey);
        return `<td class="hall-matrix-mark-cell"><span class="matrix-mark${active ? " is-active" : ""}" title="${escapeHtml(weekKey)}">${active ? "✓" : "·"}</span></td>`;
      }).join("")}
      <td class="hall-matrix-number">${number(player.emperorCount)}</td>
      <td class="hall-matrix-number">${number(player.longestStreak)} 周</td>
      <td class="hall-matrix-number">${number(player.currentStreak)} 周</td>
    </tr>`;
  }).join("");
  return `<div class="section-block hall-matrix-block"><div class="section-header"><div><h2>战皇时间矩阵</h2><p>显示前 25 名及所有并列候选，按结算周对比战皇记录</p></div><span class="status-badge">${number(rows.length)} 位玩家 · ${number(weekKeys.length)} 个结算周</span></div><div class="data-table-wrap hall-matrix-wrap"><table class="data-table hall-matrix"><colgroup><col class="hall-matrix-col-rank"><col class="hall-matrix-col-player"><col class="hall-matrix-col-union">${weekKeys.map(() => "<col class=\"hall-matrix-col-week\">").join("")}<col class="hall-matrix-col-count"><col class="hall-matrix-col-streak"><col class="hall-matrix-col-current"></colgroup><thead><tr><th class="hall-matrix-rank">#</th><th class="hall-matrix-player">玩家标注 / 游戏昵称</th><th class="hall-matrix-union">联盟标注 / 现名</th>${weekHeaders}<th>战皇数</th><th>最长连皇</th><th>当前连皇</th></tr></thead><tbody>${body}</tbody></table></div></div>`;
}

function renderHall() {
  const data = arenaData();
  const hall = state.hallWindow === state.bootstrap.config.hallSeasonWindow ? data.hall : state._hallData;
  const seasons = hall?.seasons || [];
  const windowTabs = `<div class="segmented hall-window-switch"><button type="button" class="segment-button${state.hallWindow === 1 ? " is-active" : ""}" data-hall-window="1">本届</button><button type="button" class="segment-button${state.hallWindow === 3 ? " is-active" : ""}" data-hall-window="3">三届周期</button></div>`;
  const content = state.hallMode === "matrix"
    ? renderHallMatrix(hall)
    : `<div class="section-block hall-table-block"><div class="section-header"><h2>候选排序</h2><p>战皇数 · 最长连皇</p></div>${renderStandingsTable(hall, { limit: 25, hall: true })}</div>`;
  $("#hall-content").innerHTML = `<div class="section-header hall-page-header"><div><h2>${escapeHtml(currentArena().name)} · 名人堂候选</h2><p>${seasons.length ? `${escapeHtml(seasons[0].label)} 至 ${escapeHtml(seasons.at(-1).label)}` : ""}</p></div><div class="hall-controls">${windowTabs}${hallModeTabs()}</div></div>${renderCandidate(hall)}${content}`;
  if (state.hallWindow !== state.bootstrap.config.hallSeasonWindow && !state._hallDataLoading) loadHall();
}

async function loadHall() {
  state._hallDataLoading = true;
  try {
    state._hallData = await api(`/api/hall?season=${encodeURIComponent(state.seasonId)}&arena=${encodeURIComponent(state.arenaKey)}&window=${state.hallWindow}`);
    renderHall();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    state._hallDataLoading = false;
  }
}

function backfillRowsFromSnapshot(snapshot) {
  const rows = emptyBackfillRows();
  for (const zone of snapshot?.zones || []) {
    for (const player of zone.players || []) {
      const row = rows.find((item) => item.zoneIndex === zone.index && item.rank === player.rank);
      if (!row) continue;
      row.playerId = String(player.playerId ?? "");
      row.nickname = String(player.nickname ?? "");
      row.playerLabel = String(player.playerLabel ?? player.nickname ?? "");
      row.unionId = Number(player.unionId) > 0 ? String(player.unionId) : "";
      row.unionName = String(player.unionName ?? "");
      row.unionLabel = String(player.unionLabel ?? player.unionName ?? "");
      if (!row.unionId) {
        row.unionName = "";
        row.unionLabel = "";
      }
    }
  }
  return rows;
}

function backfillModeTabs() {
  return `<div class="segmented backfill-mode-tabs"><button type="button" class="segment-button${state.backfillMode === "matrix" ? " is-active" : ""}" data-action="backfill-mode" data-mode="matrix">时间矩阵</button><button type="button" class="segment-button${state.backfillMode === "detail" ? " is-active" : ""}" data-action="backfill-mode" data-mode="detail">详细周榜</button></div>`;
}

function matrixPlayerView(playerId, stats) {
  const row = (stats?.standings || []).find((item) => item.playerId === playerId);
  const profile = findPlayerProfile(playerId);
  return {
    playerId,
    playerLabel: profile?.playerLabel || row?.playerLabel || row?.nickname || playerId,
    nickname: profile?.latestNickname || row?.nickname || playerId,
    unionId: Number(profile?.latestUnionId || row?.unionId) || 0,
    unionLabel: profile?.unionLabel || row?.unionLabel || row?.unionName || "未加入联盟",
    unionName: profile?.latestUnionName || row?.unionName || "未加入联盟",
    emperorCount: row?.emperorCount || 0,
    longestStreak: row?.longestStreak || 0,
    currentStreak: row?.currentStreak || 0
  };
}

function renderBackfillMatrix() {
  ensureBackfillMatrix();
  const arena = currentArena();
  const stats = arenaData().stats;
  const weekKeys = state.matrixWeekKeys;
  const maxSeats = arena.zones.length * 5;
  const players = state.matrixPlayerIds.map((playerId) => matrixPlayerView(playerId, stats));
  const profileOptions = playerDirectory().map((profile) => {
    const current = profile.latestNickname && profile.latestNickname !== profile.playerLabel
      ? ` · 现名 ${profile.latestNickname}`
      : "";
    return `<option value="${escapeHtml(profile.playerId)}" label="${escapeHtml(`${profile.playerLabel}${current}`)}"></option>`;
  }).join("");
  const weekHeaders = weekKeys.map((weekKey) => {
    const count = state.matrixSelections[weekKey]?.size || 0;
    return `<th class="matrix-week-head" title="结算周 ${escapeHtml(weekKey)}"><span>${escapeHtml(weekKey.slice(5).replace("-", "/"))}</span><small data-matrix-count="${escapeHtml(weekKey)}">${count}/${maxSeats}</small></th>`;
  }).join("");
  const body = players.length
    ? players.map((player) => `<tr>
      <td class="matrix-player-cell"><div class="matrix-player-name"><strong>${escapeHtml(player.playerLabel)}</strong><span>${escapeHtml(player.nickname)} · ${escapeHtml(player.playerId)}</span></div><button type="button" class="icon-button matrix-remove" data-action="remove-matrix-player" data-matrix-player="${escapeHtml(player.playerId)}" title="移除此行" aria-label="移除 ${escapeHtml(player.playerLabel)}">×</button></td>
      <td class="matrix-union-cell"><strong>${escapeHtml(player.unionLabel)}</strong><span>${escapeHtml(player.unionName)}${player.unionId ? ` · ${escapeHtml(player.unionId)}` : ""}</span></td>
      ${weekKeys.map((weekKey) => `<td class="matrix-check-cell"><input type="checkbox" class="matrix-check" data-matrix-toggle data-matrix-week="${escapeHtml(weekKey)}" data-matrix-player="${escapeHtml(player.playerId)}" aria-label="${escapeHtml(player.playerLabel)} ${escapeHtml(weekKey)} 是否战皇"${state.matrixSelections[weekKey]?.has(player.playerId) ? " checked" : ""}></td>`).join("")}
    </tr>`).join("")
    : `<tr><td class="matrix-empty" colspan="${weekKeys.length + 2}">暂无玩家行，请从已有玩家档案添加</td></tr>`;
  const status = state.matrixDirty ? "有未保存修改" : `${players.length} 位玩家 · ${weekKeys.length} 个结算周`;
  const statusClass = state.matrixDirty ? "is-partial" : "";
  $("#backfill-content").innerHTML = `<div class="section-header"><div><h2>${escapeHtml(arena.name)} · 战皇时间矩阵</h2><p>勾选表示该玩家在该结算周进入前五席位</p></div>${backfillModeTabs()}<span class="status-badge ${statusClass}" id="matrix-status">${escapeHtml(status)}</span></div>
    <div class="matrix-toolbar"><label class="form-field matrix-player-picker"><span>添加已有玩家</span><input class="text-input" id="matrix-player-input" list="matrix-player-options" placeholder="输入玩家 ID 或标注" autocomplete="off"><datalist id="matrix-player-options">${profileOptions}</datalist></label><button type="button" class="secondary-button" data-action="add-matrix-player">添加玩家</button><button type="button" class="command-button" data-action="save-matrix"${state.matrixDirty ? "" : " disabled"}>保存矩阵</button></div>
    <div class="data-table-wrap matrix-wrap"><table class="data-table matrix-table"><colgroup><col class="matrix-col-player"><col class="matrix-col-union">${weekKeys.map(() => "<col class=\"matrix-col-week\">").join("")}</colgroup><thead><tr><th class="matrix-sticky-player">玩家标注 / 游戏昵称</th><th class="matrix-sticky-union">联盟标注 / 现名</th>${weekHeaders}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderBackfill() {
  if (!adminUnlocked()) {
    $("#backfill-content").innerHTML = `<div class="section-header"><div><h2>历史周榜补录</h2><p>手动补录需要管理密码</p></div></div>${renderAdminLockNotice("历史补录")}`;
    return;
  }
  if (state.backfillMode === "matrix") {
    renderBackfillMatrix();
    return;
  }
  renderDetailedBackfill();
}

function renderDetailedBackfill() {
  ensureBackfillEditor();
  const arena = currentArena();
  const rows = state.backfillRows;
  const existing = (arenaData().settlements || []).find((item) => item.weekKey === state.backfillWeekKey);
  const season = state.bootstrap.seasons.find((item) => item.id === state.seasonId);
  const count = filledBackfillCount();
  const statusText = state.backfillDirty
    ? "有未保存修改"
    : state.backfillLoadedKey === state.backfillWeekKey
      ? `已载入 ${existing?.status || "周榜"}`
      : existing
        ? `已有 ${existing.status}`
        : "尚未补录";
  const statusClass = state.backfillDirty
    ? "is-partial"
    : existing?.status === "final"
      ? "is-final"
      : existing?.status === "partial"
        ? "is-partial"
        : "";

  const playerOptions = playerDirectory().map((profile) => {
    const current = profile.latestNickname && profile.latestNickname !== profile.playerLabel
      ? ` · 现名 ${profile.latestNickname}`
      : "";
    return `<option value="${escapeHtml(profile.playerId)}" label="${escapeHtml(`${profile.playerLabel}${current}`)}"></option>`;
  }).join("");
  const unionOptions = unionDirectory().map((profile) => {
    const current = profile.latestName && profile.latestName !== profile.unionLabel
      ? ` · 现名 ${profile.latestName}`
      : "";
    return `<option value="${escapeHtml(profile.unionId)}" label="${escapeHtml(`${profile.unionLabel}${current}`)}"></option>`;
  }).join("");

  const body = rows.map((row, index) => {
    const zone = arena.zones.find((item) => item.index === row.zoneIndex) || arena.zones[0];
    const zoneCell = row.rank === 1
      ? `<td class="backfill-zone-cell" rowspan="5"><strong>${escapeHtml(zone?.name || `战区 ${row.zoneIndex + 1}`)}</strong><span>${escapeHtml(zone?.serverZoneId ?? row.zoneIndex)}</span></td>`
      : "";
    const input = (field, column, { inputmode = "", list = "", className = "" } = {}) => `<input class="backfill-input${className ? ` ${className}` : ""}" ${inputmode ? `inputmode="${inputmode}"` : ""} ${list ? `list="${list}"` : ""} value="${escapeHtml(row[field])}" data-backfill-row="${index}" data-backfill-col="${column}" data-backfill-field="${field}" autocomplete="off" title="可直接粘贴 Excel 单元格" aria-label="${escapeHtml(zone?.name || "战区")}第 ${row.rank} 名${field}">`;
    return `<tr>${zoneCell}<td class="backfill-rank">${row.rank}</td><td>${input("playerId", 0, { inputmode: "numeric", list: "backfill-player-options" })}</td><td>${input("nickname", 1)}</td><td>${input("playerLabel", 2, { className: "is-label" })}</td><td>${input("unionId", 3, { inputmode: "numeric", list: "backfill-union-options" })}</td><td>${input("unionName", 4)}</td><td>${input("unionLabel", 5, { className: "is-label" })}</td></tr>`;
  }).join("");

  $("#backfill-content").innerHTML = `<div class="section-header"><div><h2>${escapeHtml(arena.name)} · 历史周榜</h2><p>${escapeHtml(season?.label || state.seasonId || "")}</p></div>${backfillModeTabs()}<span class="status-badge ${statusClass}" id="backfill-status">${escapeHtml(statusText)}</span></div>
    <div class="backfill-toolbar">
      <label class="form-field"><span>结算周</span><input class="text-input" id="backfill-week" type="date" step="7" value="${escapeHtml(state.backfillWeekKey)}"></label>
      <div class="backfill-actions">
        <button class="secondary-button" type="button" data-action="load-backfill">载入已有</button>
        <button class="secondary-button" type="button" data-action="clear-backfill">清空</button>
        <button class="command-button" type="button" data-action="save-backfill">保存并结算</button>
      </div>
      <span class="backfill-count" id="backfill-count">${count} / ${rows.length}</span>
    </div>
    <div class="data-table-wrap backfill-grid-wrap" title="选中单元格后可粘贴 Excel 多行多列数据">
      <datalist id="backfill-player-options">${playerOptions}</datalist>
      <datalist id="backfill-union-options">${unionOptions}</datalist>
      <table class="data-table backfill-table">
        <colgroup><col class="backfill-col-zone"><col class="backfill-col-rank"><col class="backfill-col-id"><col class="backfill-col-name"><col class="backfill-col-player-label"><col class="backfill-col-union-id"><col class="backfill-col-union"><col class="backfill-col-union-label"></colgroup>
        <thead><tr><th>战区</th><th>名次</th><th>玩家 ID</th><th>游戏昵称</th><th>玩家标注</th><th>联盟 ID</th><th>联盟现名</th><th>联盟标注</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

async function loadBackfill() {
  if (!state.backfillWeekKey || state.backfillLoading) return;
  if (!canDiscardBackfillDraft()) return;
  state.backfillLoading = true;
  try {
    const detail = await api(`/api/settlements/${encodeURIComponent(state.arenaKey)}/${state.backfillWeekKey}`);
    if (!detail.snapshot) throw new Error("该周没有可载入的榜单快照");
    state.backfillRows = backfillRowsFromSnapshot(detail.snapshot);
    state.backfillLoadedKey = state.backfillWeekKey;
    state.backfillDirty = false;
    showToast(`已载入 ${state.backfillWeekKey} 周榜`);
  } catch (error) {
    if (error.message.includes("Settlement not found")) {
      resetBackfillEditor(state.backfillWeekKey);
      showToast("该周还没有已保存榜单");
    } else {
      showToast(error.message, true);
    }
  } finally {
    state.backfillLoading = false;
    renderBackfill();
  }
}

async function saveBackfill(element) {
  const rows = state.backfillRows || [];
  const incompleteIdentity = rows.find((row) =>
    !row.playerId.trim() && [row.nickname, row.playerLabel, row.unionId, row.unionName, row.unionLabel]
      .some((value) => String(value).trim())
  );
  if (incompleteIdentity) {
    showToast("填写玩家或联盟信息时必须同时填写玩家 ID", true);
    return;
  }
  const filled = rows.filter((row) => row.playerId.trim());
  if (!filled.length) {
    showToast("至少填写一名玩家", true);
    return;
  }
  const ids = filled.map((row) => row.playerId.trim());
  if (new Set(ids).size !== ids.length) {
    showToast("同一竞技场周榜中存在重复玩家 ID", true);
    return;
  }
  const invalidUnion = filled.find((row) => {
    const raw = row.unionId.trim();
    return raw && (!/^\d+$/.test(raw) || Number(raw) <= 0);
  });
  if (invalidUnion) {
    showToast("联盟 ID 必须是正整数", true);
    return;
  }
  const missingUnionId = filled.find((row) =>
    !row.unionId.trim() && [row.unionName, row.unionLabel].some((value) => value.trim() && value.trim() !== "未加入联盟")
  );
  if (missingUnionId) {
    showToast("填写联盟现名或联盟标注时必须填写联盟 ID", true);
    return;
  }
  const unionLabels = new Map();
  for (const row of filled) {
    if (!row.unionId.trim() || !row.unionLabel.trim()) continue;
    const previous = unionLabels.get(row.unionId.trim());
    if (previous && previous !== row.unionLabel.trim()) {
      showToast(`联盟 ${row.unionId.trim()} 填写了不同标注`, true);
      return;
    }
    unionLabels.set(row.unionId.trim(), row.unionLabel.trim());
  }
  if (filled.length < rows.length && !window.confirm(`当前仅填写 ${filled.length}/${rows.length} 个席位，仍保存为不完整周榜吗？`)) return;

  const zones = currentArena().zones.map((zone) => ({
    index: zone.index,
    serverZoneId: zone.serverZoneId,
    name: zone.name,
    players: rows
      .filter((row) => row.zoneIndex === zone.index && row.playerId.trim())
      .map((row) => ({
        rank: row.rank,
        playerId: row.playerId.trim(),
        nickname: row.nickname.trim() || row.playerId.trim(),
        playerLabel: row.playerLabel.trim() || row.nickname.trim() || row.playerId.trim(),
        unionId: Number(row.unionId) || 0,
        unionName: Number(row.unionId) > 0 ? row.unionName.trim() || row.unionLabel.trim() || String(row.unionId) : "未加入联盟",
        unionLabel: Number(row.unionId) > 0 ? row.unionLabel.trim() || row.unionName.trim() || String(row.unionId) : ""
      }))
  }));

  element.disabled = true;
  try {
    const result = await api("/api/admin/import", {
      method: "POST",
      body: JSON.stringify({
        arenaKey: state.arenaKey,
        seasonId: state.seasonId,
        weekKey: state.backfillWeekKey,
        source: "manual",
        finalize: true,
        zones
      })
    });
    state.backfillLoadedKey = state.backfillWeekKey;
    state.backfillDirty = false;
    state.weekKey = state.backfillWeekKey;
    state.weekDetail = result.settlement || null;
    const label = result.settlement?.status === "partial" ? "不完整周榜" : "周榜";
    showToast(`${state.backfillWeekKey} ${label}已保存`);
    await loadBootstrap({ quiet: true });
  } catch (error) {
    showToast(error.message, true);
  } finally {
    element.disabled = false;
  }
}

function applyBackfillPaste(target, text) {
  let matrix = text.replaceAll("\r", "").split("\n").map((line) => line.split("\t"));
  while (matrix.length && matrix.at(-1).every((value) => !value.trim())) matrix.pop();
  if (!matrix.length) return;
  const headerMap = new Map([
    ["战区", "zone"], ["名次", "rank"], ["排名", "rank"],
    ["玩家id", "playerId"], ["playerid", "playerId"],
    ["昵称", "nickname"], ["游戏昵称", "nickname"],
    ["玩家标注", "playerLabel"], ["昵称标注", "playerLabel"],
    ["联盟id", "unionId"], ["联盟现名", "unionName"], ["联盟名", "unionName"], ["联盟", "unionName"],
    ["联盟标注", "unionLabel"], ["战力", null]
  ]);
  const headerFields = matrix[0].map((value) => headerMap.get(value.trim().toLowerCase().replaceAll(" ", "")));
  const hasHeader = headerFields.filter((field) => field !== undefined).length >= 2;
  if (hasHeader) matrix.shift();
  if (!matrix.length) return;

  let startRow = Number(target.dataset.backfillRow);
  let startColumn = Number(target.dataset.backfillCol);
  const includesZoneAndRank = !hasHeader && matrix.some((cells) =>
    cells.length >= BACKFILL_FIELDS.length + 2 && /^[1-5]$/.test(cells[1]?.trim())
  );
  const touchedRows = new Set();
  for (let rowOffset = 0; rowOffset < matrix.length; rowOffset += 1) {
    const cells = matrix[rowOffset];
    let rowIndex = startRow + rowOffset;
    if (hasHeader) {
      const zoneColumn = headerFields.indexOf("zone");
      const rankColumn = headerFields.indexOf("rank");
      const rank = rankColumn >= 0 ? Number(cells[rankColumn]) : 0;
      const zoneValue = zoneColumn >= 0 ? cells[zoneColumn]?.trim() : "";
      const zone = currentArena().zones.find((item) =>
        item.name === zoneValue || String(item.serverZoneId) === zoneValue || String(item.index + 1) === zoneValue
      );
      const matched = zone && rank
        ? state.backfillRows.findIndex((row) => row.zoneIndex === zone.index && row.rank === rank)
        : -1;
      if (matched >= 0) rowIndex = matched;
      if (!state.backfillRows[rowIndex]) continue;
      headerFields.forEach((field, index) => {
        if (BACKFILL_FIELDS.includes(field)) {
          state.backfillRows[rowIndex][field] = String(cells[index] ?? "").trim();
        }
      });
    } else {
      let values = cells;
      let column = startColumn;
      if (includesZoneAndRank) {
        const rank = Number(cells[1]);
        const zoneValue = cells[0]?.trim();
        const zone = currentArena().zones.find((item) =>
          item.name === zoneValue || String(item.serverZoneId) === zoneValue || String(item.index + 1) === zoneValue
        );
        const matched = zone && state.backfillRows.findIndex((row) => row.zoneIndex === zone.index && row.rank === rank);
        if (matched >= 0) rowIndex = matched;
        values = cells.slice(2, 2 + BACKFILL_FIELDS.length);
        column = 0;
      }
      if (!state.backfillRows[rowIndex]) continue;
      for (let cellOffset = 0; cellOffset < values.length; cellOffset += 1) {
        const field = BACKFILL_FIELDS[column + cellOffset];
        if (!field) break;
        state.backfillRows[rowIndex][field] = String(values[cellOffset] ?? "").trim();
      }
    }
    touchedRows.add(rowIndex);
  }
  for (const rowIndex of touchedRows) {
    const row = state.backfillRows[rowIndex];
    hydratePlayerRow(row, { onlyEmpty: true });
    if (row.unionId) hydrateUnionRow(row, { onlyEmpty: true });
    if (!row.playerLabel.trim() && row.nickname.trim()) row.playerLabel = row.nickname.trim();
    if (row.unionId && !row.unionLabel.trim() && row.unionName.trim()) row.unionLabel = row.unionName.trim();
  }
  state.backfillDirty = true;
  renderBackfill();
  requestAnimationFrame(() => {
    $(`[data-backfill-row="${startRow}"][data-backfill-col="${startColumn}"]`)?.focus();
  });
}

function updateSeasonEndPreview() {
  const form = $("#season-form");
  if (!form) return;
  const startsAt = form.elements.namedItem("startsAt");
  const weeks = form.elements.namedItem("weeks");
  const endsAt = form.elements.namedItem("endsAt");
  const preview = $("[data-season-end-preview]", form);
  if (!startsAt || !weeks || !endsAt || !preview) return;

  const hasWeeks = String(weeks.value).trim() !== "";
  const calculated = hasWeeks ? plannedEndLocalValue(startsAt.value, weeks.value) : "";
  endsAt.disabled = hasWeeks;
  preview.classList.toggle("is-calculated", Boolean(calculated));
  if (hasWeeks) {
    endsAt.value = calculated;
    preview.textContent = calculated
      ? `计划结束：${calculated.replace("T", " ")}（与开始时间保持同一星期和时刻）`
      : "请先选择开始时间并填写 1–5200 的有效周数。";
    return;
  }
  preview.textContent = endsAt.value
    ? `手动结束：${endsAt.value.replace("T", " ")}`
    : "当前未设结束；可填写计划周数或手动选择结束时间。";
}

function renderSystem() {
  const scheduler = state.bootstrap.scheduler;
  const config = state.bootstrap.config;
  const seasons = state.bootstrap.seasons || [];
  const events = state.bootstrap.events || [];
  const adminStatus = !config.adminProtected ? "服务端未配置，手动写入已锁定" : state.adminVerified ? "管理权限已验证" : "尚未验证管理密码";
  const collectButton = adminUnlocked()
    ? `<button type="button" class="command-button" data-action="collect">立即采集</button>`
    : `<button type="button" class="command-button" title="验证管理密码后可手动采集" disabled>立即采集</button>`;
  const editingSeason = seasons.find((season) => season.id === state.seasonEditingId) || null;
  const seasonEditor = adminUnlocked()
    ? `<form class="inline-form season-editor" id="season-form"><div class="season-editor-heading"><strong>${editingSeason ? `编辑 ${escapeHtml(editingSeason.label)}` : "新增竞技场届次"}</strong><span>${editingSeason ? (editingSeason.endsAt ? "修改届次名称或时间范围" : "该届次当前未设结束，可在这里补充计划周数或结束时间") : "换届后需先建立下一届，再设为当前届次"}</span></div><label class="form-field"><span>届次编号</span><input class="text-input" name="id" required value="${escapeHtml(editingSeason?.id || "")}" ${editingSeason ? "readonly" : ""}></label><label class="form-field"><span>届次名称</span><input class="text-input" name="label" required value="${escapeHtml(editingSeason?.label || "")}"></label><label class="form-field"><span>开始时间</span><input class="text-input" name="startsAt" type="datetime-local" required value="${escapeHtml(dateTimeLocalValue(editingSeason?.startsAt))}"></label><label class="form-field"><span>计划周数（可选）</span><input class="text-input" name="weeks" type="number" min="1" max="5200" placeholder="留空则不自动结束" value="${escapeHtml(editingSeason?.plannedWeeks || "")}"></label><label class="form-field"><span>结束时间（可选）</span><input class="text-input" name="endsAt" type="datetime-local" value="${escapeHtml(dateTimeLocalValue(editingSeason?.endsAt))}"></label><p class="season-end-preview" data-season-end-preview aria-live="polite"></p><button class="command-button" type="submit">${editingSeason ? "保存届次修改" : "新增届次"}</button>${editingSeason ? `<button class="secondary-button" type="button" data-action="cancel-season-edit">取消</button>` : ""}</form><p class="admin-help">计划周数和结束时间二选一；填写计划周数时，结束时间为开始时间经过完整 N 周后的同一星期、同一时刻。</p>`
    : "";
  const seasonRows = seasons.map((season) => `<tr><td><strong>${escapeHtml(season.label)}</strong><span class="player-id">编号 ${escapeHtml(season.id)}</span></td><td>${escapeHtml(dateTime(season.startsAt))}</td><td>${escapeHtml(dateTime(season.endsAt))}${season.plannedWeeks ? ` · ${number(season.plannedWeeks)} 周` : season.endsAt ? "" : " · 未设结束"}</td><td><span class="status-badge${season.active ? " is-final" : ""}">${season.active ? "当前届次" : "历史届次"}</span></td><td>${adminUnlocked() ? `<span class="action-row">${!season.active ? `<button class="secondary-button" type="button" data-activate-season="${escapeHtml(season.id)}">设为当前届次</button>` : ""}<button class="secondary-button" type="button" data-edit-season="${escapeHtml(season.id)}">编辑</button></span>` : ""}</td></tr>`).join("");
  $("#system-content").innerHTML = `<div class="system-grid"><div><section class="system-block"><div class="section-header"><h2>采集状态</h2>${collectButton}</div><dl class="kv-list"><div class="kv-row"><dt>采集器</dt><dd>${escapeHtml(scheduler.credentialsConfigured ? scheduler.collector.phase : "未配置账号")}</dd></div><div class="kv-row"><dt>最近成功</dt><dd>${escapeHtml(dateTime(scheduler.collector.lastSuccessAt))}</dd></div><div class="kv-row"><dt>下次计划</dt><dd>${escapeHtml(dateTime(scheduler.nextPollAt))}</dd></div><div class="kv-row"><dt>最新错误</dt><dd>${escapeHtml(scheduler.collector.lastError || "无")}</dd></div><div class="kv-row"><dt>数据文件</dt><dd>${escapeHtml(state.bootstrap.counts.snapshots)} 份快照 · ${escapeHtml(state.bootstrap.counts.settlements)} 周结算</dd></div></dl></section><section class="system-block"><div class="section-header"><h2>竞技场配置</h2></div><div class="data-table-wrap"><table class="data-table"><thead><tr><th>竞技场</th><th>协议类型</th><th>战区数</th><th>周四截止</th><th>周五更新</th></tr></thead><tbody>${config.arenas.map((arena) => `<tr><td>${escapeHtml(arena.name)}</td><td>${arena.protocolType}</td><td>${arena.zones.length}</td><td>${escapeHtml(arena.settlementTime)}</td><td>${escapeHtml(arena.rankingUpdateTime)}</td></tr>`).join("")}</tbody></table></div></section><section class="system-block"><div class="section-header"><div><h2>竞技场届次管理</h2><p>控制每周榜单归属和连皇重新起算的边界</p></div></div><div class="season-guidance"><span class="season-guidance-mark">届</span><div><strong>经典竞技场与传奇竞技场共用同一届次</strong><span>名人堂没有独立届次，只会汇总这里已经建立的竞技场届次。系统不会自动识别换届。</span></div></div>${seasonEditor}<div class="data-table-wrap season-table-wrap"><table class="data-table season-table"><thead><tr><th>竞技场届次</th><th>开始时间</th><th>结束时间 / 计划</th><th>状态</th><th>操作</th></tr></thead><tbody>${seasonRows}</tbody></table></div></section></div><div><section class="system-block"><div class="section-header"><h2>管理密码</h2><span class="status-badge${state.adminVerified ? " is-final" : config.adminProtected ? " is-partial" : " is-missing"}">${escapeHtml(adminStatus)}</span></div><div class="inline-form"><label class="form-field" style="flex:1"><span>管理密码</span><input class="text-input" id="admin-token" type="password" value="${escapeHtml(adminToken())}" autocomplete="current-password" ${config.adminProtected ? "" : "disabled"}></label><button class="secondary-button" type="button" data-action="save-token"${config.adminProtected ? "" : " disabled"}>验证并解锁</button></div><p class="admin-help">密码只保存在当前浏览器会话；未验证时只能查看数据，不能创建档案、修改备注或补录记录。</p></section><section class="system-block"><div class="section-header"><h2>运行事件</h2></div><div class="event-list">${events.length ? events.map((event) => `<div class="event-row"><span class="event-time">${escapeHtml(dateTime(event.createdAt))}</span><span class="event-scope">${escapeHtml(event.scope)}</span><span class="event-message">${escapeHtml(event.message)}</span></div>`).join("") : `<div class="empty-state">暂无事件</div>`}</div></section></div></div>`;
  updateSeasonEndPreview();
}

async function selectPlayer(playerId) {
  state.selectedPlayerId = playerId;
  try {
    state.playerDetail = await api(`/api/players/${encodeURIComponent(playerId)}?season=${encodeURIComponent(state.seasonId)}&arena=${encodeURIComponent(state.arenaKey)}`);
    setView("players");
    requestAnimationFrame(() => $("#player-detail-slot")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  } catch (error) {
    showToast(error.message, true);
  }
}

function findMatrixPlayer(value) {
  const needle = String(value ?? "").trim().toLowerCase();
  if (!needle) return null;
  return playerDirectory().find((profile) =>
    String(profile.playerId).toLowerCase() === needle
    || String(profile.playerLabel).toLowerCase() === needle
    || String(profile.latestNickname).toLowerCase() === needle
  ) || null;
}

async function saveMatrix(element) {
  ensureBackfillMatrix();
  const changedWeeks = state.matrixWeekKeys.filter((weekKey) =>
    matrixSelectionSignature(state.matrixSelections, [weekKey])
      !== matrixSelectionSignature(state.matrixOriginalSelections, [weekKey])
  );
  if (!changedWeeks.length) {
    showToast("没有需要保存的矩阵修改");
    return;
  }
  const incompleteWeeks = changedWeeks.filter((weekKey) => (state.matrixSelections[weekKey]?.size || 0) < currentArena().zones.length * 5);
  if (incompleteWeeks.length && !window.confirm(`${incompleteWeeks.length} 个结算周未填满全部战皇席位，将保存为不完整周榜，继续吗？`)) return;
  element.disabled = true;
  try {
    const result = await api("/api/admin/matrix", {
      method: "POST",
      body: JSON.stringify({
        arenaKey: state.arenaKey,
        seasonId: state.seasonId,
        weeks: changedWeeks.map((weekKey) => ({ weekKey, playerIds: [...state.matrixSelections[weekKey]] }))
      })
    });
    showToast(`已保存 ${result.results?.length || changedWeeks.length} 个结算周`);
    resetBackfillMatrix();
    await loadBootstrap({ quiet: true });
  } catch (error) {
    showToast(error.message, true);
  } finally {
    element.disabled = false;
  }
}

function addMatrixPlayer() {
  ensureBackfillMatrix();
  const input = $("#matrix-player-input");
  const profile = findMatrixPlayer(input?.value);
  if (!profile) {
    showToast("只能添加数据库中已有的玩家 ID、标注或游戏昵称", true);
    return;
  }
  if (state.matrixPlayerIds.includes(profile.playerId)) {
    showToast("该玩家已经在矩阵中");
    return;
  }
  state.matrixPlayerIds.push(profile.playerId);
  if (input) input.value = "";
  renderBackfillMatrix();
}

function removeMatrixPlayer(playerId) {
  ensureBackfillMatrix();
  const hasSelections = state.matrixWeekKeys.some((weekKey) => state.matrixSelections[weekKey]?.has(playerId));
  if (hasSelections && !window.confirm("移除该行会同时取消此玩家所有周次的勾选，继续吗？")) return;
  state.matrixPlayerIds = state.matrixPlayerIds.filter((id) => id !== playerId);
  for (const weekKey of state.matrixWeekKeys) state.matrixSelections[weekKey]?.delete(playerId);
  if (hasSelections) state.matrixDirty = true;
  renderBackfillMatrix();
}

async function saveInlineLabels(element) {
  const row = element.closest("tr");
  if (!row) return;
  const playerId = element.dataset.inlinePlayerId;
  const playerLabel = row.querySelector("[data-inline-player-label]")?.value.trim();
  if (!playerLabel) {
    showToast("玩家备注不能为空", true);
    return;
  }
  element.disabled = true;
  try {
    await api("/api/admin/labels", {
      method: "POST",
      body: JSON.stringify({ playerId, playerLabel })
    });
    showToast("玩家备注已保存");
    await loadBootstrap({ quiet: true });
  } catch (error) {
    showToast(error.message, true);
  } finally {
    element.disabled = false;
  }
}

async function saveInlineUnionLabel(element) {
  const row = element.closest("tr");
  if (!row) return;
  const unionId = Number(element.dataset.inlineUnionId) || 0;
  const unionLabel = row.querySelector("[data-inline-union-label]")?.value.trim();
  if (unionId <= 0 || !unionLabel) {
    showToast("联盟备注不能为空", true);
    return;
  }
  element.disabled = true;
  try {
    await api("/api/admin/labels", {
      method: "POST",
      body: JSON.stringify({ unionId, unionLabel })
    });
    showToast("联盟备注已保存，相关玩家已同步");
    await loadBootstrap({ quiet: true });
  } catch (error) {
    showToast(error.message, true);
  } finally {
    element.disabled = false;
  }
}

async function handleAction(action, element) {
  if (action === "lock-access") {
    if (!canDiscardBackfillDraft()) return;
    sessionStorage.removeItem(ACCESS_TOKEN_KEY);
    sessionStorage.removeItem(ADMIN_TOKEN_KEY);
    window.location.reload();
    return;
  }
  if (action === "backfill-mode") {
    state.backfillMode = element.dataset.mode === "detail" ? "detail" : "matrix";
    renderBackfill();
    return;
  }
  if (action === "add-matrix-player") {
    addMatrixPlayer();
    return;
  }
  if (action === "remove-matrix-player") {
    removeMatrixPlayer(element.dataset.matrixPlayer);
    return;
  }
  if (action === "save-matrix") {
    await saveMatrix(element);
    return;
  }
  if (action === "save-inline-labels") {
    await saveInlineLabels(element);
    return;
  }
  if (action === "save-inline-union-label") {
    await saveInlineUnionLabel(element);
    return;
  }
  if (action === "load-backfill") {
    await loadBackfill();
    return;
  }
  if (action === "clear-backfill") {
    if (state.backfillMode === "matrix") {
      if (state.matrixDirty && !window.confirm("确定放弃当前矩阵修改吗？")) return;
      resetBackfillMatrix();
      renderBackfillMatrix();
      return;
    }
    if (filledBackfillCount() > 0 && !window.confirm("确定清空当前补录表吗？")) return;
    resetBackfillEditor(state.backfillWeekKey);
    renderBackfill();
    return;
  }
  if (action === "save-backfill") {
    await saveBackfill(element);
    return;
  }
  if (action === "collect") {
    element.disabled = true;
    try {
      await api("/api/admin/collect", { method: "POST", body: JSON.stringify({}) });
      showToast("采集请求已完成");
      await loadBootstrap({ quiet: true });
    } catch (error) {
      showToast(error.message, true);
    } finally {
      element.disabled = false;
    }
  }
  if (action === "save-token") {
    const value = $("#admin-token").value.trim();
    if (!value) {
      sessionStorage.removeItem(ADMIN_TOKEN_KEY);
      state.adminVerified = false;
      showToast("管理权限已锁定");
      renderAll();
      return;
    }
    sessionStorage.setItem(ADMIN_TOKEN_KEY, value);
    element.disabled = true;
    const verified = await verifyStoredAdminToken();
    if (verified) {
      showToast("管理密码验证成功");
      renderAll();
    } else {
      sessionStorage.removeItem(ADMIN_TOKEN_KEY);
      state.adminVerified = false;
      showToast("管理密码错误", true);
      renderSystem();
    }
    element.disabled = false;
    return;
  }
}

document.addEventListener("click", (event) => {
  const nav = event.target.closest("[data-view]");
  if (nav) {
    setView(nav.dataset.view);
    return;
  }
  const arena = event.target.closest("[data-arena]");
  if (arena) {
    if (!canDiscardBackfillDraft()) return;
    state.arenaKey = arena.dataset.arena;
    state.weekKey = null;
    state.weekDetail = null;
    state.playerDetail = null;
    state._hallData = null;
    resetBackfillEditor();
    resetBackfillMatrix();
    renderAll();
    return;
  }
  const player = event.target.closest("[data-player-id]");
  if (player) {
    void selectPlayer(player.dataset.playerId);
    return;
  }
  const week = event.target.closest("[data-week-key]");
  if (week) {
    state.weekKey = week.dataset.weekKey;
    state.weekDetail = null;
    renderWeeks();
    return;
  }
  const hallWindow = event.target.closest("[data-hall-window]");
  if (hallWindow) {
    state.hallWindow = Number(hallWindow.dataset.hallWindow);
    state._hallData = null;
    renderHall();
    return;
  }
  const hallMode = event.target.closest("[data-hall-mode]");
  if (hallMode) {
    state.hallMode = hallMode.dataset.hallMode === "table" ? "table" : "matrix";
    renderHall();
    return;
  }
  const action = event.target.closest("[data-action]");
  if (action) void handleAction(action.dataset.action, action);
  const activate = event.target.closest("[data-activate-season]");
  if (activate) {
    if (!canDiscardBackfillDraft()) return;
    void (async () => {
      try {
        await api(`/api/admin/seasons/${encodeURIComponent(activate.dataset.activateSeason)}/activate`, { method: "POST", body: "{}" });
        showToast("当前竞技场届次已切换");
        state.seasonId = activate.dataset.activateSeason;
        resetBackfillEditor();
        resetBackfillMatrix();
        await loadBootstrap({ quiet: true });
      } catch (error) {
        showToast(error.message, true);
      }
    })();
    return;
  }
  const editSeason = event.target.closest("[data-edit-season]");
  if (editSeason) {
    if (!canDiscardBackfillDraft()) return;
    state.seasonEditingId = editSeason.dataset.editSeason;
    renderSystem();
    return;
  }
  if (action?.dataset.action === "cancel-season-edit") {
    state.seasonEditingId = null;
    renderSystem();
  }
});

document.addEventListener("input", (event) => {
  if (event.target.closest("#season-form [name='startsAt'], #season-form [name='weeks'], #season-form [name='endsAt']")) {
    updateSeasonEndPreview();
    return;
  }
  const backfillField = event.target.closest("[data-backfill-field]");
  if (backfillField) {
    const row = state.backfillRows?.[Number(backfillField.dataset.backfillRow)];
    if (row) row[backfillField.dataset.backfillField] = backfillField.value;
    state.backfillDirty = true;
    const count = $("#backfill-count");
    if (count) count.textContent = `${filledBackfillCount()} / ${state.backfillRows.length}`;
    const status = $("#backfill-status");
    if (status) {
      status.className = "status-badge is-partial";
      status.textContent = "有未保存修改";
    }
    return;
  }
  if (event.target.id === "player-search") {
    if (!event.isComposing) updatePlayerSearch(event.target);
  }
});

document.addEventListener("compositionend", (event) => {
  if (event.target.id === "player-search") updatePlayerSearch(event.target);
});

document.addEventListener("change", (event) => {
  const matrixToggle = event.target.closest("[data-matrix-toggle]");
  if (matrixToggle) {
    ensureBackfillMatrix();
    const weekKey = matrixToggle.dataset.matrixWeek;
    const playerId = matrixToggle.dataset.matrixPlayer;
    const selection = state.matrixSelections[weekKey] || new Set();
    if (matrixToggle.checked) selection.add(playerId);
    else selection.delete(playerId);
    state.matrixSelections[weekKey] = selection;
    state.matrixDirty = matrixSelectionSignature(state.matrixSelections, state.matrixWeekKeys)
      !== matrixSelectionSignature(state.matrixOriginalSelections, state.matrixWeekKeys);
    const count = $(`[data-matrix-count="${weekKey}"]`);
    if (count) count.textContent = `${selection.size}/${currentArena().zones.length * 5}`;
    const status = $("#matrix-status");
    if (status) {
      status.className = `status-badge${state.matrixDirty ? " is-partial" : ""}`;
      status.textContent = state.matrixDirty ? "有未保存修改" : `${state.matrixPlayerIds.length} 位玩家 · ${state.matrixWeekKeys.length} 个结算周`;
    }
    const save = $("[data-action='save-matrix']");
    if (save) save.disabled = !state.matrixDirty;
    return;
  }
  const backfillField = event.target.closest("[data-backfill-field]");
  if (backfillField) {
    const rowIndex = Number(backfillField.dataset.backfillRow);
    const row = state.backfillRows?.[rowIndex];
    if (!row) return;
    const field = backfillField.dataset.backfillField;
    if (field === "playerId") {
      if (!hydratePlayerRow(row)) {
        row.nickname = "";
        row.playerLabel = "";
        row.unionId = "";
        row.unionName = "";
        row.unionLabel = "";
      }
    }
    if (field === "unionId") {
      if (row.unionId) hydrateUnionRow(row);
      else {
        row.unionName = "";
        row.unionLabel = "";
      }
    }
    if (field === "nickname" && !row.playerLabel.trim()) row.playerLabel = row.nickname.trim();
    if (field === "unionName" && row.unionId && !row.unionLabel.trim()) row.unionLabel = row.unionName.trim();
    state.backfillDirty = true;
    renderBackfill();
    return;
  }
  if (event.target.id === "backfill-week") {
    if (!canDiscardBackfillDraft()) {
      renderBackfill();
      return;
    }
    resetBackfillEditor(event.target.value);
    renderBackfill();
    return;
  }
  if (event.target.id === "season-select") {
    if (!canDiscardBackfillDraft()) {
      renderTopbar();
      return;
    }
    state.seasonId = event.target.value;
    state.weekKey = null;
    state.weekDetail = null;
    state.playerDetail = null;
    state._hallData = null;
    resetBackfillEditor();
    resetBackfillMatrix();
    void loadBootstrap({ quiet: true });
  }
});

document.addEventListener("paste", (event) => {
  const target = event.target.closest("[data-backfill-field]");
  if (!target) return;
  const text = event.clipboardData?.getData("text") || "";
  if (!text.includes("\t") && !text.includes("\n")) return;
  event.preventDefault();
  applyBackfillPaste(target, text);
});

document.addEventListener("keydown", (event) => {
  const inlineLabel = event.target.closest("[data-inline-player-label], [data-inline-union-label]");
  if (inlineLabel && event.key === "Enter") {
    event.preventDefault();
    const isUnion = inlineLabel.matches("[data-inline-union-label]");
    const button = inlineLabel.closest("tr")?.querySelector(isUnion
      ? "[data-action='save-inline-union-label']"
      : "[data-action='save-inline-labels']");
    if (button) void (isUnion ? saveInlineUnionLabel(button) : saveInlineLabels(button));
    return;
  }
  const target = event.target.closest("[data-backfill-field]");
  if (!target || event.key !== "Enter") return;
  event.preventDefault();
  const nextRow = Number(target.dataset.backfillRow) + 1;
  $(`[data-backfill-row="${nextRow}"][data-backfill-col="${target.dataset.backfillCol}"]`)?.focus();
});

document.addEventListener("submit", (event) => {
  const submittedForm = event.target;
  const formId = formElementId(submittedForm);
  if (formId === "access-form") {
    event.preventDefault();
    void submitAccessForm();
    return;
  }
  if (formId === "new-player-form") {
    event.preventDefault();
    const form = new FormData(event.target);
    const button = event.target.querySelector("button[type='submit']");
    button.disabled = true;
    void (async () => {
      try {
        const result = await api("/api/admin/players", {
          method: "POST",
          body: JSON.stringify({
            playerId: form.get("playerId"),
            nickname: form.get("nickname"),
            playerLabel: form.get("playerLabel"),
            unionId: form.get("unionId")
          })
        });
        showToast(`玩家档案 ${result.player?.playerLabel || form.get("playerId")} 已添加`);
        event.target.reset();
        await loadBootstrap({ quiet: true });
      } catch (error) {
        showToast(error.message, true);
      } finally {
        button.disabled = false;
      }
    })();
    return;
  }
  if (formId === "identity-label-form") {
    event.preventDefault();
    const form = new FormData(event.target);
    const playerId = event.target.dataset.playerId;
    const button = event.target.querySelector("button[type='submit']");
    button.disabled = true;
    void (async () => {
      try {
        await api("/api/admin/labels", {
          method: "POST",
          body: JSON.stringify({
            playerId,
            playerLabel: form.get("playerLabel")
          })
        });
        showToast("玩家标注已保存");
        await loadBootstrap({ quiet: true });
        await selectPlayer(playerId);
      } catch (error) {
        showToast(error.message, true);
      } finally {
        button.disabled = false;
      }
    })();
    return;
  }
  if (formId !== "season-form") return;
  event.preventDefault();
  void (async () => {
    const form = new FormData(submittedForm);
    try {
      await api("/api/admin/seasons", {
        method: "POST",
        body: JSON.stringify({
          id: form.get("id"),
          label: form.get("label"),
          startsAt: new Date(form.get("startsAt")).toISOString(),
          endsAt: form.get("weeks") ? null : (form.get("endsAt") ? new Date(form.get("endsAt")).toISOString() : null),
          weeks: form.get("weeks") || null,
          active: false
        })
      });
      showToast("竞技场届次已保存");
      state.seasonEditingId = null;
      submittedForm.reset();
      await loadBootstrap({ quiet: true });
    } catch (error) {
      showToast(error.message, true);
    }
  })();
});

$("#refresh-button").addEventListener("click", () => void loadBootstrap());

setInterval(() => {
  const editingLabel = document.activeElement?.matches?.("[data-inline-player-label], [data-inline-union-label]");
  if (state.accessVerified && !document.hidden && !(state.view === "backfill" && (state.backfillDirty || state.matrixDirty)) && !editingLabel) {
    void loadBootstrap({ quiet: true });
  }
}, 30_000);

void initializeAccess();
