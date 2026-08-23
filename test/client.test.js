import test from "node:test";
import assert from "node:assert/strict";
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
