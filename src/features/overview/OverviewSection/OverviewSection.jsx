import {
  getSessionJson,
  postSessionJson,
} from "../../../../shared/session-api.js";
import { normalizeBoosters } from "../../works/WorkFarm/work-farm-plan.js";
import { CardActionMenu } from "../../../components/ui/CardActionMenu/CardActionMenu.jsx";
import { ApprovableButton } from "../../../components/ui/ConfirmButton/ConfirmButton.jsx";
import { Toast } from "../../../components/ui/Toast/Toast.jsx";
import { ErrorToast } from "../../../components/ui/ErrorToast/ErrorToast.jsx";
import { Skeleton } from "../../../components/ui/Skeleton/Skeleton.jsx";
import { useEffect, useState } from "react";
import { knowledgeBase } from "virtual:madhouse-catalogue";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
import { Wallet } from "../../../components/ui/Wallet/Wallet.jsx";
import { ImageCard } from "../../../components/ui/ImageCard/ImageCard.jsx";
import { InfoButton } from "../../../components/ui/InfoButton/InfoButton.jsx";
import { Pill } from "../../../components/ui/Pill/Pill.jsx";
import { StatusText } from "../../../components/ui/StatusText/StatusText.jsx";
import { ProgressBar } from "../../../components/ui/ProgressBar/ProgressBar.jsx";
import {
  getRaidStatus,
  RAID_STATUS_INFO,
  sortRaidsByTime,
} from "../../../lib/raid-schedule.js";
import {
  departmentById,
  orderedFloors,
} from "../../../model/knowledge-base.js";
import { fmt } from "../../../lib/format.js";
import { ProfileStatsMenu } from "./ProfileStatsMenu.jsx";
import { getProfileStatDisplay } from "../../auth/profile.js";
import { effectTimeLeft } from "../../../lib/stash-buff-time.js";
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
    const boss = findBoss(merged.targetBossId ?? merged.bossId);

    return {
      ...merged,
      openingConditionLabel: match?.label ?? requirement.label ?? "",
      targetBossId: merged.targetBossId ?? boss?.id ?? null,
      targetStashSetId: merged.targetStashSetId ?? merged.medallionId ?? null,
    };
  });
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
  return (
    <ImageCard
      variant="avatar"
      src={profile.avatarUrl}
      alt=""
      size={64}
      imageSize={64}
    >
      <Icon type="character" size="xlarge" />
    </ImageCard>
  );
}

function ProfileSummary({ state }) {
  const [now, setNow] = useState(() => Date.now());
  const [menuAnchor, setMenuAnchor] = useState(null);
  const [menuClosing, setMenuClosing] = useState(false);
  const [boosterQuotes, setBoosterQuotes] = useState([]);
  const [boosterError, setBoosterError] = useState(null);
  const [boosterPending, setBoosterPending] = useState(false);
  const [boosterQueued, setBoosterQueued] = useState(false);
  useEffect(() => {
    if (!menuAnchor) return undefined;
    let alive = true;
    setBoosterQuotes([]);
    setBoosterError(null);
    getSessionJson("/api/me/bag", {
      fresh: true,
      serverRefresh: "live",
      afterPending: true,
      revalidate: false,
    })
      .then((bag) => {
        if (alive) setBoosterQuotes(normalizeBoosters(bag));
      })
      .catch(() => {
        if (alive) setBoosterError("Не удалось проверить дефибрилляторы.");
      });
    return () => {
      alive = false;
    };
  }, [menuAnchor]);
  const finishMenu = () => {
    setMenuAnchor(null);
    setMenuClosing(false);
  };
  const closeMenu = () => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
      finishMenu();
    else setMenuClosing(true);
  };
  const submitBooster = async (booster) => {
    setBoosterPending(true);
    setBoosterError(null);
    try {
      const current = await getSessionJson("/api/automation/state", {
        fresh: true,
        revalidate: false,
      });
      await postSessionJson("/api/automation/commands", {
        id: crypto.randomUUID(),
        expectedVersion: current.version,
        command: "energy.booster.use",
        args: {
          type: booster.type,
          maxPrice: booster.count ? null : booster.costDollar,
        },
      });
      setBoosterQueued(true);
      closeMenu();
      void getSessionJson("/api/me", {
        fresh: true,
        serverRefresh: "live",
      }).catch(() => {});
    } catch {
      setBoosterError(
        "Не удалось применить дефибриллятор. Проверьте состояние и попробуйте снова.",
      );
    } finally {
      setBoosterPending(false);
    }
  };
  const profile = state.profile;
  const identity = state.identity;
  const energy = profile?.energy;
  const energyKnown =
    Number.isFinite(energy?.current) &&
    Number.isFinite(energy?.max) &&
    energy.max > 0;
  const displayedEnergy = energyKnown ? energyAtTime(energy, now) : null;
  const shouldTickEnergy =
    !!displayedEnergy && displayedEnergy.current < energy.max;
  const activeBuff = profile?.stashBuffs?.reduce(
    (earliest, buff) =>
      buff.expiresAtMs > now &&
      (!earliest || buff.expiresAtMs < earliest.expiresAtMs)
        ? buff
        : earliest,
    null,
  );
  const shouldTickEffects = Boolean(activeBuff);
  useEffect(() => {
    if (!shouldTickEnergy && !shouldTickEffects) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [shouldTickEnergy, shouldTickEffects]);
  if (!profile && identity)
    return (
      <BaseCard
        as="article"
        variant="floor-data"
        className="overview-card overview-player-card"
      >
        <div className="overview-player-summary">
          <PlayerAvatar profile={identity} />
          <div className="overview-player-identity">
            <div className="overview-player-name-row">
              <CardTitle as="h2">{identity.name}</CardTitle>
              <Skeleton variant="text" />
            </div>
            <div className="overview-level-progress">
              <div className="overview-level-heading">
                <span className="overview-energy-label">
                  <Icon type="sparkles-2" size="small" />
                  <CardDescription as="span" size="xs">
                    Опыт
                  </CardDescription>
                </span>
                <Skeleton variant="text" />
              </div>
              <Skeleton variant="progress" />
            </div>
          </div>
        </div>
        {state.status === "error" ? (
          <ErrorToast message={state.message} />
        ) : (
          <>
            <span className="sr-only" role="status">
              Загружаем актуальные данные профиля
            </span>
            <div className="overview-energy" role="group" aria-label="Энергия">
              <div className="overview-energy-heading">
                <span className="overview-energy-label">
                  <Icon type="energy" size="small" />
                  Энергия
                </span>
                <Skeleton variant="text" />
              </div>
              <Skeleton variant="progress" />
            </div>
            <dl className="overview-stats">
              {[
                ["Безумие", "madness"],
                ["Агрессия", "aggression"],
                ["Ярость", "rage"],
              ].map(([name, icon]) => (
                <div key={name}>
                  <dt>
                    <Icon type={icon} size="small" />
                    {name}
                  </dt>
                  <dd>
                    <Skeleton variant="text" />
                  </dd>
                </div>
              ))}
            </dl>
            <Wallet
              loading
              entries={[
                ["Монеты", null, "coin"],
                ["Пилюли", null, "pill"],
                ["Доллары", null, "banknote"],
              ]}
            />
          </>
        )}
      </BaseCard>
    );
  if (state.status === "loading" || state.status === "idle")
    return (
      <>
        <span className="sr-only" role="status">
          Загружаем профиль…
        </span>
        <Skeleton as="article" className="overview-card overview-player-card" />
      </>
    );
  if (state.status === "error") return <ErrorToast message={state.message} />;
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
  const energyContent = (
    <div className="overview-energy" role="group" aria-label="Энергия">
      <div className="overview-energy-heading">
        <span className="overview-energy-label">
          <Icon type="energy" size="small" className="overview-energy-icon" />
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
  );
  return (
    <BaseCard
      as="article"
      variant="floor-data"
      className="overview-card overview-player-card"
      state={menuAnchor ? "menu-active" : undefined}
      role="button"
      tabIndex={0}
      aria-haspopup="dialog"
      aria-expanded={Boolean(menuAnchor)}
      aria-label="Действия профиля"
      onClick={(event) => {
        const interactive = event.target.closest?.(
          "button, a, input, select, textarea, summary, dialog, [role=button], [role=dialog]",
        );
        if (interactive && interactive !== event.currentTarget) return;
        if (menuAnchor) closeMenu();
        else setMenuAnchor(event.currentTarget);
      }}
      onKeyDown={(event) => {
        if (
          event.target !== event.currentTarget ||
          !["Enter", " "].includes(event.key)
        )
          return;
        event.preventDefault();
        if (menuAnchor) closeMenu();
        else setMenuAnchor(event.currentTarget);
      }}
    >
      <div className="overview-player-heading">
        <div className="overview-player-summary">
          <PlayerAvatar profile={profile} />
          <div className="overview-player-identity">
            <div className="overview-player-name-row">
              <CardTitle as="h2">{profile.name}</CardTitle>
              {activeBuff && (
                <Pill
                  variant="completed"
                  size="xs"
                  dot={false}
                  role="status"
                  aria-label={`${activeBuff.name}: ${effectTimeLeft(activeBuff.expiresAtMs, now)}`}
                  title={`${activeBuff.name}: ${effectTimeLeft(activeBuff.expiresAtMs, now)}`}
                >
                  <Icon type="stash" size="small" />
                  {effectTimeLeft(activeBuff.expiresAtMs, now).replace(
                    "Осталось ",
                    "",
                  )}
                </Pill>
              )}
              {Number.isSafeInteger(profile.playerLevel) && (
                <Pill size="xs" dot={false}>
                  {fmt(profile.playerLevel)} ур.
                </Pill>
              )}
              {!Number.isSafeInteger(profile.playerLevel) &&
                state.levelStatus === "loading" && <Skeleton variant="text" />}
            </div>
            {state.updatedAt && (
              <CardDescription as="span" size="xs">
                Данные игры от{" "}
                {new Date(state.updatedAt).toLocaleString("ru-RU")}
                {state.snapshotStatus === "stale"
                  ? " · могут быть устаревшими"
                  : ""}
              </CardDescription>
            )}
            {!experienceKnown && energyContent}
            {Number.isSafeInteger(profile.playerLevel) && experienceKnown && (
              <div
                className="overview-level-progress"
                role="group"
                aria-label={`Прогресс уровня ${fmt(profile.playerLevel)}`}
              >
                <div className="overview-level-heading">
                  <span className="overview-energy-label">
                    <Icon type="sparkles-2" size="small" />
                    <CardDescription as="span" size="xs">
                      Опыт
                    </CardDescription>
                  </span>
                  {experienceKnown && (
                    <CardTitle as="span" size="sm" aria-hidden="true">
                      {numberFormat.format(profile.experience.current)} /{" "}
                      {numberFormat.format(profile.experience.toNextLevel)}
                    </CardTitle>
                  )}
                </div>
                <ProgressBar
                  value={profile.experience.current}
                  max={profile.experience.toNextLevel}
                  size="sm"
                  variant="active"
                  label={`Прогресс уровня ${fmt(profile.playerLevel)}`}
                  valueText={`${fmt(profile.experience.current)} из ${fmt(profile.experience.toNextLevel)} опыта`}
                />
              </div>
            )}
            {profile.stashBuffsStatus === "error" && (
              <ErrorToast message="Данные о временных эффектах недоступны" />
            )}
          </div>
        </div>
        {experienceKnown && energyContent}
      </div>
      <dl className="overview-stats">
        {profile.stats.map(([name, value, derived, unit]) => {
          const display = getProfileStatDisplay(profile, name, value, now);
          const description =
            name !== "Агрессия" && Number.isFinite(derived)
              ? `${fmt(derived)}${unit.startsWith("%") ? "" : " "}${unit}`
              : null;
          const statKey = {
            Безумие: "madness",
            Агрессия: "aggression",
            Ярость: "rage",
          }[name];
          const effects = (profile.stashBuffs || []).filter(
            (buff) => buff.expiresAtMs > now && buff[statKey] > 0,
          );
          const effectDescription = effects
            .map(
              (buff) =>
                `${buff.name}: +${fmt(buff[statKey])}, ${effectTimeLeft(buff.expiresAtMs, now)}`,
            )
            .join("; ");
          return (
            <div key={name}>
              <dt>
                <Icon
                  type={
                    {
                      Безумие: "madness",
                      Агрессия: "aggression",
                      Ярость: "rage",
                    }[name]
                  }
                  size="small"
                />
                {name}
                {(description || effectDescription) && (
                  <InfoButton
                    label={name}
                    description={[description, effectDescription]
                      .filter(Boolean)
                      .join(". ")}
                  />
                )}
              </dt>
              <dd>
                {numberFormat.format(display.value)}
                {display.temporary > 0 && (
                  <>
                    {" "}
                    <StatusText>
                      + {numberFormat.format(display.temporary)}
                    </StatusText>
                  </>
                )}
                {display.temporary === 0 && effects.length > 0 && (
                  <Pill
                    variant="completed"
                    size="xs"
                    dot={false}
                    title={effectDescription}
                  >
                    Бонус +
                    {numberFormat.format(
                      effects.reduce((sum, buff) => sum + buff[statKey], 0),
                    )}
                  </Pill>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
      <Wallet entries={profile.wallet} />
      {boosterQueued && (
        <Toast
          floating
          success
          title="Готово"
          onDismiss={() => setBoosterQueued(false)}
        >
          Дефибриллятор применён.
        </Toast>
      )}
      {menuAnchor && (
        <CardActionMenu
          anchor={menuAnchor}
          label="Действия профиля"
          onClose={closeMenu}
          closing={menuClosing}
          onClosed={finishMenu}
          preferFit
          scrollable
          fullWidth
        >
          {boosterError && <ErrorToast message={boosterError} />}
          <ProfileStatsMenu />
          {["small", "full"].map((type) => {
            const booster = boosterQuotes.find((item) => item.type === type);
            const label =
              type === "small"
                ? "Применить малый деф."
                : "Применить большой деф.";
            const buy = booster?.count === 0;
            return (
              <ApprovableButton
                key={type}
                variant="menu-item"
                icon={
                  type === "small"
                    ? "defibrillator-small"
                    : "defibrillator-large"
                }
                liftOnHover={false}
                menuValue={booster ? fmt(booster.count) : "—"}
                confirmationKey={`${type}:${booster?.count}:${booster?.costDollar}`}
                confirmationLabel={
                  buy ? `Точно? · ${fmt(booster.costDollar)} купюр` : "Точно?"
                }
                disabled={
                  !booster ||
                  boosterPending ||
                  (buy && booster.maxPurchaseQuantity < 1)
                }
                onClick={() => void submitBooster(booster)}
              >
                {label}
              </ApprovableButton>
            );
          })}
        </CardActionMenu>
      )}
    </BaseCard>
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
      <RelevantRaids
        schedule={schedule}
        requirements={goalRequirements}
        onOpenRaids={onOpenRaids}
      />
    </section>
  );
}
