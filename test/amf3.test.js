import test from "node:test";
import assert from "node:assert/strict";
import { decodeAmf3, encodeAmf3 } from "../src/protocol/amf3.js";

test("AMF3 round-trips the values used by XT requests", () => {
  const input = {
    text: "经典竞技场",
    integer: -321,
    large: 987654321,
    enabled: true,
    missing: null,
    list: [1, "two", false],
    bytes: Buffer.from([0, 1, 127, 255]),
    nested: { rank: 5 }
  };
  const encoded = encodeAmf3(input);
  const { value, offset } = decodeAmf3(encoded);
  assert.equal(offset, encoded.length);
  assert.equal(value.text, input.text);
  assert.equal(value.integer, input.integer);
  assert.equal(value.large, input.large);
  assert.deepEqual(value.list, input.list);
  assert.deepEqual(value.bytes, input.bytes);
  assert.deepEqual(value.nested, input.nested);
});

test("AMF3 preserves 29-bit integer boundaries", () => {
  for (const value of [-0x10000000, -1, 0, 0x0fffffff]) {
    assert.equal(decodeAmf3(encodeAmf3(value)).value, value);
  }
});
