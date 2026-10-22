import { useEffect, useState } from "react";
import { knowledgeBase } from "virtual:madhouse-catalogue";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
import {
  getRaidStatus,
  RAID_STATUS_INFO,
  sortRaidsByTime,
} from "../../../lib/raid-schedule.js";
import { orderedFloors } from "../../../model/knowledge-base.js";
import { fmt } from "../../../lib/format.js";
import "./OverviewSection.css";

const numberFormat = new Intl.NumberFormat("ru-RU");

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

function requirementProgress(requirement) {
  if (
    Number.isFinite(requirement?.current) &&
    Number.isFinite(requirement?.required)
  ) {
    const label =
      requirement.type === "business_level" ? "Уровень" : "Прогресс";
    const unit = requirement.type === "business_level" ? " ур." : "";
    return `${label}: ${numberFormat.format(requirement.current)} / ${numberFormat.format(requirement.required)}${unit}`;
  }
  if (requirement?.type === "department_open")
    return "Отделение должно быть открыто";
  return "Текущий прогресс не передан игрой";
}

function StatusPill({ state, label }) {
  const labels = {
    complete: "Выполнено",
    incomplete: "Осталось",
    unknown: "Нет данных",
  };
  return (
    <span className={`overview-status overview-status--${state}`}>
      <span className="overview-status-dot" aria-hidden="true" />
      {label || labels[state]}
    </span>
  );
}

function RequirementList({
  requirements,
  empty = "Нет условий в данных игры.",
}) {
  if (!requirements?.length) return <p className="overview-empty">{empty}</p>;
  return (
    <ul className="overview-requirements">
      {requirements.map((requirement, index) => {
        const state = requirementState(requirement);
        return (
          <li
            className="overview-requirement"
            key={`${requirement.type}-${requirement.label}-${index}`}
          >
            <div className="overview-requirement-copy">
              <CardTitle as="span">{requirementLabel(requirement)}</CardTitle>
              <CardDescription>
                {requirementProgress(requirement)}
              </CardDescription>
            </div>
            <StatusPill state={state} />
          </li>
        );
      })}
    </ul>
  );
}

function displayRequirements(apiRequirements, catalogueRequirements) {
  if (Array.isArray(apiRequirements) && apiRequirements.length)
    return apiRequirements;
  return catalogueRequirements || [];
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
  if (state.status === "loading" || state.status === "idle")
    return (
      <p className="overview-empty" role="status">
        Загружаем персонажа…
      </p>
    );
  if (state.status === "error")
    return (
      <p className="overview-empty" role="status">
        {state.message}
      </p>
    );
  const profile = state.profile;
  const energyKnown =
    Number.isFinite(profile?.energy?.current) &&
    Number.isFinite(profile?.energy?.max);
  const nextEnergy = Number.isFinite(profile?.energy?.secondsToNext)
    ? profile.energy.secondsToNext <= 0
      ? "Энергия восполнена"
      : `+1 через ${Math.floor(profile.energy.secondsToNext / 60)} мин ${profile.energy.secondsToNext % 60} сек`
    : "";
  return (
    <BaseCard
      as="article"
      variant="floor-data"
      className="overview-card overview-player-card"
    >
      <div className="overview-player-heading">
        <PlayerAvatar profile={profile} />
        <div className="overview-player-identity">
          <CardTitle as="h2">{profile.name}</CardTitle>
          <CardDescription>
            {profile.username ? `@${profile.username}` : "Персонаж игрока"}
          </CardDescription>
        </div>
        <div className="overview-energy" aria-label="Энергия">
          <span>Энергия</span>
          <strong>
            {energyKnown
              ? `${numberFormat.format(profile.energy.current)} / ${numberFormat.format(profile.energy.max)}`
              : "Нет данных"}
          </strong>
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
                  · {numberFormat.format(derived)} {unit}
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
              <Icon type={icon} size="small" />
              {name}
            </dt>
            <dd>{numberFormat.format(value)}</dd>
          </div>
        ))}
      </dl>
    </BaseCard>
  );
}

function FloorGoal({
  floor,
  details,
  status,
  availability,
  onOpenFloors,
  onRetry,
}) {
  if (status === "loading")
    return (
      <p className="overview-empty" role="status">
        Загружаем доступность этажей…
      </p>
    );
  if (status === "error")
    return (
      <>
        <p className="overview-empty" role="status">
          Не удалось определить следующую цель.
        </p>
        <Button variant="secondary" onClick={onRetry}>
          Повторить
        </Button>
      </>
    );
  if (!floor) {
    const allAvailable =
      orderedFloors.length > 0 &&
      orderedFloors.every((item) => availability[item.code] === true);
    return (
      <p className="overview-empty">
        {allAvailable
          ? "Все этажи справочника уже доступны."
          : "Игра не передала доступность следующего этажа."}
      </p>
    );
  }
  const catalogueFloor = knowledgeBase.floors.find(
    (item) => item.code === floor.code,
  );
  const requirements = displayRequirements(
    details?.unlockRequirements,
    catalogueFloor?.unlockRequirements,
  );
  return (
    <>
      <div className="overview-goal-heading">
        <div>
          <CardTitle as="h3">Этаж {floor.code}</CardTitle>
          <CardDescription>
            {details?.requiredLevel != null
              ? `Требуемый уровень персонажа: ${fmt(details.requiredLevel)}`
              : details?.unlockDescription ||
                "Следующая цель по доступности в игре"}
          </CardDescription>
        </div>
        <StatusPill state="incomplete" label="Закрыт" />
      </div>
      <RequirementList
        requirements={requirements}
        empty="Игра пока не передала список условий этого этажа."
      />
      {catalogueFloor?.openingConditionText && (
        <p className="overview-caveat">{catalogueFloor.openingConditionText}</p>
      )}
      <Button variant="secondary" onClick={() => onOpenFloors(floor.code)}>
        Открыть этажи
      </Button>
    </>
  );
}

function DepartmentGoals({ state }) {
  if (!state)
    return (
      <p className="overview-empty">
        Загрузка условий отделений после восстановления сессии…
      </p>
    );
  if (state?.status === "loading")
    return (
      <p className="overview-empty" role="status">
        Загружаем условия отделений…
      </p>
    );
  if (state?.status === "error")
    return (
      <p className="overview-empty">Условия отделений временно недоступны.</p>
    );
  const locked = (state?.departments || []).filter(
    (department) => !department.unlocked,
  );
  if (!locked.length)
    return (
      <p className="overview-empty">
        Нет закрытых отделений в последнем доступном этаже.
      </p>
    );
  return (
    <div className="overview-department-list">
      {locked.map((department) => (
        <div className="overview-department-goal" key={department.blockCode}>
          <div className="overview-goal-heading">
            <div>
              <CardTitle as="h3">
                {department.name || department.blockCode}
              </CardTitle>
              <CardDescription>{department.blockCode}</CardDescription>
            </div>
            <StatusPill state="incomplete" label="Закрыто" />
          </div>
          <RequirementList requirements={department.requirements} />
        </div>
      ))}
    </div>
  );
}

function RelevantRaids({ schedule, requirements, onOpenRaids }) {
  if (schedule.status === "loading")
    return (
      <p className="overview-empty" role="status">
        Загружаем актуальные рейды…
      </p>
    );
  if (schedule.status === "error")
    return (
      <p className="overview-empty">Расписание рейдов временно недоступно.</p>
    );
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
  if (!targetNames.size)
    return (
      <p className="overview-empty">
        В условиях этой цели нет требований по боссам.
      </p>
    );
  if (!latest || !raids.length)
    return (
      <p className="overview-empty">
        В актуальном расписании нет рейдов на нужных боссов.
      </p>
    );
  return (
    <>
      <p className="overview-raid-date">
        Расписание на {latest.raidDateLabel || "ближайшую дату"}
      </p>
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
                  {raid.time || "Время не указано"} ·{" "}
                  {raid.zone || "Зона не указана"}
                </CardDescription>
              </div>
              <span
                className={`overview-status overview-status--${info.color}`}
              >
                <span className="overview-status-dot" aria-hidden="true" />
                {info.label}
              </span>
            </li>
          );
        })}
      </ul>
      <Button variant="secondary" onClick={onOpenRaids}>
        Все рейды
      </Button>
    </>
  );
}

export function OverviewSection({
  profileState,
  floorAvailability,
  departmentState,
  schedule,
  onOpenFloors,
  onOpenRaids,
  onRetryFloors,
}) {
  const nextFloor = getNextFloor(floorAvailability.availability);
  const targetDetails = nextFloor
    ? floorAvailability.floorDetails?.[nextFloor.code]
    : null;
  const catalogueFloor = nextFloor
    ? knowledgeBase.floors.find((floor) => floor.code === nextFloor.code)
    : null;
  const floorRequirements = displayRequirements(
    targetDetails?.unlockRequirements,
    catalogueFloor?.unlockRequirements,
  );
  const departmentRequirements = (departmentState?.departments || [])
    .filter((department) => !department.unlocked)
    .flatMap((department) => department.requirements || []);
  const raidRequirements = [...floorRequirements, ...departmentRequirements];

  return (
    <section
      className="overview-section"
      id="overview"
      aria-labelledby="overview-title"
    >
      <div className="overview-heading">
        <div>
          <h1 id="overview-title">Обзор</h1>
          <p>Персонаж, ближайшая цель и рейды по её условиям.</p>
        </div>
      </div>
      <ProfileSummary state={profileState} />
      <div className="overview-grid">
        <BaseCard
          as="article"
          variant="floor-data"
          className="overview-card overview-goal-card"
        >
          <div className="overview-card-heading">
            <div>
              <CardTitle as="h2">Следующий этаж</CardTitle>
              <CardDescription>
                Условия открытия по текущим данным игры
              </CardDescription>
            </div>
          </div>
          <FloorGoal
            floor={nextFloor}
            details={targetDetails}
            status={floorAvailability.status}
            availability={floorAvailability.availability}
            onOpenFloors={onOpenFloors}
            onRetry={onRetryFloors}
          />
        </BaseCard>
        <BaseCard
          as="article"
          variant="floor-data"
          className="overview-card overview-raid-card"
        >
          <div className="overview-card-heading">
            <div>
              <CardTitle as="h2">Рейды по цели</CardTitle>
              <CardDescription>
                Боссы из условий этажа и закрытых отделений
              </CardDescription>
            </div>
          </div>
          <RelevantRaids
            schedule={schedule}
            requirements={raidRequirements}
            onOpenRaids={onOpenRaids}
          />
        </BaseCard>
      </div>
      <BaseCard
        as="article"
        variant="floor-data"
        className="overview-card overview-department-card"
      >
        <div className="overview-card-heading">
          <div>
            <CardTitle as="h2">Отделения текущего этажа</CardTitle>
            <CardDescription>
              {departmentState?.code
                ? `Закрытые отделения этажа ${departmentState.code}`
                : "Закрытые отделения последнего доступного этажа"}
            </CardDescription>
          </div>
        </div>
        <DepartmentGoals state={departmentState} />
      </BaseCard>
    </section>
  );
}
