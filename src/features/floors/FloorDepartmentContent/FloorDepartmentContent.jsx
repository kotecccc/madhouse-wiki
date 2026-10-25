import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { ProgressionGoalButton } from "./ProgressionGoalButton.jsx";
import { WorkCard } from "../../works/WorkCard/WorkCard.jsx";
import { DepartmentBossCard } from "../../bosses/DepartmentBossCard/DepartmentBossCard.jsx";
import { BusinessCard } from "../../businesses/BusinessCard/BusinessCard.jsx";
import {
  getDepartmentBosses,
  getDepartmentBusinesses,
  getDepartmentUpgrades,
} from "../../../model/knowledge-base.js";
import "./FloorDepartmentContent.css";

/** Produces entity list items directly, without a department disclosure/card. */
export function FloorDepartmentContent({
  department,
  category,
  playerLevel,
  collectionState,
  available,
  targets = [],
  onUpgradeSelect,
}) {
  const locked = available === false;
  const upgrades = getDepartmentUpgrades(department.id);
  const targetProps = (id) => {
    const matches = targets.filter(
      (target) => target.category === category && target.entityId === id,
    );
    return {
      targeted: matches.length > 0,
      ...(["work", "bosses"].includes(category)
        ? { goalTargets: matches }
        : {
            goalAction: matches.length ? (
              <ProgressionGoalButton targets={matches} />
            ) : null,
          }),
    };
  };
  const bosses = getDepartmentBosses(department.id);
  const businesses = getDepartmentBusinesses(department.id);
  if (category === "work") {
    return (
      <WorkCard
        as="li"
        locked={locked}
        work={department.work}
        placeholder={!department.work}
        department={department}
        preset="work-main"
        {...targetProps(department.work?.id)}
      />
    );
  }
  if (category === "bosses" && bosses.length) {
    return bosses.map((boss) => (
      <DepartmentBossCard
        key={boss.id}
        boss={boss}
        playerLevel={playerLevel}
        collectionState={collectionState}
        prefixDepartment
        locked={locked}
        {...targetProps(boss.id)}
      />
    ));
  }
  if (category === "businesses" && businesses.length) {
    return businesses.map((business) => (
      <BusinessCard
        key={business.id}
        business={business}
        department={department}
        locked={locked}
        upgrade={upgrades.find((upgrade) => upgrade.businessId === business.id)}
        onUpgradeSelect={onUpgradeSelect}
        {...targetProps(business.id)}
      />
    ));
  }
  const missing = {
    bosses: "Боссы пока не указаны в справочнике.",
    businesses: "Бизнесы пока не указаны в справочнике.",
  };
  return (
    <BaseCard
      as="li"
      variant="floor-data"
      state={locked ? "locked" : undefined}
      className="floor-entity-placeholder"
    >
      <CardTitle>
        {department.code} · {department.name || "Отделение"}
      </CardTitle>
      <CardDescription>{missing[category]}</CardDescription>
    </BaseCard>
  );
}
