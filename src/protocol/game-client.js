import net from "node:net";
import { EventEmitter } from "node:events";
import { decodeTransportPacket, XtPacketEncoder } from "./packets.js";
import { loginHttp } from "./login.js";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isXtSuccess(body) {
  if (body?.r == null) return true;
  const returnCode = Number(body.r);
  return returnCode === 0 || returnCode === 1;
}

export class GameSocketClient extends EventEmitter {
  constructor({ timeoutMs = 12000, logger = () => {} } = {}) {
    super();
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.encoder = new XtPacketEncoder();
    this.pending = [];
    this.loginWaiter = null;
    this.ready = false;
  }

  async connect(host, port) {
    this.close();
    this.buffer = Buffer.alloc(0);
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      this.socket = socket;
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Socket connection timed out: ${host}:${port}`));
      }, this.timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timeout);
        this.logger("info", `Socket connected to ${host}:${port}`);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      socket.on("data", (data) => this.onData(data));
      socket.on("close", () => this.onClose());
      socket.on("error", (error) => this.logger("error", `Socket error: ${error.message}`));
      socket.setKeepAlive(true, 30_000);
    });
  }

  async login(zone, account, sessionId) {
    if (!this.socket || this.socket.destroyed) throw new Error("Socket is not connected");
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.loginWaiter = null;
        reject(new Error("Socket login response timed out"));
      }, this.timeoutMs);
      this.loginWaiter = {
        resolve: (value) => {
          clearTimeout(timer);
          this.loginWaiter = null;
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          this.loginWaiter = null;
          reject(error);
        }
      };
    });
    this.socket.write(this.encoder.buildLoginPacket(zone, account, sessionId));
    const login = await response;
    const userId = Number(login.id);
    if (!Number.isInteger(userId) || userId <= 0) throw new Error("Socket login did not return a valid user id");
    this.encoder.initialize(sessionId, userId);
    this.ready = true;
    return { userId, lastLoginTime: Number(login.lastLoginTime) || 0 };
  }

  send(messageId, cmd, params = {}, routeId = -1) {
    if (!this.ready || !this.socket || this.socket.destroyed) throw new Error("Game session is not ready");
    this.socket.write(this.encoder.buildXtPacket(messageId, cmd, params, routeId));
  }

  request(messageId, cmd, params = {}, routeId = -1) {
    if (!this.ready) return Promise.reject(new Error("Game session is not ready"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.pending.findIndex((item) => item.resolve === resolve);
        if (index >= 0) this.pending.splice(index, 1);
        reject(new Error(`XT request timed out: ${cmd}`));
      }, this.timeoutMs);
      this.pending.push({ messageId, cmd, resolve, reject, timer });
      try {
        this.send(messageId, cmd, params, routeId);
      } catch (error) {
        clearTimeout(timer);
        this.pending.pop();
        reject(error);
      }
    });
  }

  onData(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    if (this.buffer[0] === 0x3c) {
      const terminator = this.buffer.indexOf(0);
      if (terminator < 0) return;
      this.buffer = this.buffer.subarray(terminator + 1);
    }
    while (this.buffer.length >= 4) {
      const packetLength = this.buffer.readUInt32BE(0);
      if (packetLength < 4 || packetLength > 16 * 1024 * 1024) {
        this.logger("error", `Invalid socket packet length: ${packetLength}`);
        this.socket?.destroy();
        return;
      }
      const totalLength = packetLength + 4;
      if (this.buffer.length < totalLength) return;
      const packet = this.buffer.subarray(0, totalLength);
      this.buffer = this.buffer.subarray(totalLength);
      const decoded = decodeTransportPacket(packet);
      if (decoded) this.onPacket(decoded);
    }
  }

  onPacket(packet) {
    this.emit("packet", packet);
    if (packet.type === "login" && this.loginWaiter) {
      this.loginWaiter.resolve(packet.body);
      return;
    }
    if (packet.body && this.loginWaiter && packet.body.id && packet.body.lastLoginTime != null) {
      this.loginWaiter.resolve(packet.body);
      return;
    }
    const index = this.pending.findIndex((item) =>
      (packet.cmd && packet.cmd === item.cmd) ||
      (packet.messageId > 0 && packet.messageId === item.messageId)
    );
    if (index < 0) return;
    const [pending] = this.pending.splice(index, 1);
    clearTimeout(pending.timer);
    const returnCode = packet.body?.r;
    if (!isXtSuccess(packet.body)) {
      pending.reject(new Error(`XT ${pending.cmd} returned ${returnCode}`));
    } else {
      pending.resolve(packet.body);
    }
  }

  onClose() {
    this.ready = false;
    for (const pending of this.pending.splice(0)) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Socket closed before the response arrived"));
    }
    if (this.loginWaiter) {
      this.loginWaiter.reject(new Error("Socket closed during login"));
    }
    this.emit("close");
  }

  close() {
    this.ready = false;
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    for (const pending of this.pending.splice(0)) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Game client closed"));
    }
    this.buffer = Buffer.alloc(0);
  }
}

export class ArenaGameClient {
  constructor(config, logger = () => {}) {
    this.config = config;
    this.logger = logger;
    this.client = null;
    this.session = null;
  }

  async ensureReady() {
    if (this.client?.ready) return;
    this.close();
    const login = await loginHttp(this.config, this.logger);
    const client = new GameSocketClient({ timeoutMs: this.config.requestTimeoutMs, logger: this.logger });
    try {
      await client.connect(login.server.host, login.server.port);
      const session = await client.login(login.server.zone, login.account, login.sessionId);
      client.send(13, "13_1", {});
      client.send(1, "getStartInfo", {
        firstLogin: false,
        lastLoginTime: session.lastLoginTime,
        di: "PC#Blink#360SE#",
        pi: 2
      });
      client.send(1, "getCurrentTime", {});
      await delay(500);
      this.client = client;
      this.session = { ...login, ...session };
      this.logger("info", `Game session ready for user ${session.userId}`);
    } catch (error) {
      client.close();
      throw error;
    }
  }

  async fetchTopFive(protocolType) {
    await this.ensureReady();
    try {
      return await this.client.request(16, "16_24_L", { t: protocolType });
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close() {
    this.client?.close();
    this.client = null;
    this.session = null;
  }
}
