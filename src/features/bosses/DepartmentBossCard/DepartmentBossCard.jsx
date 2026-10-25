import { BossCollectionStatus } from "../collection/BossCollectionStatus.jsx";
import { Pill } from "../../../components/ui/Pill/Pill.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { bossLevelStatus } from "./boss-level-status.js";
import "./DepartmentBossCard.css";
import { departmentById } from "../../../model/knowledge-base.js";
import { BossCardVariant } from "../BossCard/BossCardVariant.jsx";
import { CardEditScope } from "../../../components/ui/CardEditing/CardEditing.jsx";

export function DepartmentBossCard({
  boss,
  playerLevel,
  collectionState,
  children,
  targeted = false,
  goalTargets = [],
  prefixDepartment = false,
  locked = false,
}) {
  const levelStatus = bossLevelStatus(boss, playerLevel);
  return (
    <CardEditScope scope={`boss:${boss.id}`}>
      <BossCardVariant
        preset="boss-main"
        boss={boss}
        cardState={locked ? "locked" : targeted ? "target" : undefined}
        openingRequirements={goalTargets}
        currencyRewardUnavailable={levelStatus?.kind === "overlevel"}
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
        mobileBattleStatus
        collectionIndicator={
          collectionState && collectionState.status !== "idle" ? (
            <BossCollectionStatus boss={boss} state={collectionState} />
          ) : null
        }
        as="li"
        variant="floor-data"
        className="floor-block-boss-card"
      >
        {levelStatus && (
          <div className="boss-level-status">
            <Pill
              variant={levelStatus.kind === "underlevel" ? "locked" : "warning"}
              size="xs"
              dot={false}
            >
              {levelStatus.kind === "underlevel"
                ? `Нужен ${levelStatus.level} уровень`
                : "Переросли"}
            </Pill>
            {levelStatus.kind === "overlevel" && (
              <CardDescription
                size="2xs"
                title={`Ваш уровень ${playerLevel} выше указанного предела награды: ${levelStatus.level}. Предметные трофеи показаны отдельно.`}
              >
                Предел награды: {levelStatus.level} ур. · ваш: {playerLevel}
              </CardDescription>
            )}
          </div>
        )}
        {children}
      </BossCardVariant>
    </CardEditScope>
  );
}
