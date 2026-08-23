import test from "node:test";
import assert from "node:assert/strict";
import { formElementId } from "../public/form-utils.js";

test("form id lookup survives a form control named id", () => {
  const idField = { name: "id", value: "32" };
  const form = {
    id: idField,
    getAttribute: (name) => name === "id" ? "season-form" : null
  };

  assert.notEqual(form.id, "season-form");
  assert.equal(formElementId(form), "season-form");
});
