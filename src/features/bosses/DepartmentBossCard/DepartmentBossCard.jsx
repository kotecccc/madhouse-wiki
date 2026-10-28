import { remainingBossWins } from "./boss-target-status.js";
import { useSyncExternalStore } from "react";
import { bossBattle } from "../BossBattle/boss-battle-session.js";
import { activeBattleForBoss } from "../BossCard/boss-card-battle-status.js";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
import { BossCollectionStatus } from "../collection/BossCollectionStatus.jsx";
import { Pill } from "../../../components/ui/Pill/Pill.jsx";
import { bossLevelStatus } from "./boss-level-status.js";
import "./DepartmentBossCard.css";
import { departmentById } from "../../../model/knowledge-base.js";
import { BossCardVariant } from "../BossCard/BossCardVariant.jsx";
import { CardEditScope } from "../../../components/ui/CardEditing/CardEditing.jsx";
import { LockIndicator } from "../../floors/LockIndicator/LockIndicator.jsx";

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
  const remainingWins = remainingBossWins(goalTargets);
  const battleState = useSyncExternalStore(
    bossBattle.subscribe,
    bossBattle.getSnapshot,
    bossBattle.getSnapshot,
  );
  const inBattle = Boolean(
    activeBattleForBoss(battleState, Number(boss.numericId ?? boss.apiId)),
  );
  return (
    <CardEditScope scope={`boss:${boss.id}`}>
      <BossCardVariant
        preset="boss-main"
        boss={boss}
        cardState={locked ? "locked" : targeted ? "target" : undefined}
        motionBorder={inBattle ? 3 : undefined}
        motionColor={inBattle ? "blue" : undefined}
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
        mobileBattleStatus={!locked}
        collectionIndicator={
          locked ? (
            <LockIndicator variant="locked" label="Босс недоступен" />
          ) : (
            <>
              {targeted && remainingWins > 0 && (
                <Pill
                  variant="warning"
                  size="xs"
                  dot={false}
                  title={`Осталось побед для задания: ${remainingWins}`}
                  aria-label={`Осталось побед для задания: ${remainingWins}`}
                >
                  <Icon type="combat" size="medium" />
                  {remainingWins}
                </Pill>
              )}
              {collectionState && collectionState.status !== "idle" && (
                <BossCollectionStatus boss={boss} state={collectionState} />
              )}
            </>
          )
        }
        as="li"
        variant="floor-data"
        className="floor-block-boss-card"
      >
        {levelStatus?.kind === "underlevel" && (
          <div className="boss-level-status">
            <Pill variant="locked" size="xs" dot={false}>
              Нужен {levelStatus.level} уровень
            </Pill>
          </div>
        )}
        {children}
      </BossCardVariant>
    </CardEditScope>
  );
}
