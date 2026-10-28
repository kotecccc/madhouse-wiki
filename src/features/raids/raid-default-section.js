// Do not infer an empty personal list until both server views have loaded.
export function defaultRaidSection({
  authenticated,
  raidsLoaded,
  invitationsLoaded,
  raidCount,
  invitationCount,
}) {
  if (!authenticated) return "announcements";
  if (!raidsLoaded || !invitationsLoaded) return null;
  if (raidCount > 0) return "raids";
  if (invitationCount > 0) return "invitations";
  return "announcements";
}
