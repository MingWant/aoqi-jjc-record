import { EventEmitter } from "node:events";
import { ArenaGameClient } from "./protocol/game-client.js";
import { parseTopFiveResponse } from "./domain/players.js";

export class ArenaCollector extends EventEmitter {
  constructor(config, storage, { gameClient = null, now = () => new Date() } = {}) {
    super();
    this.config = config;
    this.storage = storage;
    this.now = now;
    this.gameClient = gameClient ?? new ArenaGameClient(config, (level, message) => this.log(level, message));
    this.running = false;
    this.state = {
      phase: "idle",
      lastStartedAt: null,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastError: null,
      latestSnapshotIds: {},
      lastArenaErrors: {}
    };
  }

  async collect({ source = "scheduled", arenaKeys = null } = {}) {
    if (this.running) throw new Error("A ranking collection is already running");
    this.running = true;
    this.state.phase = "collecting";
    this.state.lastStartedAt = this.now().toISOString();
    this.emitState();
    const selected = this.config.arenas.filter((arena) => !arenaKeys || arenaKeys.includes(arena.key));
    const result = [];
    const errors = [];
    this.state.lastArenaErrors = {};
    try {
      for (const arena of selected) {
        const maxAttempts = Math.max(1, Number(this.config.collectionRetries ?? 0) + 1);
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          const attemptedAt = this.now();
          try {
            const body = await this.gameClient.fetchTopFive(arena.protocolType);
            const zones = parseTopFiveResponse(body, arena);
            const capturedAt = this.now();
            const snapshotId = this.storage.saveSnapshot({ arena, capturedAt, zones, body, source });
            this.state.latestSnapshotIds[arena.key] = snapshotId;
            result.push({ arenaKey: arena.key, snapshotId, capturedAt: capturedAt.toISOString(), zones });
            this.log("info", `${arena.name} ranking collected: ${zones.length} zones`);
            break;
          } catch (error) {
            this.gameClient.close?.();
            const wrapped = new Error(`${arena.name}: ${error.message}`, { cause: error });
            if (attempt < maxAttempts) {
              this.log("warn", `${wrapped.message}; retrying (${attempt}/${this.config.collectionRetries})`);
              continue;
            }
            this.storage.saveFailedSnapshot({ arena, capturedAt: attemptedAt, error, source });
            errors.push(wrapped);
            this.state.lastArenaErrors[arena.key] = wrapped.message;
            this.log("warn", `Ranking collection failed: ${wrapped.message}`);
          }
        }
      }
      if (errors.length && !result.length) {
        throw new AggregateError(errors, errors.map((error) => error.message).join("; "));
      }
      this.state.phase = errors.length ? "partial" : "ready";
      this.state.lastSuccessAt = this.now().toISOString();
      this.state.lastErrorAt = errors.length ? this.now().toISOString() : this.state.lastErrorAt;
      this.state.lastError = errors.length ? errors.map((error) => error.message).join("; ") : null;
      return result;
    } catch (error) {
      this.state.phase = "error";
      this.state.lastErrorAt = this.now().toISOString();
      this.state.lastError = error.message;
      this.log("error", `Ranking collection failed: ${error.message}`);
      throw error;
    } finally {
      this.gameClient.close?.();
      this.running = false;
      this.emitState();
    }
  }

  log(level, message) {
    this.storage.addEvent(level, "collector", message);
    this.emit("log", { level, message, at: this.now().toISOString() });
  }

  emitState() {
    this.emit("state", this.getState());
  }

  getState() {
    return { ...this.state, running: this.running };
  }

  close() {
    this.gameClient.close();
  }
}
