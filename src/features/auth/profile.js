// Identity stays in page memory. The fallback route matches the game client's
// awl/awk avatar loader, keyed by the player ID returned from /api/me.
export function profileAvatarUrl(profile) {
  for (const value of [profile.avatarUrl, profile.photoUrl]) {
    if (typeof value !== "string" || !value.trim()) continue;
    try {
      const url = new URL(value.trim());
      if (url.protocol === "https:") return url.href;
    } catch {
      /* Ignore an unavailable or invalid photo URL. */
    }
  }
  const id = String(profile.playerId ?? "");
  return /^[1-9]\d*$/.test(id)
    ? `https://cdn.cargohustle.online/avatarPlayers/${id}.webp`
    : null;
}
