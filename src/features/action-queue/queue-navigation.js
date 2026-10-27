const categoryForTarget = (kind) =>
  kind === "boss" ? "bosses" : kind === "business" ? "businesses" : "work";

export function queueNavigation(card, catalogue = {}) {
  const type = card?.destination;
  if (typeof type !== "string") return null;
  if (type === "floor" || type === "floor.start") {
    const department = catalogue.departments?.find(
      (item) => item.code === card.floorTarget?.destination,
    );
    const floor = catalogue.floors?.find(
      (item) => item.id === department?.floorId,
    );
    return {
      screen: "overview",
      floorCode: floor?.code ?? null,
      focus: {
        kind: "floor",
        category: categoryForTarget(card.floorTarget?.kind),
        departmentId: department?.id ?? null,
      },
    };
  }
  if (type.startsWith("subscription") || type === "friend.request")
    return {
      screen: "raids",
      focus: { kind: "raid", target: card.raidTarget ?? null },
    };
  if (type === "buddy") return { screen: "friends", focus: { kind: "buddy" } };
  if (type.startsWith("friend."))
    return {
      screen: "friends",
      focus: { kind: "friend", playerId: card.friendTarget?.playerId ?? null },
    };
  return null;
}
