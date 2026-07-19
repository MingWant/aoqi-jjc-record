export const PLAYER_FIELDS = [
  "rank",
  "playerId",
  "nickname",
  "clothes",
  "vipLevel",
  "unionId",
  "unionName",
  "unionIcon",
  "nicknameCard"
];

export function parsePlayerRecord(value) {
  const fields = String(value ?? "").split("|");
  if (fields.length < 3) return null;
  const rank = Number.parseInt(fields[0], 10);
  const playerId = fields[1]?.trim() ?? "";
  if (!Number.isFinite(rank) || rank <= 0 || !playerId || playerId === "0" || playerId === "-2") {
    return null;
  }
  return {
    rank,
    playerId,
    nickname: fields[2] ?? "",
    clothes: fields[3] ?? "",
    vipLevel: Number.parseInt(fields[4] ?? "0", 10) || 0,
    unionId: Number.parseInt(fields[5] ?? "0", 10) || 0,
    unionName: fields[6] || "未加入联盟",
    unionIcon: Number.parseInt(fields[7] ?? "0", 10) || 0,
    nicknameCard: fields[8] ?? ""
  };
}

export function parsePlayerList(value, limit = 5) {
  if (value == null || value === "") return [];
  return String(value)
    .split("#")
    .map(parsePlayerRecord)
    .filter(Boolean)
    .filter((player) => player.rank <= limit)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit);
}

function zonePayloads(body) {
  if (Array.isArray(body?.zl)) return body.zl;
  if (Array.isArray(body?.data?.zl)) return body.data.zl;
  if (Array.isArray(body?.z)) return body.z;
  return [];
}

export function parseTopFiveResponse(body, arena) {
  const payloads = zonePayloads(body);
  if (payloads.length === 0) {
    const returnCode = body?.r ?? body?.data?.r;
    const suffix = returnCode == null ? "" : ` (return code ${returnCode})`;
    throw new Error(`Ranking response did not contain zl${suffix}`);
  }

  return payloads.map((payload, index) => {
    const configured = arena.zones?.find((zone) => zone.index === index) ?? arena.zones?.[index];
    const serverZoneId = Number(
      payload?.serverZoneId ?? payload?.zoneId ?? payload?.curz ?? payload?.zi ?? payload?.z ?? configured?.serverZoneId ?? index
    );
    const raw = payload?.ext10 ?? payload?.players ?? payload?.rankings ?? "";
    return {
      index,
      serverZoneId: Number.isFinite(serverZoneId) ? serverZoneId : index,
      name: payload?.zoneName ?? payload?.name ?? configured?.name ?? `战区 ${index + 1}`,
      players: parsePlayerList(raw, 5),
      raw: String(raw ?? "")
    };
  });
}
