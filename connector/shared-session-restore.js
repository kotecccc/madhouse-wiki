function levelProgressFields(value) {
  return {
    ...(Number.isSafeInteger(value?.playerLevel) && value.playerLevel > 0
      ? { playerLevel: value.playerLevel }
      : {}),
    ...(Number.isSafeInteger(value?.currentExp) &&
    value.currentExp >= 0 &&
    Number.isSafeInteger(value?.expToNextLevel) &&
    value.expToNextLevel > 0
      ? {
          currentExp: value.currentExp,
          expToNextLevel: value.expToNextLevel,
        }
      : {}),
  };
}

export function sharedSessionRestoreReply(shared) {
  if (
    shared?.status === "login-required" &&
    shared.gameConnection === "login-required" &&
    typeof shared.wikiSession === "string" &&
    shared.wikiSession.length > 0 &&
    Number.isFinite(shared.wikiSessionExpiresAt)
  )
    return {
      status: "wiki-connected",
      wikiSession: shared.wikiSession,
      wikiSessionExpiresAt: shared.wikiSessionExpiresAt,
      gameConnection: "login-required",
    };

  if (shared?.status !== "connected" || typeof shared.accessToken !== "string")
    return null;
  return {
    status: "connected",
    accessToken: shared.accessToken,
    gameConnection: shared.gameConnection || "connected",
    ...(typeof shared.wikiSession === "string"
      ? { wikiSession: shared.wikiSession }
      : {}),
    ...(Number.isFinite(shared.wikiSessionExpiresAt)
      ? { wikiSessionExpiresAt: shared.wikiSessionExpiresAt }
      : {}),
    ...levelProgressFields(shared),
    ...(shared.activeBossBattle
      ? { activeBossBattle: shared.activeBossBattle }
      : {}),
  };
}

export function isWikiReadOnlyRestore(request, restoredReply) {
  return (
    restoredReply?.status === "wiki-connected" && !request?.data?.interactive
  );
}
