import test from "node:test";
import assert from "node:assert/strict";
import { encodeAmf3 } from "../src/protocol/amf3.js";
import { decodeTransportPacket, MessageSequence, XtPacketEncoder } from "../src/protocol/packets.js";

function utf(value) {
  const bytes = Buffer.from(value);
  const out = Buffer.alloc(2 + bytes.length);
  out.writeUInt16BE(bytes.length);
  bytes.copy(out, 2);
  return out;
}

function wrap(payload, packetNumber) {
  const key = Buffer.alloc(4);
  key.writeUInt32BE(packetNumber >>> 0);
  const encrypted = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) encrypted[index] = payload[index] ^ key[index % 4];
  const out = Buffer.alloc(8 + encrypted.length);
  out.writeUInt32BE(encrypted.length + 4, 0);
  out.writeUInt32BE(packetNumber >>> 0, 4);
  encrypted.copy(out, 8);
  return out;
}

function responsePacket(command, body, packetNumber = 79) {
  const header = Buffer.alloc(9);
  header.writeUInt8(1, 0);
  header.writeUInt16BE(10033, 1);
  header.writeInt32BE(-1, 3);
  header.writeInt16BE(16, 7);
  return wrap(Buffer.concat([header, utf(command), encodeAmf3(body)]), packetNumber);
}

function stringData(value) {
  const bytes = Buffer.from(value);
  const header = (bytes.length << 1) | 1;
  assert.ok(header < 128, "test helper only supports short strings");
  return Buffer.concat([Buffer.from([header]), bytes]);
}

test("message sequence begins with the game protocol sentinel", () => {
  const sequence = new MessageSequence("session-key");
  assert.equal(sequence.next(0, 123456), 79);
  assert.equal(Number.isInteger(sequence.next(79, 123456)), true);
});

test("XT encoder emits a decodable 10033 transport packet", () => {
  const encoder = new XtPacketEncoder(() => 1_700_000_000_000);
  encoder.initialize("session-key", 123456);
  const packet = encoder.buildXtPacket(16, "16_24_L", { t: 1 });
  const decoded = decodeTransportPacket(packet);
  assert.equal(decoded.type, "xt");
  assert.equal(decoded.messageId, 16);
  assert.equal(decoded.cmd, "16_24_L");
  assert.ok(Buffer.isBuffer(decoded.body.data));
});

test("decoder reads a server-style ranking response", () => {
  const body = { r: 1, zl: [{ ext10: "1|10001|星河|1;2|0|1|九霄|0||280000" }] };
  const decoded = decodeTransportPacket(responsePacket("16_24_L", body));
  assert.equal(decoded.cmd, "16_24_L");
  assert.deepEqual(decoded.body, body);
});

test("decoder accepts the unencrypted socket login map used by the existing client", () => {
  const values = { id: 123456, lastLoginTime: 1700000000, ok: true, note: "ready" };
  const payload = Buffer.concat(Object.entries(values).flatMap(([key, value]) => [stringData(key), encodeAmf3(value)]));
  const packet = Buffer.alloc(8 + payload.length);
  packet.writeUInt32BE(payload.length + 4, 0);
  packet.writeUInt32BE(991, 4);
  payload.copy(packet, 8);
  const decoded = decodeTransportPacket(packet);
  assert.equal(decoded.type, "login");
  assert.deepEqual(decoded.body, values);
});
