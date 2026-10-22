import { fmt } from "../../../lib/format.js";

function numericValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function formatRequirementAmount(requirement = {}) {
  const { type } = requirement;
  const value = numericValue(
    type === "business_level"
      ? (requirement.requiredLevel ?? requirement.required)
      : requirement.required,
  );
  if (value == null) return null;
  if (
    type === "business_level" ||
    type === "player_level" ||
    type === "dice_level"
  )
    return `${fmt(value)} ур.`;
  if (["work_completions", "boss_kills"].includes(type))
    return `×${fmt(value)}`;
  if (["combat_rating", "rage_total"].includes(type)) return fmt(value);
  return null;
}

export function readOpeningConditionProgress(progress) {
  const current = numericValue(progress?.current);
  const total = numericValue(progress?.total);
  return current != null && current >= 0 && total != null && total >= 0
    ? { current, total }
    : null;
}
