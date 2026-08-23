import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formElementId, plannedEndLocalValue } from "../public/form-utils.js";

test("form id lookup survives a form control named id", () => {
  const idField = { name: "id", value: "32" };
  const form = {
    id: idField,
    getAttribute: (name) => name === "id" ? "season-form" : null
  };

  assert.notEqual(form.id, "season-form");
  assert.equal(formElementId(form), "season-form");
});

test("planned season end keeps the start weekday and time", () => {
  assert.equal(plannedEndLocalValue("2026-07-03T12:00", "4"), "2026-07-31T12:00");
  assert.equal(plannedEndLocalValue("2026-07-03T12:00", ""), "");
  assert.equal(plannedEndLocalValue("", "4"), "");
});

test("the entrypoint and its nested form module use the same cache version", () => {
  const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const appVersion = /\/app\.js\?v=([^"']+)/.exec(index)?.[1];
  const formModuleVersion = /\.\/form-utils\.js\?v=([^"']+)/.exec(app)?.[1];

  assert.ok(appVersion, "app.js must have a cache version");
  assert.ok(formModuleVersion, "form-utils.js must have a cache version");
  assert.equal(formModuleVersion, appVersion);
});
