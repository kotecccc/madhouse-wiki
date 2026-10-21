const STATUS_MARKERS = [
  ["✅", "completed"],
  ["▶️", "active"],
  ["▶", "active"],
];

export const RAID_STATUS_INFO = {
  scheduled: { label: "Запланирован", color: "scheduled" },
  active: { label: "Идёт", color: "active" },
  completed: { label: "Завершён", color: "completed" },
  unknown: { label: "Не распознан", color: "unknown" },
};

export function getRaidStatus(raid) {
  const zone = String(raid?.zone || "").trimStart();
  const marker = STATUS_MARKERS.find(([value]) => zone.startsWith(value))?.[0];
  if (marker) return STATUS_MARKERS.find(([value]) => value === marker)[1];
  if (/^\p{Extended_Pictographic}/u.test(zone)) return "unknown";
  return "scheduled";
}

export function getRaidDisplayZone(raid) {
  const zone = String(raid?.zone || "").trim();
  const marker = STATUS_MARKERS.find(([value]) => zone.startsWith(value))?.[0];
  return marker ? zone.slice(marker.length).trim() : zone;
}

export function raidTimeMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  if (!match) return Number.POSITIVE_INFINITY;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return Number.POSITIVE_INFINITY;
  return hours * 60 + minutes;
}

export function sortRaidsByTime(raids) {
  return [...(Array.isArray(raids) ? raids : [])].sort((left, right) => {
    const timeOrder = raidTimeMinutes(left?.time) - raidTimeMinutes(right?.time);
    return timeOrder || String(left?.time || "").localeCompare(String(right?.time || ""));
  });
}
