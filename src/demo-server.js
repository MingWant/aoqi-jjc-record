process.env.ARENA_DEMO_MODE = "1";
process.env.DATA_FILE ??= "./data/demo.sqlite";
process.env.PORT ??= "8787";
await import("./server.js");
