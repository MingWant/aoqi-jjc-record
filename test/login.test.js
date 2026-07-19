import test from "node:test";
import assert from "node:assert/strict";
import { parseFlatXml, parseServers, resolveServer } from "../src/protocol/login.js";

test("flat login XML parser ignores the outer element", () => {
  const parsed = parseFlatXml("<?xml version=\"1.0\"?><root><c>ok</c><sid><![CDATA[sid-123]]></sid><zn>一区/0;</zn></root>");
  assert.deepEqual(parsed, { c: "ok", sid: "sid-123", zn: "一区/0;" });
});

test("server resolver follows the Flash server-list format", () => {
  const response = {
    svr: "10.0.0.1:9001:0;10.0.0.2:9002:0;",
    zn: "一区/0;二区/1;test服/0;"
  };
  assert.deepEqual(parseServers(response.svr), [
    { host: "10.0.0.1", port: 9001 },
    { host: "10.0.0.2", port: 9002 }
  ]);
  assert.deepEqual(resolveServer(response, "二区"), {
    zone: "二区",
    values: [1],
    host: "10.0.0.2",
    port: 9002
  });
});
