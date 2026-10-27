const categoryForTarget = (kind) =>
  kind === "boss" ? "bosses" : kind === "business" ? "businesses" : "work";

export function queueNavigation(card, catalogue = {}) {
  const type = card?.destination;
  if (typeof type !== "string") return null;
  if (type === "floor" || type === "floor.start") {
    const target = card.floorTarget ?? {};
    const destination = target.destination;
    const departments = catalogue.departments ?? [];
    const entityDepartmentId =
      target.kind === "work"
        ? departments.find((item) => item.work?.id === target.entityId)?.id
        : (target.kind === "boss"
            ? catalogue.bosses
            : target.kind === "business"
              ? catalogue.businesses
              : []
          )?.find((item) => item.id === target.entityId)?.departmentId;
    const department =
      departments.find((item) => item.id === entityDepartmentId) ??
      departments.find((item) => item.code === destination);
    const floor = catalogue.floors?.find(
      (item) => item.id === department?.floorId || item.code === destination,
    );
    return {
      screen: "overview",
      floorCode: floor?.code ?? null,
      focus: {
        kind: "floor",
        category: categoryForTarget(target.kind),
        departmentId: department?.id ?? null,
        entityId: target.entityId ?? null,
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
