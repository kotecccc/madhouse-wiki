const SOURCE_STATUS_MARKERS = ["✅", "▶️", "▶"];
export const RAID_STATUS_INFO = {
  scheduled: { label: "Запланирован", color: "scheduled" },
  active: { label: "Идёт", color: "active" },
  completed: { label: "Завершён", color: "completed" },
  unknown: { label: "Статус не указан", color: "unknown" },
};

export function getRaidStatusMarker(raid) {
  const zone = String(raid?.zone || "").trimStart();
  return (
    SOURCE_STATUS_MARKERS.find((marker) => zone.startsWith(marker)) || null
  );
}

export function hasUnknownRaidStatusMarker(raid) {
  const zone = String(raid?.zone || "").trimStart();
  return !getRaidStatusMarker(raid) && /^\p{Extended_Pictographic}/u.test(zone);
}

export function getRaidStatus(raid) {
  const marker = getRaidStatusMarker(raid);
  if (marker === "✅") return "completed";
  if (marker === "▶️" || marker === "▶") return "active";

  const zone = String(raid?.zone || "").trimStart();
  if (/^\p{Extended_Pictographic}/u.test(zone)) return "unknown";
  return "scheduled";
}

export function getRaidDisplayZone(raid) {
  const zone = String(raid?.zone || "").trim();
  const marker = getRaidStatusMarker({ zone });
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
    const timeOrder =
      raidTimeMinutes(left?.time) - raidTimeMinutes(right?.time);
    return (
      timeOrder ||
      String(left?.time || "").localeCompare(String(right?.time || ""))
    );
  });
}
