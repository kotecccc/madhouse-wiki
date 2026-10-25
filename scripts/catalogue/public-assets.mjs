// Asset routing contract recovered from the public Madhouse client bundle.
// This is routing metadata only; it does not define catalogue entities.
export const PUBLIC_ASSETS_CDN = "https://cdn.cargohustle.online";

export function bossPreviewUrl(apiId) {
  const id = positiveId(apiId);
  return id ? `${PUBLIC_ASSETS_CDN}/V3/floor/bosses/prew/P${id}.webp` : null;
}

export function itemImageUrl(itemId) {
  const id = positiveId(itemId);
  return id ? `${PUBLIC_ASSETS_CDN}/V3/items/${id}.webp` : null;
}

// The same type/level asset route used by canonical catalogue projections.
export function mutagenImageUrl(type, level) {
  const family = typeof type === "string" ? type.toUpperCase() : "";
  const id = ["number", "string"].includes(typeof level)
    ? positiveId(level)
    : null;
  return /^[IAXFSZW]$/.test(family) && id
    ? `${PUBLIC_ASSETS_CDN}/V3/mutogen/${family}/${id}.webp`
    : null;
}

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
