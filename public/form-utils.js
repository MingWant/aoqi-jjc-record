export function formElementId(form) {
  // A control named "id" shadows HTMLFormElement.id, so read the attribute directly.
  return form?.getAttribute?.("id") || "";
}

export function plannedEndLocalValue(startsAt, weeks) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(startsAt ?? ""));
  const count = Number(weeks);
  if (!match || !Number.isInteger(count) || count < 1 || count > 5200) return "";

  const [, year, month, day, hour, minute] = match.map(Number);
  const start = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (start.getUTCFullYear() !== year
    || start.getUTCMonth() !== month - 1
    || start.getUTCDate() !== day
    || start.getUTCHours() !== hour
    || start.getUTCMinutes() !== minute) return "";

  const end = new Date(start.getTime() + count * 7 * 24 * 60 * 60 * 1000);
  return `${end.getUTCFullYear()}-${String(end.getUTCMonth() + 1).padStart(2, "0")}-${String(end.getUTCDate()).padStart(2, "0")}T${String(end.getUTCHours()).padStart(2, "0")}:${String(end.getUTCMinutes()).padStart(2, "0")}`;
}
