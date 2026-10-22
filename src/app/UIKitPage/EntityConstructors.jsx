import { useState } from "react";
import { knowledgeBase } from "virtual:madhouse-catalogue";
import { BaseCard } from "../../components/ui/BaseCard/BaseCard.jsx";
import { Button } from "../../components/ui/Button/Button.jsx";
import { CardDescription } from "../../components/ui/CardDescription/CardDescription.jsx";
import { CardTitle } from "../../components/ui/CardTitle/CardTitle.jsx";
import { SelectField } from "../../components/ui/SelectField/SelectField.jsx";
import { WorkCard } from "../../features/works/WorkCard/WorkCard.jsx";
import { BusinessEntityCard } from "../../features/businesses/BusinessEntityCard/BusinessEntityCard.jsx";
import { BlockCard } from "../../features/floors/BlockCard/BlockCard.jsx";
import { OpeningConditionCard } from "../../features/floors/OpeningConditionCard/OpeningConditionCard.jsx";
import { useRaidSchedule } from "../../features/raids/useRaidSchedule.js";
import { getRaidDisplayZone, getRaidStatus } from "../../lib/raid-schedule.js";
import {
  departmentById,
  getBusinessUpgrade,
  orderedFloors,
} from "../../model/knowledge-base.js";
import { EntityCardEditor } from "./EntityCardEditor.jsx";
import { BossCardEditor } from "./BossCardEditor.jsx";
import "./EntityConstructors.css";

const bosses = (knowledgeBase.bosses || []).filter(
  (boss) => boss.apiId && boss.name,
);
const businesses = knowledgeBase.businesses.filter(
  (business) => business.title,
);
const works = knowledgeBase.works.filter((work) => work.title);
const departments = knowledgeBase.departments
  .filter(
    (department) =>
      department.work ||
      department.name ||
      department.openingConditions?.length,
  )
  .sort((a, b) =>
    (a.code || "").localeCompare(b.code || "", "en", { numeric: true }),
  );
const floorOrderById = new Map(
  orderedFloors.map((floor, index) => [floor.id, index]),
);
const bossOptions = [...bosses].sort((a, b) => {
  const left = departmentById[a.departmentId],
    right = departmentById[b.departmentId];
  return (
    (floorOrderById.get(left?.floorId) ?? Infinity) -
      (floorOrderById.get(right?.floorId) ?? Infinity) ||
    (left?.code || "").localeCompare(right?.code || "", "en", {
      numeric: true,
    }) ||
    a.name.localeCompare(b.name, "ru")
  );
});
const sampleBoss = bosses.find((boss) => boss.dropItems?.length) || bosses[0];
const sampleBusiness =
  businesses.find(
    (business) => getBusinessUpgrade(business.id)?.items?.length,
  ) || businesses[0];
const conditions = departments
  .flatMap((department) =>
    (department.openingConditions || []).map((requirement, index) => ({
      requirement,
      department,
      key: `${department.id}:${requirement.id || index}`,
    })),
  )
  .concat(
    orderedFloors.flatMap((floor) =>
      (floor.openingConditions || []).map((requirement, index) => ({
        requirement,
        department: { id: floor.id, code: `Этаж ${floor.code}` },
        key: `${floor.id}:${requirement.id || index}`,
      })),
    ),
  );
const conditionTypeLabels = {
  business_level: "Уровень бизнеса",
  work_completions: "Выполнения работы",
  boss_kills: "Победы над боссом",
  department_open: "Открытие блока",
  player_level: "Уровень игрока",
  combat_rating: "Боевой рейтинг",
  rage_total: "Ярость",
  dice_level: "Уровень кубиков",
  stash_medallion: "Медальон",
};
function normalizeBossName(name) {
  return String(name || "")
    .normalize("NFC")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
function EntityConstructor({ title, controls, preview }) {
  return (
    <BaseCard className="ui-kit-entity-card">
      <CardTitle>{title}</CardTitle>
      <div className="ui-kit-entity-body">
        {controls && <div className="ui-kit-entity-controls">{controls}</div>}
        <div className="ui-kit-entity-preview">{preview}</div>
      </div>
    </BaseCard>
  );
}
function Modes({ value, onChange, options, label }) {
  return (
    <div className="entity-editor-inline" role="group" aria-label={label}>
      {options.map(([id, text]) => (
        <Button
          key={id}
          size="sm"
          variant="toggle"
          aria-pressed={value === id}
          onClick={() => onChange(id)}
        >
          {text}
        </Button>
      ))}
    </div>
  );
}
export function EntityConstructors() {
  const { posts: raidPosts } = useRaidSchedule();
  const [selectedBossId, setSelectedBossId] = useState(
    String(sampleBoss?.id || ""),
  );
  const [workId, setWorkId] = useState(works[0]?.id || "");
  const [businessId, setBusinessId] = useState(sampleBusiness?.id || "");
  const [blockId, setBlockId] = useState(
    departments.find((item) => item.code === "A1")?.id ||
      departments[0]?.id ||
      "",
  );
  const [conditionId, setConditionId] = useState(
    conditions.find((item) => item.requirement.type === "work_completions")
      ?.key ||
      conditions[0]?.key ||
      "",
  );
  const [businessLevel, setBusinessLevel] = useState(null);
  const [businessMode, setBusinessMode] = useState("overview");
  const [conditionMode, setConditionMode] = useState("detailed");
  const selectedBoss = bosses.find(
    (boss) => String(boss.id) === selectedBossId,
  );
  const department = departmentById[selectedBoss?.departmentId];
  const selectedRaid = raidPosts
    .flatMap((post) => post.raids || [])
    .find(
      (raid) =>
        normalizeBossName(raid.boss) === normalizeBossName(selectedBoss?.name),
    );
  const raid = selectedBoss
    ? {
        ...(selectedRaid || {}),
        boss: selectedBoss.name,
        zone: selectedRaid
          ? getRaidDisplayZone(selectedRaid)
          : department?.code || "",
      }
    : null;
  const selectedWork = works.find((work) => work.id === workId);
  const selectedBusiness = businesses.find(
    (business) => business.id === businessId,
  );
  const upgradeLevelCount = Math.max(
    0,
    ...(getBusinessUpgrade(businessId)?.items || []).map(
      (item) => item.levels?.length || 0,
    ),
  );
  const targetBusinessLevel =
    upgradeLevelCount > 0 ? (businessLevel ?? upgradeLevelCount) : undefined;
  const selectedBlock = departmentById[blockId];
  const selectedCondition = conditions.find((item) => item.key === conditionId);
  function selectBoss(event) {
    setSelectedBossId(event.target.value);
  }
  function selectTarget(target) {
    if (target?.id) {
      setBlockId(target.id);
      document
        .getElementById("kit-block-preview")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }
  return (
    <div className="ui-kit-entity-list" id="entities">
      <EntityConstructor
        title="Карточка босса"
        controls={
          <SelectField
            id="kit-boss-select"
            aria-label="Boss"
            spacing="none"
            value={selectedBossId}
            onChange={selectBoss}
            options={[
              { id: "select-boss", value: "", label: "Select boss" },
              ...bossOptions.map((boss) => ({
                id: boss.id,
                value: String(boss.id),
                label: `${departmentById[boss.departmentId]?.code || departmentById[boss.departmentId]?.blockCode || "—"} - ${boss.name}`,
              })),
            ]}
          />
        }
        preview={
          selectedBoss && (
            <BossCardEditor
              key={selectedBoss.id}
              boss={selectedBoss}
              raid={raid}
              status={selectedRaid ? getRaidStatus(selectedRaid) : "unknown"}
            />
          )
        }
      />
      <EntityConstructor
        title="Работа"
        controls={
          <SelectField
            id="kit-work"
            label="Работа"
            spacing="none"
            value={workId}
            onChange={(event) => setWorkId(event.target.value)}
            options={works.map((work) => ({
              id: work.id,
              value: work.id,
              label: `${departmentById[work.departmentId]?.code || "—"} • ${work.title}`,
            }))}
          />
        }
        preview={
          selectedWork ? (
            <EntityCardEditor
              key={`work:${workId}`}
              entityKey={`work:${workId}`}
            >
              <WorkCard
                work={selectedWork}
                department={departmentById[selectedWork.departmentId]}
                preset="work-main"
              />
            </EntityCardEditor>
          ) : (
            <CardDescription>Работы в каталоге не указаны</CardDescription>
          )
        }
      />
      <EntityConstructor
        title="Бизнес"
        controls={
          <>
            <SelectField
              id="kit-business"
              label="Бизнес"
              spacing="none"
              value={businessId}
              onChange={(event) => {
                setBusinessId(event.target.value);
                setBusinessLevel(null);
              }}
              options={businesses.map((business) => ({
                id: business.id,
                value: business.id,
                label: `${departmentById[business.departmentId]?.code || "—"} • ${business.title}`,
              }))}
            />
            <Modes
              value={businessMode}
              onChange={setBusinessMode}
              label="Вариант бизнеса"
              options={[
                ["overview", "Бизнес"],
                ["upgrade", "Улучшение"],
              ]}
            />
          </>
        }
        preview={
          selectedBusiness ? (
            <EntityCardEditor
              key={`businessEntity:${businessId}:${businessMode}`}
              entityKey={`businessEntity:${businessId}:${businessMode}`}
              componentProps={{
                mode: businessMode,
                ...(businessMode === "upgrade" &&
                targetBusinessLevel !== undefined
                  ? { targetLevel: targetBusinessLevel }
                  : {}),
              }}
            >
              <BusinessEntityCard
                key={`${businessId}:${businessMode}`}
                business={selectedBusiness}
                upgrade={getBusinessUpgrade(businessId)}
                mode={businessMode}
                targetLevel={targetBusinessLevel}
                onTargetLevelChange={setBusinessLevel}
              />
            </EntityCardEditor>
          ) : (
            <CardDescription>Бизнесы в каталоге не указаны</CardDescription>
          )
        }
      />
      <div id="kit-block-preview">
        <EntityConstructor
          title="Блок"
          controls={
            <SelectField
              id="kit-block"
              label="Блок этажа"
              spacing="none"
              value={blockId}
              onChange={(event) => setBlockId(event.target.value)}
              options={departments.map((item) => ({
                id: item.id,
                value: item.id,
                label: [item.code, item.name].filter(Boolean).join(" • "),
              }))}
            />
          }
          preview={
            selectedBlock ? (
              <EntityCardEditor
                key={`block:${blockId}`}
                entityKey={`block:${blockId}`}
              >
                <BlockCard
                  department={selectedBlock}
                  onTargetSelect={selectTarget}
                />
              </EntityCardEditor>
            ) : (
              <CardDescription>Блоки в каталоге не указаны</CardDescription>
            )
          }
        />
      </div>
      <EntityConstructor
        title="Условие открытия"
        controls={
          <>
            <SelectField
              id="kit-condition"
              label="Условие"
              spacing="none"
              value={conditionId}
              onChange={(event) => setConditionId(event.target.value)}
              options={conditions.map((item) => ({
                id: item.key,
                value: item.key,
                label: `${item.department.code} • ${conditionTypeLabels[item.requirement.type] || item.requirement.type} • ${item.requirement.label || "Условие"}`,
              }))}
            />
            <Modes
              value={conditionMode}
              onChange={setConditionMode}
              label="Вариант условия"
              options={[
                ["compact", "Компактное"],
                ["detailed", "Подробное"],
                ["progress", "С прогрессом"],
              ]}
            />
          </>
        }
        preview={
          selectedCondition ? (
            <EntityCardEditor
              key={`condition:${conditionId}:${conditionMode}`}
              entityKey={`condition:${conditionId}:${conditionMode}`}
              componentProps={{ mode: conditionMode }}
            >
              <OpeningConditionCard
                requirement={selectedCondition.requirement}
                department={selectedCondition.department}
                mode={conditionMode}
                onTargetSelect={selectTarget}
              />
            </EntityCardEditor>
          ) : (
            <CardDescription>
              Условия открытия в каталоге не указаны
            </CardDescription>
          )
        }
      />
    </div>
  );
}
