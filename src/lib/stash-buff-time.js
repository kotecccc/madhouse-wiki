export function effectTimeLeft(expiresAtMs, now) {
  const remaining = Math.max(0, Math.ceil((expiresAtMs - now) / 1000));
  if (!remaining) return "Срок истёк · ожидается обновление данных";
  const hours = String(Math.floor(remaining / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((remaining % 3600) / 60)).padStart(2, "0");
  const seconds = String(remaining % 60).padStart(2, "0");
  return `Осталось ${hours}:${minutes}:${seconds}`;
}
