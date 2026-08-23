function compareWeekKeys(a, b) {
  return String(a).localeCompare(String(b));
}

function streakScope(week) {
  return String(week.seasonId ?? "");
}

function streakWeekKey(week) {
  return `${streakScope(week)}\u0000${week.weekKey}`;
}

function compareTimelineWeeks(a, b) {
  return String(a.cutoffAt ?? a.weekKey).localeCompare(String(b.cutoffAt ?? b.weekKey))
    || streakScope(a).localeCompare(streakScope(b));
}

export function calculateStandings(weeklyRows, finalizedWeeks, timelineWeeks = finalizedWeeks) {
  const finalizedByKey = new Map(finalizedWeeks.map((week) => [streakWeekKey(week), week]));
  const timelineByKey = new Map();
  for (const week of timelineWeeks) {
    const key = streakWeekKey(week);
    const existing = timelineByKey.get(key);
    if (!existing || (existing.status === "future" && week.status !== "future")) {
      timelineByKey.set(key, week);
    }
  }
  for (const [key, week] of finalizedByKey) {
    if (!timelineByKey.has(key) || timelineByKey.get(key).status === "future") {
      timelineByKey.set(key, week);
    }
  }
  const timeline = [...timelineByKey.values()]
    .filter((week) => week.status !== "future")
    .sort(compareTimelineWeeks);
  const weekIndex = new Map(timeline.map((week, index) => [streakWeekKey(week), index]));
  const players = new Map();

  for (const row of weeklyRows) {
    let player = players.get(row.playerId);
    if (!player) {
      player = {
        playerId: row.playerId,
        nickname: row.nickname,
        playerLabel: row.playerLabel || row.nickname || row.playerId,
        unionId: row.unionId || 0,
        unionName: row.unionName,
        unionLabel: row.unionLabel || row.unionName || "未加入联盟",
        emperorCount: 0,
        rankOneCount: 0,
        currentStreak: 0,
        longestStreak: 0,
        weeks: new Set(),
        streakWeeks: new Set(),
        arenas: new Set(),
        zones: new Set(),
        lastSeenAt: row.capturedAt,
        lastRank: row.rank
      };
      players.set(row.playerId, player);
    }
    player.emperorCount += 1;
    if (row.rank === 1) player.rankOneCount += 1;
    player.weeks.add(row.weekKey);
    player.streakWeeks.add(streakWeekKey(row));
    player.arenas.add(row.arenaKey);
    player.zones.add(`${row.arenaKey}:${row.zoneIndex}`);
    if (!player.lastSeenAt || row.capturedAt > player.lastSeenAt) {
      player.nickname = row.nickname || player.nickname;
      player.playerLabel = row.playerLabel || player.playerLabel;
      player.unionId = row.unionId || 0;
      player.unionName = row.unionName || player.unionName;
      player.unionLabel = row.unionLabel || row.unionName || player.unionLabel;
      player.lastSeenAt = row.capturedAt;
      player.lastRank = row.rank;
    }
  }

  const output = [];
  for (const player of players.values()) {
    const indices = [...player.streakWeeks]
      .map((week) => weekIndex.get(week))
      .filter(Number.isInteger)
      .sort((a, b) => a - b);
    let longest = 0;
    let run = 0;
    let previous = -2;
    for (const index of indices) {
      const sameSeason = previous >= 0
        && streakScope(timeline[index]) === streakScope(timeline[previous]);
      run = sameSeason && index === previous + 1 ? run + 1 : 1;
      longest = Math.max(longest, run);
      previous = index;
    }
    let current = 0;
    if (indices.length > 0 && indices.at(-1) === timeline.length - 1) {
      current = 1;
      for (let i = indices.length - 2; i >= 0
        && indices[i] === indices[i + 1] - 1
        && streakScope(timeline[indices[i]]) === streakScope(timeline[indices[i + 1]]); i -= 1) {
        current += 1;
      }
    }
    player.longestStreak = longest;
    player.currentStreak = current;
    delete player.streakWeeks;
    output.push({
      ...player,
      weeks: [...player.weeks].sort(compareWeekKeys),
      arenas: [...player.arenas],
      zones: [...player.zones]
    });
  }

  output.sort((a, b) =>
    b.emperorCount - a.emperorCount ||
    b.longestStreak - a.longestStreak ||
    b.currentStreak - a.currentStreak ||
    a.playerLabel.localeCompare(b.playerLabel, "zh-CN")
  );

  const leader = output[0];
  const candidates = leader
    ? output.filter((player) =>
      player.emperorCount === leader.emperorCount &&
      player.longestStreak === leader.longestStreak
    )
    : [];
  return {
    standings: output,
    candidates,
    finalizedWeekCount: finalizedByKey.size,
    seatCount: weeklyRows.length,
    uniquePlayerCount: output.length
  };
}
