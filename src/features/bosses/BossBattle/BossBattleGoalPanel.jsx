import { useId, useState } from "react";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { NumberField } from "../../../components/ui/NumberField/NumberField.jsx";
import { SelectField } from "../../../components/ui/SelectField/SelectField.jsx";
import { ProgressBar } from "../../../components/ui/ProgressBar/ProgressBar.jsx";
import { BOSS_GOAL_KINDS, goalDropOptions } from "./boss-goal-options.js";
import "./BossBattleGoalPanel.css";

const statusText = {
  active: "Цель выполняется",
  completed: "Цель достигнута",
  exhausted: "Лимит боёв исчерпан",
  stopped: "Цель остановлена",
};
const positive = (n) => Number.isSafeInteger(n) && n > 0;
const goalTitle = (goal) => {
  if (goal.kind === "battles") return `Завершить ${goal.targetCount} боёв`;
  if (goal.kind === "business_items")
    return `Собрать ${goal.targetCount} · ${goal.items[0]?.name || "Предмет бизнеса"}`;
  if (goal.kind === "drops") return "Собрать выбранный дроп";
  return goal.deadlineAt == null
    ? "Без ограничения времени"
    : `Бои в течение ${(goal.deadlineAt - goal.startedAt) / 3600000} ч`;
};
const durationText = (seconds) => {
  const value = Math.max(0, seconds || 0);
  return `${Math.floor(value / 3600)} ч ${Math.floor((value % 3600) / 60)} мин ${value % 60} с`;
};

export function BossBattleGoalPanel({
  state,
  goal,
  auto = { enabled: false },
  onStopAuto,
  onConfigure,
  onStop,
  onReset,
}) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [kind, setKind] = useState("battles");
  const [target, setTarget] = useState("5");
  const [limit, setLimit] = useState("0");
  const [materialKey, setMaterialKey] = useState("");
  const [selection, setSelection] = useState("all");
  const [selectedKeys, setSelectedKeys] = useState([]);
  const [hours, setHours] = useState("1");
  const options = goalDropOptions(state.boss?.reference || state.boss);
  const materials = options.filter((item) => item.type === "activity_item");
  const itemKey = materials.some((item) => item.key === materialKey)
    ? materialKey
    : materials[0]?.key || "";
  const itemKeys =
    selection === "all"
      ? options.map((item) => item.key)
      : selectedKeys.filter((key) => options.some((item) => item.key === key));
  const count = Number(target),
    cap = Number(limit);
  const pending = Boolean(state.pending);
  const cannotSave =
    pending ||
    state.needsRefresh ||
    state.purchaseUncertain ||
    Boolean(state.purchase);
  const valid =
    (kind === "time" || kind === "drops" || positive(count)) &&
    (kind === "battles" || (Number.isSafeInteger(cap) && cap >= 0)) &&
    (kind !== "business_items" || Boolean(itemKey)) &&
    (kind !== "drops" || itemKeys.length > 0);
  if (goal)
    return (
      <BaseCard className="boss-battle-goal-panel" aria-label="Цель боя">
        <CardTitle as="h3">
          {goalTitle(goal)} · {goal.boss.name}
        </CardTitle>
        <CardDescription role="status">
          {statusText[goal.status]}
        </CardDescription>
        <CardDescription>
          Завершено боёв: {goal.completedBattles} · Начато: {goal.attempts}
          {goal.maxAttempts != null ? ` / ${goal.maxAttempts}` : ""}
        </CardDescription>
        {goal.kind === "time" ? (
          <CardDescription>
            {goal.remainingSeconds == null
              ? "До ручной остановки"
              : `Осталось: ${durationText(goal.remainingSeconds)}`}
          </CardDescription>
        ) : (
          <CardDescription>
            Прогресс: {goal.progress} / {goal.target}
          </CardDescription>
        )}
        {goal.target != null && (
          <ProgressBar
            label="Прогресс цели"
            value={Math.min(goal.progress, goal.target)}
            max={goal.target}
          />
        )}
        {(goal.kind === "business_items" || goal.kind === "drops") &&
          goal.items.map((item) => (
            <CardDescription key={item.key}>
              {item.name} ·{" "}
              {goal.kind === "business_items"
                ? `${item.amount} / ${goal.targetCount}`
                : item.received
                  ? `Получен · ${item.amount}`
                  : "Ожидается"}
            </CardDescription>
          ))}
        {goal.rewardUncertain &&
          ["business_items", "drops"].includes(goal.kind) && (
            <CardDescription role="status">
              Сервер не подтвердил полный список наград одного из боёв. Прогресс
              учитывает только подтверждённую добычу.
            </CardDescription>
          )}
        {goal.legacyMigration && (
          <CardDescription>
            Прежняя цель на победы остановлена. Создайте цель одного из новых
            типов.
          </CardDescription>
        )}
        {goal.kind === "time" && goal.deadlineAt != null && (
          <CardDescription>
            По истечении времени новые игровые действия не отправляются. Текущий
            бой не завершается автоматически.
          </CardDescription>
        )}
        {goal.status === "active" && (
          <CardDescription>
            При включённом авто следующий бой запускается автоматически до
            достижения цели или лимита.
          </CardDescription>
        )}
        {goal.status === "stopped" && (
          <CardDescription>
            Остановка цели не завершает бой в игре. Его можно продолжить
            вручную.
          </CardDescription>
        )}
        <div className="boss-battle-actions">
          {auto.enabled && (
            <Button onClick={onStopAuto}>Остановить авто</Button>
          )}
          {goal.status === "active" ? (
            <Button onClick={onStop}>Остановить цель</Button>
          ) : (
            <>
              <Button
                disabled={pending}
                onClick={() => {
                  onReset();
                  setEditing(true);
                }}
              >
                Новая цель
              </Button>
              <Button
                disabled={pending}
                onClick={() => {
                  onReset();
                  setEditing(false);
                }}
              >
                Убрать цель
              </Button>
            </>
          )}
        </div>
      </BaseCard>
    );
  if (!editing)
    return (
      <Button disabled={pending} icon="combat" onClick={() => setEditing(true)}>
        Настроить цель
      </Button>
    );
  return (
    <BaseCard
      as="form"
      className="boss-battle-goal-panel"
      aria-label="Настройка цели боя"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid || cannotSave) return;
        void onConfigure({
          bossId: state.boss.id,
          kind,
          ...(kind === "battles" || kind === "business_items"
            ? { targetCount: count }
            : {}),
          ...(kind === "business_items" ? { itemKey } : {}),
          ...(kind === "drops"
            ? { selection, ...(selection === "selected" ? { itemKeys } : {}) }
            : {}),
          ...(kind === "time"
            ? { durationHours: hours === "infinite" ? null : Number(hours) }
            : {}),
          maxAttempts: kind === "battles" ? count : cap || null,
        });
        setEditing(false);
      }}
    >
      <CardTitle as="h3">Настройка цели · {state.boss.name}</CardTitle>
      <SelectField
        id={`${id}-kind`}
        label="Тип цели"
        value={kind}
        options={BOSS_GOAL_KINDS}
        disabled={pending}
        onChange={(event) => setKind(event.target.value)}
      />
      {(kind === "battles" || kind === "business_items") && (
        <NumberField
          id={`${id}-count`}
          label={
            kind === "battles" ? "Количество боёв" : "Количество предметов"
          }
          suffix={kind === "battles" ? "боёв" : "шт."}
          min="1"
          value={target}
          disabled={pending}
          onChange={(event) => setTarget(event.target.value)}
        />
      )}
      {kind === "business_items" && (
        <>
          <SelectField
            id={`${id}-material`}
            label="Предмет бизнеса"
            value={itemKey}
            disabled={pending || !materials.length}
            options={
              materials.length
                ? materials.map((item) => ({
                    id: item.key,
                    value: item.key,
                    label: item.name,
                  }))
                : [
                    {
                      id: "empty",
                      value: "",
                      label: "Предметы бизнеса не указаны в каталоге",
                    },
                  ]
            }
            onChange={(event) => setMaterialKey(event.target.value)}
          />
          <CardDescription>
            Считается количество полученных предметов, а не боёв. Бой без
            нужного предмета не увеличивает прогресс.
          </CardDescription>
        </>
      )}
      {kind === "drops" && (
        <>
          <SelectField
            id={`${id}-selection`}
            label="Что собрать"
            value={selection}
            options={[
              {
                id: "all",
                value: "all",
                label: "Все предметы из списка босса",
              },
              {
                id: "selected",
                value: "selected",
                label: "Выбранные предметы",
              },
            ]}
            disabled={pending}
            onChange={(event) => {
              setSelection(event.target.value);
              if (event.target.value === "selected")
                setSelectedKeys(options.map((item) => item.key));
            }}
          />
          {selection === "selected" && (
            <div className="boss-battle-actions">
              {options.map((item) => (
                <Button
                  key={item.key}
                  disabled={pending}
                  aria-pressed={itemKeys.includes(item.key)}
                  onClick={() =>
                    setSelectedKeys((keys) =>
                      keys.includes(item.key)
                        ? keys.filter((key) => key !== item.key)
                        : [...keys, item.key],
                    )
                  }
                >
                  {item.name}
                </Button>
              ))}
            </div>
          )}
          <CardDescription>
            {itemKeys.length
              ? `Выбрано предметов: ${itemKeys.length}. Нужно получить каждый хотя бы один раз.`
              : "В каталоге нет доступных предметов или ничего не выбрано."}{" "}
            Список фиксируется при создании цели.
          </CardDescription>
        </>
      )}
      {kind === "time" && (
        <SelectField
          id={`${id}-hours`}
          label="Продолжительность"
          value={hours}
          disabled={pending}
          options={[1, 2, 4]
            .map((value) => ({
              id: String(value),
              value: String(value),
              label: `${value} ч`,
            }))
            .concat({ id: "infinite", value: "infinite", label: "Бесконечно" })}
          onChange={(event) => setHours(event.target.value)}
        />
      )}
      {kind !== "battles" && (
        <NumberField
          id={`${id}-limit`}
          label="Лимит боёв (0 — без ограничения)"
          suffix="боёв"
          min="0"
          value={limit}
          disabled={pending}
          onChange={(event) => setLimit(event.target.value)}
        />
      )}
      {!valid && (
        <CardDescription role="alert">
          Проверьте количество и выберите доступные предметы.
        </CardDescription>
      )}
      {cannotSave && !pending && (
        <CardDescription role="status">
          Для сохранения цели нужно подтверждённое состояние с сервера.
        </CardDescription>
      )}
      <CardDescription>
        {state.battle?.status === "active"
          ? "Текущий бой включается в цель."
          : "Учитываются только новые бои и добыча после создания цели."}{" "}
        Настройки и прогресс сохраняются на сервере.
      </CardDescription>
      <div className="boss-battle-actions">
        <Button type="submit" variant="primary" disabled={!valid || cannotSave}>
          Создать цель
        </Button>
        <Button onClick={() => setEditing(false)}>Отмена</Button>
      </div>
    </BaseCard>
  );
}
