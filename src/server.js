import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { Storage } from "./storage.js";
import { ArenaCollector } from "./collector.js";
import { CollectorScheduler } from "./scheduler.js";
import { createHttpHandler } from "./http-app.js";
import { seedDemoData } from "./demo-data.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const config = loadConfig();
const storage = new Storage(config);
if (config.demoMode) seedDemoData(storage, config);
const collector = new ArenaCollector(config, storage);
const scheduler = new CollectorScheduler(config, collector, storage);
const handler = createHttpHandler({
  config,
  storage,
  scheduler,
  publicDir: path.resolve(moduleDir, "..", "public")
});
const server = http.createServer(handler);

server.listen(config.port, config.host, () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  const shownHost = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
  console.log(`Arena tracker listening on http://${shownHost}:${port}`);
  if (!config.accessToken) {
    console.warn("ACCESS_TOKEN is empty; dashboard data APIs are locked");
  }
  if (!config.adminToken) {
    console.warn("ADMIN_TOKEN is empty; manual write APIs are locked while automatic collection remains active");
  }
  scheduler.start();
});

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`Shutting down after ${signal}`);
  scheduler.close();
  server.close(() => {
    storage.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

export { config, storage, collector, scheduler, server };
