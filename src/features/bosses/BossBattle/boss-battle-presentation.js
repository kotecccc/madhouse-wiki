export function formatBattleCountdown(expiresAt, now) {
  if (!Number.isFinite(expiresAt) || !Number.isFinite(now)) return null;
  const total = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const clock = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return hours ? `${hours}:${clock}` : clock;
}

const eventFields = [
  "localKey",
  "confirmed",
  "turn",
  "at",
  "actor",
  "damage",
  "critical",
  "itemType",
  "healthRestored",
];
export function sameBattleEvent(left, right) {
  return (
    left === right ||
    Boolean(
      left && right && eventFields.every((key) => left[key] === right[key]),
    )
  );
}
export function sameBattleEvents(left, right) {
  return (
    left === right ||
    (left.length === right.length &&
      left.every((event, index) => sameBattleEvent(event, right[index])))
  );
}
