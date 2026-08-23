export function formElementId(form) {
  // A control named "id" shadows HTMLFormElement.id, so read the attribute directly.
  return form?.getAttribute?.("id") || "";
}
