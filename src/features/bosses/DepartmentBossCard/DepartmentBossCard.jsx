import { departmentById } from "../../../model/knowledge-base.js";
import { BossCardVariant } from "../BossCard/BossCardVariant.jsx";
import { CardEditScope } from "../../../components/ui/CardEditing/CardEditing.jsx";

export function DepartmentBossCard({
  boss,
  children,
  targeted = false,
  goalTargets = [],
  prefixDepartment = false,
  locked = false,
}) {
  return (
    <CardEditScope scope={`boss:${boss.id}`}>
      <BossCardVariant
        preset="boss-main"
        boss={boss}
        cardState={locked ? "locked" : targeted ? "target" : undefined}
        openingRequirements={goalTargets}
        {...(prefixDepartment
          ? {
              title: (
                <>
                  {[departmentById[boss.departmentId]?.code, boss.name]
                    .filter(Boolean)
                    .join(" • ")}
                </>
              ),
              titleFields: undefined,
              titleDefaultFields: ["block", "name"],
            }
          : {})}
        showBattleAction={!locked}
        mobileBattleAction
        as="li"
        variant="floor-data"
        className="floor-block-boss-card"
      >
        {children}
      </BossCardVariant>
    </CardEditScope>
  );
}
