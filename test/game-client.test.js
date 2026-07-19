import test from "node:test";
import assert from "node:assert/strict";
import { isXtSuccess } from "../src/protocol/game-client.js";

test("XT success follows the game's r=1 convention", () => {
  assert.equal(isXtSuccess({ r: 1 }), true);
  assert.equal(isXtSuccess({ r: 0 }), true);
  assert.equal(isXtSuccess({ zl: [] }), true);
  assert.equal(isXtSuccess({ r: 1001 }), false);
  assert.equal(isXtSuccess({ r: 2000 }), false);
});
