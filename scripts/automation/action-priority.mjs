// Only server-owned command types and validated action fields determine urgency.
export function actionPriority(type, action = {}) {
  if (["battle.attack", "battle.start", "battle.heal"].includes(type))
    return 50;
  if (
    type === "inventory" &&
    ["weapon", "pet"].includes(action?.type) &&
    ["equip", "unequip"].includes(action?.action)
  )
    return 50;
  if (type === "invitation.accept") return 45;
  if (
    [
      "business.start",
      "auto.start",
      "raid.start",
      "floor.start",
      "subscription.start",
    ].includes(type)
  )
    return 15;
  return 30;
}
