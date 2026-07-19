import { EventEmitter } from "node:events";
import {
  isFinalCaptureWindow,
  publishedSettlementFor
} from "./domain/calendar.js";
import { hasCollectorCredentials } from "./config.js";

export class CollectorScheduler extends EventEmitter {
  constructor(config, collector, storage, { now = () => new Date() } = {}) {
    super();
    this.config = config;
    this.collector = collector;
    this.storage = storage;
    this.now = now;
    this.timer = null;
    this.ticking = false;
    this.lastPollAt = null;
    this.nextPollAt = null;
    this.startedAt = null;
  }

  start() {
    if (this.timer) return;
    this.startedAt = this.now().toISOString();
    if (!hasCollectorCredentials(this.config)) {
      this.storage.addEvent("warn", "scheduler", "Collector credentials are not configured; automatic polling is paused");
    }
    this.timer = setInterval(() => void this.tick(), 5_000);
    this.timer.unref?.();
    setTimeout(() => void this.tick(true), 500).unref?.();
  }

  currentIntervalMs(date = this.now()) {
    const finalWindow = this.config.arenas.some((arena) => isFinalCaptureWindow(
      date,
      arena,
      this.config.finalCaptureWindowMinutes,
      this.config.settlementGraceMinutes,
      this.config.utcOffsetMinutes
    ));
    return (finalWindow ? this.config.finalPollIntervalSeconds : this.config.pollIntervalSeconds) * 1000;
  }

  async tick(force = false) {
    if (this.ticking) return;
    this.ticking = true;
    const now = this.now();
    try {
      const canCollect = hasCollectorCredentials(this.config);
      const interval = this.currentIntervalMs(now);
      const due = force || !this.lastPollAt || now.getTime() - this.lastPollAt.getTime() >= interval;
      if (canCollect && due && !this.collector.running) {
        try {
          const collected = await this.collector.collect({ source: force ? "startup" : "scheduled" });
          this.finalizeCollectedRankings(collected, this.now());
          this.lastPollAt = this.now();
        } catch {
          this.lastPollAt = this.now();
        }
      }
      this.nextPollAt = new Date((this.lastPollAt?.getTime() ?? now.getTime()) + this.currentIntervalMs(this.now()));
    } finally {
      this.ticking = false;
      this.emit("state", this.getState());
    }
  }

  finalizeCollectedRankings(collections = [], now = this.now()) {
    const results = [];
    for (const collection of collections) {
      const arena = this.config.arenas.find((item) => item.key === collection.arenaKey);
      if (!arena) continue;
      const capturedAt = new Date(collection.capturedAt);
      const { weekKey } = publishedSettlementFor(capturedAt, arena, this.config.utcOffsetMinutes);
      const existing = this.storage.getSettlement(arena.key, weekKey);
      const entryCount = collection.zones.reduce((total, zone) => total + zone.players.length, 0);
      if (existing?.status === "final") continue;
      if (existing?.status === "partial" && existing.entryCount >= entryCount) continue;
      results.push(this.storage.finalizeWeek({
        arena,
        weekKey,
        snapshotId: collection.snapshotId,
        finalizedAt: now
      }));
    }
    return results;
  }

  finalizeReadyWeeks(now = this.now(), collections = []) {
    return this.finalizeCollectedRankings(collections, now);
  }

  async collectNow(arenaKeys = null) {
    const result = await this.collector.collect({ source: "manual", arenaKeys });
    this.lastPollAt = this.now();
    this.finalizeCollectedRankings(result, this.lastPollAt);
    this.nextPollAt = new Date(this.lastPollAt.getTime() + this.currentIntervalMs(this.lastPollAt));
    return result;
  }

  finalizeNow({ arenaKey, weekKey = null, seasonId = null, snapshotId = null }) {
    const arena = this.config.arenas.find((item) => item.key === arenaKey);
    if (!arena) throw new Error(`Unknown arena: ${arenaKey}`);
    const resolvedWeek = weekKey
      ?? publishedSettlementFor(this.now(), arena, this.config.utcOffsetMinutes).weekKey;
    return this.storage.finalizeWeek({ arena, weekKey: resolvedWeek, seasonId, snapshotId, finalizedAt: this.now() });
  }

  getState() {
    return {
      startedAt: this.startedAt,
      lastPollAt: this.lastPollAt?.toISOString() ?? null,
      nextPollAt: this.nextPollAt?.toISOString() ?? null,
      credentialsConfigured: hasCollectorCredentials(this.config),
      collector: this.collector.getState()
    };
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.collector.close();
  }
}
