export const AUTOMATION_STATE_SCHEMA_VERSION = 1;

export function migrateAutomationState(value) {
  if (value == null) return { value: null, changed: false };
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("automation_state_corrupt");

  const schemaVersion = value.schemaVersion ?? 0;
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 0)
    throw new Error("automation_state_version_invalid");
  if (schemaVersion > AUTOMATION_STATE_SCHEMA_VERSION)
    throw new Error("automation_state_version_unsupported");

  if (schemaVersion === AUTOMATION_STATE_SCHEMA_VERSION)
    return { value, changed: false };

  // Version 0 is the pre-marker record shape. Keep its authoritative
  // checkpoints intact; createActor supplies defaults for fields added later.
  return {
    value: { ...value, schemaVersion: AUTOMATION_STATE_SCHEMA_VERSION },
    changed: true,
  };
}
