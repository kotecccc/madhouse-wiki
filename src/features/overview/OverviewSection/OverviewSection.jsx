import { useEffect, useState } from "react";
import { knowledgeBase } from "virtual:madhouse-catalogue";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
import { LockIndicator } from "../../floors/LockIndicator/LockIndicator.jsx";
import { Pill } from "../../../components/ui/Pill/Pill.jsx";
import { ProgressBar } from "../../../components/ui/ProgressBar/ProgressBar.jsx";
import { ImageCard } from "../../../components/ui/ImageCard/ImageCard.jsx";
import { LoadingStatus } from "../../../components/ui/LoadingStatus/LoadingStatus.jsx";
import { BossCardVariant } from "../../bosses/BossCard/BossCardVariant.jsx";
import { BusinessItemTile } from "../../businesses/BusinessItemTile/BusinessItemTile.jsx";
import { BusinessItemDropList } from "../../businesses/BusinessItemDropList/BusinessItemDropList.jsx";
import {
  getBusinessUpgradeTotals,
  findItemBosses,
} from "../../../lib/business-upgrades.js";
import { calculateRequirementEnergy } from "../../../lib/energy.js";
import {
  getRaidStatus,
  RAID_STATUS_INFO,
  sortRaidsByTime,
} from "../../../lib/raid-schedule.js";
import { bossDisplayFields } from "../../../lib/card-display-fields.js";
import { NextLevelSection } from "../NextLevelSection/NextLevelSection.jsx";
import {
  businessById,
  bossById,
  departmentById,
  getBusinessUpgrade,
  orderedFloors,
} from "../../../model/knowledge-base.js";
import { fmt, fmtEnergy, restoreTime } from "../../../lib/format.js";
import "./OverviewSection.css";

const numberFormat = new Intl.NumberFormat("ru-RU");
const fallbackEnergyRegenSeconds = 120;

function energyAtTime(energy, now) {
  if (
    !Number.isFinite(energy?.current) ||
    !Number.isFinite(energy?.max) ||
    energy.max <= 0
  )
    return null;

  const current = Math.min(energy.max, Math.max(0, energy.current));
  if (current >= energy.max) return { current, secondsToNext: null };

  const intervalSeconds =
    Number.isSafeInteger(energy.regenIntervalSeconds) &&
    energy.regenIntervalSeconds > 0
      ? energy.regenIntervalSeconds
      : fallbackEnergyRegenSeconds;
  const intervalMs = intervalSeconds * 1000;
  const apiNextAt = Date.parse(energy.nextEnergyAtUtc);
  const firstRegenAt = Number.isFinite(apiNextAt)
    ? apiNextAt
    : (energy.snapshotAtMs ?? now) +
      Math.max(
        0,
        Number.isFinite(energy.secondsToNext)
          ? energy.secondsToNext
          : intervalSeconds,
      ) *
        1000;
  const completedTicks =
    now >= firstRegenAt ? Math.floor((now - firstRegenAt) / intervalMs) + 1 : 0;
  const nextRegenAt = firstRegenAt + completedTicks * intervalMs;
  return {
    current: Math.min(energy.max, current + completedTicks),
    secondsToNext: Math.max(0, Math.ceil((nextRegenAt - now) / 1000)),
  };
}

function requirementState(requirement) {
  if (typeof requirement?.met === "boolean")
    return requirement.met ? "complete" : "incomplete";
  if (
    Number.isFinite(requirement?.current) &&
    Number.isFinite(requirement?.required)
  )
    return requirement.current >= requirement.required
      ? "complete"
      : "incomplete";
  return "unknown";
}

function requirementLabel(requirement) {
  if (typeof requirement?.label === "string" && requirement.label.trim())
    return requirement.label;
  const boss = findBoss(requirement?.bossId ?? requirement?.targetBossId);
  if (requirement?.type === "boss_kills" && boss)
    return `Победить босса «${boss.name}»`;
  return "Условие открытия";
}

function findBoss(id) {
  if (id == null) return null;
  return (
    knowledgeBase.bosses.find(
      (boss) =>
        String(boss.id) === String(id) ||
        String(boss.apiId) === String(id) ||
        String(boss.numericId) === String(id),
    ) || null
  );
}

function displayRequirements(apiRequirements, catalogueRequirements) {
  const catalogue = Array.isArray(catalogueRequirements)
    ? catalogueRequirements
    : [];
  if (!Array.isArray(apiRequirements) || !apiRequirements.length)
    return catalogue;

  return apiRequirements.map((requirement, index) => {
    const reference =
      requirement.businessId ??
      requirement.bossId ??
      requirement.workId ??
      requirement.medallionId;
    const match =
      catalogue.find((candidate) => {
        if (candidate.type !== requirement.type) return false;
        const candidateReference =
          candidate.businessId ??
          candidate.bossId ??
          candidate.workId ??
          candidate.medallionId;
        return (
          reference != null &&
          candidateReference != null &&
          String(reference).replace(/^.*:/, "") ===
            String(candidateReference).replace(/^.*:/, "")
        );
      }) ||
      catalogue.find((candidate) => candidate.type === requirement.type) ||
      catalogue[index];
    const merged = { ...match, ...requirement };
    const business = findBusiness(merged.targetBusinessId ?? merged.businessId);
    const boss = findBoss(merged.targetBossId ?? merged.bossId);
    const work = findWork(merged.targetDepartmentId ?? merged.workId);

    return {
      ...merged,
      openingConditionLabel: match?.label ?? requirement.label ?? "",
      targetBusinessId: merged.targetBusinessId ?? business?.id ?? null,
      targetBossId: merged.targetBossId ?? boss?.id ?? null,
      targetDepartmentId:
        merged.targetDepartmentId ?? work?.departmentId ?? null,
      targetStashSetId: merged.targetStashSetId ?? merged.medallionId ?? null,
    };
  });
}

function findBusiness(id) {
  if (id == null) return null;
  const reference = String(id).replace(/^business:/, "");
  return (
    businessById[id] ||
    knowledgeBase.businesses.find(
      (business) =>
        String(business.apiId ?? "") === reference ||
        String(business.id).replace(/^business:/, "") === reference,
    ) ||
    null
  );
}

function findWork(id) {
  if (id == null) return null;
  const reference = String(id).replace(/^work:/, "");
  return (
    knowledgeBase.works.find(
      (work) =>
        String(work.id) === String(id) ||
        String(work.apiId ?? work.workId ?? "") === reference,
    ) || null
  );
}

function requirementCurrentBusinessLevel(
  requirement,
  business,
  businessLevels,
) {
  if (Number.isSafeInteger(requirement.current)) return requirement.current;
  const apiId = String(business?.apiId ?? business?.id ?? "").replace(
    /^business:/,
    "",
  );
  return (
    businessLevels?.find((entry) => String(entry.id) === apiId)?.level ?? null
  );
}

function GoalBusinessBoss({ boss, items }) {
  const department = departmentById[boss.departmentId];
  return (
    <BossCardVariant
      as="li"
      boss={boss}
      preset="boss-business"
      variant="floor-data"
      displayFields={bossDisplayFields(boss, department || {})}
      showDropList={false}
      action={<BusinessItemDropList items={items} bossName={boss.name} />}
    />
  );
}

function BusinessGoalDetails({ requirement, businessLevels }) {
  const business = findBusiness(
    requirement.targetBusinessId ?? requirement.businessId,
  );
  const targetLevel = requirement.requiredLevel ?? requirement.required;
  const currentLevel = requirementCurrentBusinessLevel(
    requirement,
    business,
    businessLevels,
  );
  const upgrade = business ? getBusinessUpgrade(business.id) : null;
  const itemTotals =
    Number.isSafeInteger(targetLevel) &&
    targetLevel > 0 &&
    Number.isSafeInteger(currentLevel)
      ? getBusinessUpgradeTotals(upgrade, targetLevel, currentLevel).filter(
          (item) => item.requiredAmount == null || item.requiredAmount > 0,
        )
      : [];
  const groups = new Map();
  const unassigned = [];
  for (const item of itemTotals) {
    const matches = findItemBosses(Object.values(bossById), item.entityId);
    if (!matches.length) {
      unassigned.push(item);
      continue;
    }
    for (const boss of matches) {
      const group = groups.get(boss.id) ?? { boss, items: [] };
      group.items.push(item);
      groups.set(boss.id, group);
    }
  }
  const bossGroups = [...groups.values()];
  const openingCondition =
    requirement.openingConditionLabel ||
    requirement.label ||
    requirementLabel(requirement);

  return (
    <>
      {!!bossGroups.length && (
        <details className="floor-work-disclosure overview-goal-boss-disclosure">
          <summary className="floor-work-summary floor-opening-summary overview-goal-boss-summary">
            <CardDescription as="span">
              {requirement.conditionNumber}. {openingCondition}
            </CardDescription>
            <Pill
              variant="warning"
              dot={false}
              className="overview-goal-business-status"
              aria-label={
                Number.isSafeInteger(currentLevel)
                  ? `Уровень ${fmt(currentLevel)} из ${fmt(targetLevel)}`
                  : `Требуется уровень ${fmt(targetLevel)}`
              }
            >
              {Number.isSafeInteger(currentLevel) ? fmt(currentLevel) : "—"} из{" "}
              {Number.isFinite(targetLevel) ? fmt(targetLevel) : "—"}
            </Pill>
          </summary>
          <div className="floor-work-expanded floor-opening-expanded">
            <ul className="overview-goal-boss-list">
              {bossGroups.map(({ boss, items }) => (
                <GoalBusinessBoss key={boss.id} boss={boss} items={items} />
              ))}
            </ul>
          </div>
        </details>
      )}
      {!!unassigned.length && (
        <ul className="overview-goal-unassigned-items">
          {unassigned.map((item) => (
            <li key={item.entityId}>
              <BusinessItemTile
                itemId={item.entityId}
                name={item.name}
                size={36}
                imageSize={32}
              />
              <span>{item.name}</span>
              <strong>
                ×{item.requiredAmount == null ? "—" : fmt(item.requiredAmount)}
              </strong>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function EnergyGoalDetails({ requirement, profile }) {
  const work = findWork(requirement.targetDepartmentId ?? requirement.workId);
  const workDepartment = work ? departmentById[work.departmentId] : null;
  const cycleEnergy = workDepartment?.energyCycle?.full;
  const count = requirement.required;
  const total =
    Number.isFinite(cycleEnergy) && Number.isSafeInteger(count)
      ? cycleEnergy * count
      : null;
  const plan =
    total != null &&
    Number.isFinite(profile?.energy?.max) &&
    Number.isFinite(profile?.energy?.current)
      ? calculateRequirementEnergy(
          total,
          profile.energy.max,
          profile.energy.current,
        )
      : null;

  return (
    <div className="overview-goal-energy">
      <strong>
        {total == null ? (
          "Энергия не указана"
        ) : (
          <>
            {fmtEnergy(total)} <Icon type="energy" size="small" />
          </>
        )}
      </strong>
      {plan && (
        <CardDescription>
          {plan.remaining > 0
            ? `Ждать ${restoreTime(plan.minutes)} • малые ×${fmt(plan.smallRefills)} • большие ×${fmt(plan.largeRefills)} • ${fmt(plan.banknotes)} купюр`
            : "Текущей энергии хватит"}
        </CardDescription>
      )}
    </div>
  );
}

function GoalRequirement({
  requirement,
  businessLevels,
  profile,
  conditionNumber,
}) {
  const boss = findBoss(requirement.targetBossId ?? requirement.bossId);
  const business = findBusiness(
    requirement.targetBusinessId ?? requirement.businessId,
  );
  const label = business?.title || requirementLabel(requirement);
  return (
    <li
      className={`overview-goal-requirement overview-goal-requirement--${requirement.type}`}
    >
      <div className="overview-goal-requirement-copy">
        {requirement.type !== "business_level" && (
          <CardTitle>{label}</CardTitle>
        )}
        {requirement.type === "business_level" ? (
          <BusinessGoalDetails
            requirement={{ ...requirement, conditionNumber }}
            businessLevels={businessLevels}
          />
        ) : requirement.type === "work_completions" ? (
          <EnergyGoalDetails requirement={requirement} profile={profile} />
        ) : requirement.type === "boss_kills" && boss ? (
          <CardDescription>
            Победить {fmt(requirement.required || 1)} раз
          </CardDescription>
        ) : Number.isFinite(requirement.current) &&
          Number.isFinite(requirement.required) ? (
          <CardDescription>
            {fmt(requirement.current)} / {fmt(requirement.required)}
          </CardDescription>
        ) : null}
      </div>
      {requirement.type === "boss_kills" && boss && (
        <ImageCard
          src={boss.image}
          alt={boss.name}
          size={56}
          imageSize="100%"
        />
      )}
    </li>
  );
}

function GoalRequirements({ requirements, businessLevels, profile }) {
  if (!requirements.length) return null;
  return (
    <ul className="overview-goal-requirements">
      {requirements.map((requirement, index) => (
        <GoalRequirement
          key={`${requirement.type}-${requirement.label}-${index}`}
          requirement={requirement}
          businessLevels={businessLevels}
          profile={profile}
          conditionNumber={index + 1}
        />
      ))}
    </ul>
  );
}

function getNextFloor(availability) {
  return (
    orderedFloors.find((floor) => availability[floor.code] === false) || null
  );
}

function normalizeName(value) {
  return String(value || "")
    .normalize("NFC")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function bossRequirementName(requirement) {
  const boss = findBoss(requirement.bossId ?? requirement.targetBossId);
  if (boss?.name) return boss.name;
  if (requirement?.type !== "boss_kills" || !requirement?.label) return "";
  const label = normalizeName(requirement.label);
  return (
    knowledgeBase.bosses.find((candidate) =>
      label.includes(normalizeName(candidate.name)),
    )?.name || ""
  );
}

function PlayerAvatar({ profile }) {
  const [imageAvailable, setImageAvailable] = useState(
    Boolean(profile.avatarUrl),
  );
  useEffect(
    () => setImageAvailable(Boolean(profile.avatarUrl)),
    [profile.avatarUrl],
  );
  if (imageAvailable)
    return (
      <img
        className="overview-avatar"
        src={profile.avatarUrl}
        alt=""
        onError={() => setImageAvailable(false)}
      />
    );
  return (
    <span
      className="overview-avatar overview-avatar-fallback"
      aria-hidden="true"
    >
      {(profile.name || "И").slice(0, 1).toLocaleUpperCase("ru-RU")}
    </span>
  );
}

function ProfileSummary({ state }) {
  const [now, setNow] = useState(() => Date.now());
  const profile = state.profile;
  const energy = profile?.energy;
  const energyKnown =
    Number.isFinite(energy?.current) &&
    Number.isFinite(energy?.max) &&
    energy.max > 0;
  const displayedEnergy = energyKnown ? energyAtTime(energy, now) : null;
  const shouldTickEnergy =
    !!displayedEnergy && displayedEnergy.current < energy.max;
  useEffect(() => {
    if (!energyKnown || !shouldTickEnergy) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [energyKnown, shouldTickEnergy]);
  if (state.status === "loading" || state.status === "idle")
    return <LoadingStatus>Загружаем персонажа…</LoadingStatus>;
  if (state.status === "error")
    return (
      <p className="overview-empty" role="status">
        {state.message}
      </p>
    );
  const nextEnergy = !displayedEnergy
    ? ""
    : displayedEnergy.current >= energy.max
      ? "Энергия восполнена"
      : `+1 через ${Math.floor(displayedEnergy.secondsToNext / 60)} мин ${displayedEnergy.secondsToNext % 60} сек`;
  const experienceKnown =
    Number.isSafeInteger(profile.experience?.current) &&
    profile.experience.current >= 0 &&
    Number.isSafeInteger(profile.experience?.toNextLevel) &&
    profile.experience.toNextLevel > 0;
  return (
    <BaseCard
      as="article"
      variant="floor-data"
      className="overview-card overview-player-card"
    >
      <div className="overview-player-heading">
        <div className="overview-player-summary">
          <PlayerAvatar profile={profile} />
          <div className="overview-player-identity">
            <CardTitle as="h2">{profile.name}</CardTitle>
            <CardDescription>
              {profile.username ? `@${profile.username}` : "Персонаж игрока"}
            </CardDescription>
            {experienceKnown && Number.isSafeInteger(profile.playerLevel) && (
              <div
                className="overview-level-progress"
                role="group"
                aria-label={`Прогресс уровня ${fmt(profile.playerLevel)}`}
              >
                <div className="overview-level-heading">
                  <span className="overview-level-label">
                    Уровень {fmt(profile.playerLevel)}
                  </span>
                  <CardTitle as="span" size="sm" aria-hidden="true">
                    {numberFormat.format(profile.experience.current)} /{" "}
                    {numberFormat.format(profile.experience.toNextLevel)}
                  </CardTitle>
                </div>
                <ProgressBar
                  value={profile.experience.current}
                  max={profile.experience.toNextLevel}
                  size="sm"
                  label={`Прогресс уровня ${fmt(profile.playerLevel)}`}
                  valueText={`${fmt(profile.experience.current)} из ${fmt(profile.experience.toNextLevel)} опыта`}
                />
              </div>
            )}
          </div>
        </div>
        <div className="overview-energy" role="group" aria-label="Энергия">
          <div className="overview-energy-heading">
            <span className="overview-energy-label">
              <Icon
                type="energy"
                size="small"
                className="overview-energy-icon"
              />
              Энергия
            </span>
            <CardTitle as="span" size="sm" aria-hidden="true">
              {displayedEnergy
                ? `${numberFormat.format(displayedEnergy.current)} / ${numberFormat.format(energy.max)}`
                : "Нет данных"}
            </CardTitle>
          </div>
          <ProgressBar
            value={displayedEnergy?.current}
            max={energy?.max}
            size="sm"
            label="Запас энергии"
            valueText={
              displayedEnergy
                ? `${fmt(displayedEnergy.current)} из ${fmt(energy.max)} энергии${nextEnergy ? `, ${nextEnergy}` : ""}`
                : "Нет данных об энергии"
            }
          />
          {nextEnergy && <small>{nextEnergy}</small>}
        </div>
      </div>
      <dl className="overview-stats">
        {profile.stats.map(([name, value, derived, unit]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>
              {numberFormat.format(value)}
              {Number.isFinite(derived) && (
                <small>
                  {" "}
                  • {numberFormat.format(derived)} {unit}
                </small>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <dl className="overview-wallet" aria-label="Валюта">
        {profile.wallet.map(([name, value, icon]) => (
          <div key={name}>
            <dt>
              <Icon
                type={icon}
                size="small"
                className={`overview-wallet-icon overview-wallet-icon--${icon}`}
              />
              {name}
            </dt>
            <dd>{numberFormat.format(value)}</dd>
          </div>
        ))}
      </dl>
    </BaseCard>
  );
}

function NextGoal({ goal, floorAvailability, departmentState, profile }) {
  if (!goal) return null;
  const catalogueRequirements =
    goal.type === "floor"
      ? knowledgeBase.floors.find((floor) => floor.code === goal.code)
          ?.unlockRequirements
      : goal.department?.requirements;
  const requirements = displayRequirements(
    goal.requirements,
    catalogueRequirements,
  );
  const heading =
    goal.type === "floor"
      ? `Этаж ${goal.code}`
      : `${goal.code}${goal.name ? ` • ${goal.name}` : ""}`;

  return (
    <details
      className="floor-opening-disclosure floor-work-disclosure overview-goal-card"
      open
    >
      <summary className="floor-work-summary floor-opening-summary overview-goal-card-summary">
        <CardTitle className="floor-opening-heading">
          Следующая цель: {heading}
        </CardTitle>
        <LockIndicator
          locked={
            goal.type === "floor"
              ? floorAvailability.availability[goal.code] !== true
              : true
          }
          label={`Следующая цель: ${heading}`}
        />
      </summary>
      <div className="floor-work-expanded floor-opening-expanded">
        <GoalRequirements
          requirements={requirements}
          businessLevels={departmentState?.businessLevels}
          profile={profile}
        />
        {!requirements.length && floorAvailability.status === "error" && (
          <p className="overview-empty" role="status">
            Не удалось загрузить требования.
          </p>
        )}
      </div>
    </details>
  );
}

function RelevantRaids({ schedule, requirements, onOpenRaids }) {
  if (schedule.status !== "ready") return null;
  const targetNames = new Set(
    requirements
      .filter(
        (requirement) =>
          requirement.type === "boss_kills" &&
          requirementState(requirement) !== "complete",
      )
      .map(bossRequirementName)
      .filter(Boolean)
      .map(normalizeName),
  );
  const latest = schedule.posts?.[0];
  const raids = sortRaidsByTime(latest?.raids).filter(
    (raid) =>
      getRaidStatus(raid) !== "completed" &&
      targetNames.has(normalizeName(raid?.boss)),
  );
  if (!targetNames.size || !latest || !raids.length) return null;
  return (
    <BaseCard
      as="article"
      variant="floor-data"
      className="overview-card overview-raid-card"
    >
      <CardTitle as="h2">Рейды по цели</CardTitle>
      <ul className="overview-raid-list">
        {raids.map((raid, index) => {
          const status = getRaidStatus(raid);
          const info = RAID_STATUS_INFO[status] || RAID_STATUS_INFO.unknown;
          return (
            <li
              className="overview-raid"
              key={`${raid.boss}-${raid.time}-${index}`}
            >
              <div className="overview-raid-copy">
                <CardTitle as="span">{raid.boss}</CardTitle>
                <CardDescription>
                  {raid.time || "Время не указано"} •{" "}
                  {raid.zone || "Зона не указана"}
                </CardDescription>
              </div>
              <Pill variant={info.color}>{info.label}</Pill>
            </li>
          );
        })}
      </ul>
      <Button variant="secondary" onClick={onOpenRaids}>
        Все рейды
      </Button>
    </BaseCard>
  );
}

export function OverviewSection({
  profileState,
  floorAvailability,
  departmentState,
  schedule,
  onOpenRaids,
}) {
  const lastAvailableFloor = [...orderedFloors]
    .reverse()
    .find((floor) => floorAvailability.availability[floor.code] === true);
  const nextDepartment =
    departmentState?.status === "ready" &&
    departmentState.code === lastAvailableFloor?.code
      ? departmentState.departments.find((department) => !department.unlocked)
      : null;
  const nextFloor = getNextFloor(floorAvailability.availability);
  const goal = nextDepartment
    ? {
        type: "department",
        code: nextDepartment.blockCode,
        name: nextDepartment.name,
        requirements: nextDepartment.requirements,
        department:
          departmentById[
            (lastAvailableFloor?.departmentIds || []).find(
              (id) => departmentById[id]?.code === nextDepartment.blockCode,
            )
          ],
      }
    : nextFloor
      ? {
          type: "floor",
          code: nextFloor.code,
          requirements:
            floorAvailability.floorDetails?.[nextFloor.code]
              ?.unlockRequirements,
        }
      : null;
  const profile = profileState.status === "ready" ? profileState.profile : null;
  const goalRequirements = goal
    ? displayRequirements(
        goal.requirements,
        goal.type === "floor"
          ? knowledgeBase.floors.find((floor) => floor.code === goal.code)
              ?.unlockRequirements
          : goal.department?.requirements,
      )
    : [];

  return (
    <section className="overview-section" id="overview" aria-label="Главная">
      <ProfileSummary state={profileState} />
      {profile && <NextLevelSection playerLevel={profile.playerLevel} />}
      <div className="overview-grid">
        <NextGoal
          goal={goal}
          floorAvailability={floorAvailability}
          departmentState={departmentState}
          profile={profile}
        />
        <RelevantRaids
          schedule={schedule}
          requirements={goalRequirements}
          onOpenRaids={onOpenRaids}
        />
      </div>
    </section>
  );
}
