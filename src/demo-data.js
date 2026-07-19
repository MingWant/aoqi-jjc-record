import { cutoffForWeek, addLocalDays } from "./domain/calendar.js";

const NAMES = [
  "星河", "逐风", "长明", "青岚", "白榆", "归舟", "临渊", "问霜", "知夏", "惊鸿",
  "南枝", "行歌", "云归", "听雨", "望舒", "怀瑾", "清和", "砚秋", "照野", "流光",
  "北辰", "未央", "景明", "扶光", "疏影", "停云", "凌霄", "朝露", "鹤川", "千帆",
  "寻川", "松风", "既白", "见月", "闻溪", "星野", "清晏", "远山", "明川", "霁月"
];

function player(id, nickname, rank) {
  return {
    rank,
    playerId: String(id),
    nickname,
    clothes: "1;2;5;6;7",
    vipLevel: id % 12,
    unionId: (id % 7) + 1,
    unionName: ["九霄", "长风", "星海", "山河", "未加入联盟"][id % 5],
    unionIcon: id % 9,
    nicknameCard: ""
  };
}

function buildZones(arena, seasonIndex, weekIndex) {
  const zones = [];
  const used = new Set();
  const arenaOffset = arena.key === "classic" ? 0 : 17;
  for (let zoneIndex = 0; zoneIndex < arena.zones.length; zoneIndex += 1) {
    const configured = arena.zones[zoneIndex];
    const players = [];
    for (let rank = 1; rank <= 5; rank += 1) {
      let id;
      let nickname;
      if (arena.key === "classic" && zoneIndex === 0 && rank === 1) {
        id = 10001;
        nickname = "星河";
      } else if (arena.key === "legend" && zoneIndex === 0 && rank === 1 && weekIndex !== 2) {
        id = 20001;
        nickname = "长明";
      } else {
        let cursor = (seasonIndex * 11 + weekIndex * 7 + zoneIndex * 5 + rank + arenaOffset) % NAMES.length;
        id = (arena.key === "classic" ? 11000 : 21000) + cursor;
        while (used.has(id) || id === 10001 || id === 20001) {
          cursor = (cursor + 1) % NAMES.length;
          id = (arena.key === "classic" ? 11000 : 21000) + cursor;
        }
        nickname = NAMES[cursor];
      }
      used.add(id);
      players.push(player(id, nickname, rank));
    }
    zones.push({
      index: zoneIndex,
      serverZoneId: configured.serverZoneId,
      name: configured.name,
      players
    });
  }
  return zones;
}

function encodedBody(zones) {
  return {
    r: 1,
    zl: zones.map((zone) => ({
      ext10: zone.players.map((item) => [
        item.rank, item.playerId, item.nickname, item.clothes, item.vipLevel,
        item.unionId, item.unionName, item.unionIcon, item.nicknameCard
      ].join("|")).join("#")
    }))
  };
}

export function seedDemoData(storage, config, { force = false } = {}) {
  const counts = storage.counts();
  if (!force && counts.snapshots > 0) return { seeded: false, counts };

  const seasons = [
    { id: "27", label: "第27届", startsAt: "2026-01-02T12:00:00+08:00", endsAt: "2026-01-29T23:00:00+08:00", firstWeek: "2026-01-08", weeks: 4 },
    { id: "28", label: "第28届", startsAt: "2026-01-30T12:00:00+08:00", endsAt: "2026-02-26T23:00:00+08:00", firstWeek: "2026-02-05", weeks: 4 },
    { id: "29", label: "第29届", startsAt: "2026-03-27T12:00:00+08:00", endsAt: null, firstWeek: "2026-04-02", weeks: 6 }
  ];
  for (const season of seasons) {
    storage.createSeason({ ...season, active: season.id === "29" });
  }

  let snapshotCount = 0;
  for (let seasonIndex = 0; seasonIndex < seasons.length; seasonIndex += 1) {
    const season = seasons[seasonIndex];
    for (let weekIndex = 0; weekIndex < season.weeks; weekIndex += 1) {
      const weekKey = addLocalDays(season.firstWeek, weekIndex * 7, config.utcOffsetMinutes);
      for (const arena of config.arenas) {
        const zones = buildZones(arena, seasonIndex, weekIndex);
        const cutoff = cutoffForWeek(weekKey, arena, config.utcOffsetMinutes);
        const capturedAt = new Date(cutoff.getTime() + 30_000);
        const snapshotId = storage.saveSnapshot({
          arena,
          capturedAt,
          zones,
          body: encodedBody(zones),
          source: "demo"
        });
        storage.finalizeWeek({ arena, weekKey, seasonId: season.id, finalizedAt: new Date(cutoff.getTime() + 60_000), snapshotId });
        snapshotCount += 1;
      }
    }
  }
  storage.addEvent("info", "demo", `Demo dataset created with ${snapshotCount} snapshots`);
  return { seeded: true, snapshotCount, counts: storage.counts() };
}
