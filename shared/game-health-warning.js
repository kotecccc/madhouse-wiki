import { safeFailedFeatures } from "./game-health-features.js";

export const HEALTH_WARNING_ATTEMPTS = 3;
export const HEALTH_WARNING_INTERVAL_MS = 15000;
const MAX_ATTEMPT_GAP_MS = 120000;

// Count actual checks of the same failed service, never repeated delivery of
// its cached health metadata or failures in unrelated services.
export function nextHealthWarningEvidence(previous = {}, health) {
  if (health.status !== "unavailable") return {};
  return Object.fromEntries(
    safeFailedFeatures(health.failedFeatures).map((feature) => {
      const before = previous[feature];
      const checkedAt = health.featureCheckedAt?.[feature];
      if (!Number.isFinite(checkedAt) || checkedAt <= 0)
        return [feature, before ?? { attempts: 0 }];
      if (before?.checkedAt != null && checkedAt <= before.checkedAt)
        return [feature, before];
      const gap = checkedAt - (before?.checkedAt ?? -Infinity);
      if (gap < HEALTH_WARNING_INTERVAL_MS) return [feature, before];
      const attempts =
        !before ||
        (gap > MAX_ATTEMPT_GAP_MS && before.attempts < HEALTH_WARNING_ATTEMPTS)
          ? 1
          : Math.min(HEALTH_WARNING_ATTEMPTS, before.attempts + 1);
      return [feature, { attempts, checkedAt }];
    }),
  );
}

export function hasConfirmedHealthWarning(health, evidence) {
  return (
    health.status === "credentials_invalid" ||
    (health.status === "unavailable" &&
      Object.values(evidence).some(
        (item) => item.attempts >= HEALTH_WARNING_ATTEMPTS,
      ))
  );
}
