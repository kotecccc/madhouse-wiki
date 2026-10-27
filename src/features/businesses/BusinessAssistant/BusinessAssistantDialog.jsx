import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Modal } from "../../../components/ui/Modal/Modal.jsx";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { NumberField } from "../../../components/ui/NumberField/NumberField.jsx";
import { SelectField } from "../../../components/ui/SelectField/SelectField.jsx";
import { Disclosure } from "../../../components/ui/Disclosure/Disclosure.jsx";
import { BossCardView } from "../../bosses/BossCard/BossCardView.jsx";
import { BusinessItemTile } from "../BusinessItemTile/BusinessItemTile.jsx";
import { bossById } from "../../../model/knowledge-base.js";
import {
  businessAssistant,
  bossBattle,
  bossBattleGoal,
} from "../../bosses/BossBattle/boss-battle-session.js";
import { fmt } from "../../../lib/format.js";
import "./BusinessAssistantDialog.css";

const money = (amount, currency) =>
  amount == null
    ? "Неизвестна"
    : `${fmt(amount)} ${{ gold: "монет", pills: "пилюль", dollar: "долларов" }[currency] || ""}`;
const amountText = (amount) => (amount == null ? "неизвестно" : fmt(amount));
const useStore = (store) =>
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

export function BusinessAssistantDialog({
  business,
  upgrade,
  onClose,
  assistantStore = businessAssistant,
  battleStore = bossBattle,
  goalStore = bossBattleGoal,
}) {
  const state = useStore(assistantStore);
  const battleState = useStore(battleStore);
  const activeGoal = useStore(goalStore);
  const plan = state.plans?.find((item) => item.businessId === business.id);
  const maxLevel =
    business.maxLevel ||
    Math.max(
      1,
      ...(upgrade?.items || []).map((item) => item.levels?.length || 0),
    );
  const [draft, setDraft] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const [runConfirmation, setRunConfirmation] = useState(false);
  const selected = useRef(null);
  useEffect(() => {
    if (!state.loaded) {
      selected.current = null;
      setDraft(null);
      setConfirmation(null);
      setRunConfirmation(false);
    }
  }, [state.loaded]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (state.loaded && !state.pending && selected.current !== business.id) {
      selected.current = business.id;
      void assistantStore.select(business.id);
    }
  }, [assistantStore, business.id, state.loaded, state.pending]);
  const targetLevel =
    draft?.targetLevel ?? String(plan?.config.targetLevel ?? 1);
  const currentLevel =
    draft?.currentLevel ??
    (plan?.config.currentLevelOverride == null
      ? ""
      : String(plan.config.currentLevelOverride));
  const maxAttempts =
    draft?.maxAttempts ?? String(plan?.config.maxAttempts ?? 0);
  const durationHours =
    draft?.durationHours ??
    (plan?.config.durationHours === undefined
      ? "2"
      : plan.config.durationHours === null
        ? "unlimited"
        : String(plan.config.durationHours));
  const bossChoices = draft?.bossChoices ?? plan?.config.bossChoices ?? {};
  const autoUpgrade =
    draft?.autoUpgrade ?? (plan?.config.autoUpgrade ? "upgrade" : "collect");
  const update = (field, value) =>
    setDraft({
      targetLevel,
      currentLevel,
      maxAttempts,
      durationHours,
      bossChoices,
      autoUpgrade,
      [field]: value,
    });
  const target = Number(targetLevel),
    current = currentLevel === "" ? null : Number(currentLevel),
    cap = Number(maxAttempts),
    duration = durationHours === "unlimited" ? null : Number(durationHours);
  const valid =
    Number.isSafeInteger(target) &&
    target > 0 &&
    target <= maxLevel &&
    (current == null ||
      (Number.isSafeInteger(current) && current >= 0 && current <= target)) &&
    Number.isSafeInteger(cap) &&
    cap >= 0 &&
    (duration == null || [1, 2, 4].includes(duration));
  const busy = state.pending;
  const run = state.run;
  const running = run?.status === "running";
  const selectedBoss = (item) => {
    const choices = item.bosses || [];
    return (
      choices.find((boss) => boss.id === Number(bossChoices[item.entityId])) ||
      choices[0] ||
      null
    );
  };
  const runMaterials = (plan?.materials || []).filter(
    (item) => item.missingAmount == null || item.missingAmount > 0,
  );
  const runReady = Boolean(
    plan &&
    !draft &&
    plan.canCreateGoals &&
    (runMaterials.length > 0 || (plan.config.autoUpgrade && !plan.achieved)) &&
    (!plan.config.autoUpgrade || plan.currentLevelSource === "game") &&
    runMaterials.every(
      (item) => item.missingAmount > 0 && selectedBoss(item),
    ) &&
    (cap > 0 || duration != null),
  );
  const configuredBossChoices = Object.fromEntries(
    (plan?.materials || []).flatMap((item) => {
      const boss = selectedBoss(item);
      return boss ? [[item.entityId, boss.id]] : [];
    }),
  );
  const updateBossChoice = (itemId, bossId) =>
    setDraft({
      targetLevel,
      currentLevel,
      maxAttempts,
      durationHours,
      autoUpgrade,
      bossChoices: { ...bossChoices, [itemId]: Number(bossId) },
    });
  const save = async (event) => {
    event.preventDefault();
    if (!valid || busy) return;
    if (
      await assistantStore.save({
        businessId: business.id,
        targetLevel: target,
        currentLevelOverride: current,
        maxAttempts: cap || null,
        durationHours: duration,
        bossChoices: configuredBossChoices,
        autoUpgrade: autoUpgrade === "upgrade",
      })
    )
      setDraft(null);
  };
  const confirmRun = async () => {
    if (!runConfirmation || busy || !runReady) return;
    const ok = await assistantStore.startRun({
      businessId: business.id,
      replaceExisting: activeGoal?.status === "active",
      expectedPlan: plan.config,
      expectedMissing: runMaterials.map((item) => ({
        itemId: item.entityId,
        amount: item.missingAmount,
      })),
    });
    if (mounted.current && ok) setRunConfirmation(false);
  };
  const confirmGoal = async () => {
    if (!confirmation || busy) return;
    const { item, boss } = confirmation;
    const ok = await assistantStore.createGoal({
      businessId: business.id,
      itemId: item.entityId,
      bossId: boss.id,
      expectedMissing: item.missingAmount,
      replaceExisting: activeGoal?.status === "active",
    });
    if (!mounted.current) return;
    if (!ok) {
      setConfirmation(null);
      return;
    }
    setConfirmation(null);
    onClose();
    void battleStore.open(
      { numericId: boss.id, name: boss.name },
      { refresh: false },
    );
  };
  return (
    <Modal
      title={`Помощник · ${business.title || "Бизнес"}`}
      loading={Boolean(busy || (!state.loaded && !state.error))}
      width="var(--page-max-width)"
      onClose={onClose}
      onRefresh={() => assistantStore.refresh(business.id)}
      refreshKey={`business-${business.id}`}
      footer={<Button onClick={onClose}>Закрыть</Button>}
    >
      {state.error && (
        <BaseCard role="alert">
          <CardTitle>Помощник временно недоступен</CardTitle>
          <CardDescription title={state.error}>{state.error}</CardDescription>
        </BaseCard>
      )}
      {state.notice && (
        <CardDescription role="status" title={state.notice}>
          {state.notice}
        </CardDescription>
      )}
      <div className="business-assistant-layout">
        <div className="business-assistant-column">
          <BaseCard
            as="form"
            className="business-assistant-column"
            onSubmit={save}
            aria-label="План улучшения бизнеса"
          >
            <CardTitle as="h3">Целевой уровень</CardTitle>
            <CardDescription>
              Текущий уровень:{" "}
              {plan?.currentLevel == null
                ? "неизвестен"
                : fmt(plan.currentLevel)}
              {plan?.currentLevelSource === "manual"
                ? " · введён вручную"
                : plan?.currentLevelSource === "game"
                  ? " · из игры"
                  : ""}
            </CardDescription>
            <NumberField
              id={`business-plan-target-${business.id}`}
              label="До какого уровня улучшить"
              suffix="ур."
              min="1"
              max={maxLevel}
              value={targetLevel}
              disabled={busy || running}
              onChange={(event) => update("targetLevel", event.target.value)}
            />
            <NumberField
              id={`business-plan-current-${business.id}`}
              label="Текущий уровень вручную (пусто — данные игры)"
              suffix="ур."
              min="0"
              max={maxLevel}
              value={currentLevel}
              disabled={busy || running}
              onChange={(event) => update("currentLevel", event.target.value)}
            />
            <NumberField
              id={`business-plan-cap-${business.id}`}
              label="Общий лимит боёв на сбор (0 — без ограничения)"
              suffix="боёв"
              min="0"
              value={maxAttempts}
              disabled={busy || running}
              onChange={(event) => update("maxAttempts", event.target.value)}
            />
            <SelectField
              id={`business-plan-duration-${business.id}`}
              label="Время сбора"
              value={durationHours}
              disabled={busy || running}
              onChange={(event) => update("durationHours", event.target.value)}
              options={[
                { id: "1h", value: "1", label: "1 час" },
                { id: "2h", value: "2", label: "2 часа" },
                { id: "4h", value: "4", label: "4 часа" },
                {
                  id: "unlimited",
                  value: "unlimited",
                  label: "Без ограничения",
                },
              ]}
            />
            <SelectField
              id={`business-plan-action-${business.id}`}
              label="После сбора материалов"
              value={autoUpgrade}
              disabled={busy || running}
              onChange={(event) => update("autoUpgrade", event.target.value)}
              options={[
                { id: "collect", value: "collect", label: "Только собрать" },
                { id: "upgrade", value: "upgrade", label: "Улучшить бизнес" },
              ]}
            />
            {draft != null && (
              <CardDescription>
                Нажмите «Рассчитать и сохранить», чтобы обновить расчёт.
              </CardDescription>
            )}
            {!valid && (
              <CardDescription role="alert">
                Проверьте уровни и лимит боёв.
              </CardDescription>
            )}
            <Button
              type="submit"
              variant="primary"
              disabled={busy || running || !state.loaded || !valid}
            >
              Рассчитать и сохранить
            </Button>
            <CardDescription>
              План сохраняется на сервере. Для запуска подтвердите его ниже.
              Улучшение расходует игровую валюту и материалы.
            </CardDescription>
          </BaseCard>
          <BaseCard className="business-assistant-column">
            <CardTitle as="h3">Стоимость улучшений</CardTitle>
            <CardDescription>
              До целевого уровня: {money(plan?.cost.total, plan?.cost.currency)}
            </CardDescription>
            {plan?.cost.nextAmount != null && (
              <CardDescription>
                Ближайшее улучшение:{" "}
                {money(plan.cost.nextAmount, plan.cost.nextCurrency)}
              </CardDescription>
            )}
            {!plan?.cost.complete && (
              <CardDescription>
                Полная стоимость до целевого уровня пока неизвестна. Обновите
                игровые данные; известная цена ближайшего улучшения показывается
                отдельно.
              </CardDescription>
            )}
          </BaseCard>
          {upgrade && (
            <Disclosure
              title="Источник расчёта"
              description="Таблица улучшений"
            >
              <CardDescription title={upgrade.note}>
                {upgrade.note ||
                  "Материалы рассчитаны по сохранённой таблице уровней."}
              </CardDescription>
              {(plan?.sourceNotes || []).map((note) => (
                <CardDescription key={note.itemName} title={note.itemName}>
                  {note.itemName}: исходный итог {note.declared}, сумма{" "}
                  {note.computed}.
                </CardDescription>
              ))}
            </Disclosure>
          )}
          {(plan?.notes || []).map((note) => (
            <CardDescription key={note} title={note}>
              {note}
            </CardDescription>
          ))}
        </div>
        <div className="business-assistant-column">
          <CardTitle as="h3">Материалы и боссы для добычи</CardTitle>
          {plan && (
            <CardDescription>
              Расчёт: уровень {amountText(plan.currentLevel)} →{" "}
              {amountText(plan.targetLevel)}
            </CardDescription>
          )}
          {plan?.materials.length > 0 &&
            plan.materials.every((item) => item.missingAmount === 0) && (
              <CardDescription role="status">
                Все материалы для выбранного уровня собраны.
              </CardDescription>
            )}
          {plan?.achieved && (
            <CardDescription role="status">
              Целевой уровень уже достигнут.
            </CardDescription>
          )}
          {!plan && (
            <CardDescription>
              Сохраните целевой уровень, чтобы получить расчёт.
            </CardDescription>
          )}
          {plan?.materials.map((item, index) => (
            <BaseCard
              key={`${item.entityId}-${index}`}
              className="business-assistant-column"
            >
              <div className="business-assistant-item-heading">
                <BusinessItemTile
                  itemId={item.entityId}
                  name={item.name}
                  size={48}
                  imageSize={40}
                />
                <div className="business-assistant-column">
                  <CardTitle>{item.name || "Предмет не указан"}</CardTitle>
                  <CardDescription>
                    Нужно: {amountText(item.requiredAmount)} · Есть:{" "}
                    {amountText(item.ownedAmount)}
                  </CardDescription>
                  <CardDescription>
                    Не хватает: {amountText(item.missingAmount)}
                  </CardDescription>
                </div>
              </div>
              {item.bosses.length === 0 && (
                <CardDescription>
                  Источник добычи пока не указан в каталоге.
                </CardDescription>
              )}
              {item.missingAmount > 0 && item.bosses.length > 1 && (
                <SelectField
                  id={`business-boss-choice-${business.id}-${item.entityId}`}
                  label="Босс для сбора"
                  value={String(selectedBoss(item)?.id ?? "")}
                  disabled={busy || running}
                  onChange={(event) =>
                    updateBossChoice(item.entityId, event.target.value)
                  }
                  options={item.bosses.map((source) => ({
                    id: String(source.id),
                    value: String(source.id),
                    label: source.name,
                  }))}
                />
              )}
              {item.bosses.map((source) => {
                const boss = Object.values(bossById).find(
                  (record) =>
                    Number(record.numericId ?? record.apiId) === source.id,
                );
                return boss ? (
                  <BossCardView
                    key={source.id}
                    boss={boss}
                    variant="floor-data"
                    showDropList={false}
                    showBattleAction={false}
                    action={
                      <Button
                        disabled={
                          running ||
                          busy ||
                          battleState.pending != null ||
                          item.missingAmount == null ||
                          item.missingAmount <= 0 ||
                          draft != null
                        }
                        icon="combat"
                        onClick={() => setConfirmation({ item, boss: source })}
                      >
                        Создать цель · {amountText(item.missingAmount)} шт.
                      </Button>
                    }
                  />
                ) : (
                  <CardDescription key={source.id}>
                    {source.name}
                  </CardDescription>
                );
              })}
            </BaseCard>
          ))}
        </div>
      </div>
      {confirmation && (
        <BaseCard
          className="business-assistant-column"
          aria-label="Подтверждение цели"
        >
          <CardTitle as="h3">Цель на недостающий материал</CardTitle>
          <CardDescription>
            {confirmation.boss.name} · {confirmation.item.name} ·{" "}
            {fmt(confirmation.item.missingAmount)} шт.
          </CardDescription>
          {activeGoal?.status === "active" && (
            <CardDescription>
              Текущая цель будет заменена, авто остановится. Подтвердите замену.
            </CardDescription>
          )}
          <CardDescription>
            Перед созданием сервер ещё раз проверит запасы. Бой и авто не
            запускаются.
          </CardDescription>
          <div className="business-assistant-actions">
            <Button disabled={busy} onClick={() => setConfirmation(null)}>
              Отмена
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void confirmGoal()}
            >
              Создать цель
            </Button>
          </div>
        </BaseCard>
      )}
      {plan && (
        <BaseCard className="business-assistant-column">
          <CardTitle as="h3">
            {plan.config.autoUpgrade
              ? "Улучшение бизнеса"
              : "Полный сбор материалов"}
          </CardTitle>
          <CardDescription>
            Запуск использует сохранённый план. Настройки должны быть сохранены
            перед подтверждением.
          </CardDescription>
          {plan.config.autoUpgrade && plan.cost.nextAmount == null && (
            <CardDescription>
              Стоимость следующего улучшения не подтверждена. Сбор возможен, но
              повышение остановится, если игра не сообщит стоимость.
            </CardDescription>
          )}
          <Button
            variant="primary"
            disabled={busy || running || !state.loaded || !runReady}
            onClick={() => setRunConfirmation(true)}
          >
            {plan.config.autoUpgrade
              ? "Улучшить бизнес"
              : "Собрать все материалы"}
          </Button>
        </BaseCard>
      )}
      {run && run.status !== "running" && (
        <BaseCard role="status" className="business-assistant-column">
          <CardTitle as="h3">
            {run.status === "completed"
              ? run.config?.autoUpgrade
                ? "Улучшение завершено"
                : "Сбор завершён"
              : "Выполнение остановлено"}
          </CardTitle>
          <CardDescription>{run.reason || run.status}</CardDescription>
        </BaseCard>
      )}
      {running && (
        <BaseCard className="business-assistant-column" aria-live="polite">
          <CardTitle as="h3">
            {run.config?.autoUpgrade ? "Улучшение бизнеса" : "Сбор материалов"}{" "}
            ·{" "}
            {{
              preparing: "подготовка",
              opening: "выбор босса",
              farming: "бой",
              verifying: "проверка запасов",
              upgrading: "улучшение бизнеса",
              retrying: "ожидание проверки",
            }[run.phase] || "подготовка"}
          </CardTitle>
          <CardDescription>
            {run.name} · уровень {run.targetLevel} · общий лимит боёв:{" "}
            {run.maxBattles ?? "без ограничения"} · время:{" "}
            {run.config?.durationHours == null
              ? "без ограничения"
              : `${run.config.durationHours} ч.`}
          </CardDescription>
          <CardDescription>
            {run.currentItemName || "Подготовка"} · боёв начато{" "}
            {run.battlesStarted} · завершено {run.battlesCompleted}
          </CardDescription>
          {run.reason && <CardDescription>{run.reason}</CardDescription>}
          {run.materials?.map((item) => (
            <CardDescription key={item.itemId}>
              {item.name}: {amountText(item.collectedAmount)} /{" "}
              {amountText(item.targetAmount)}
            </CardDescription>
          ))}
          <Button
            variant="secondary"
            onClick={() => void assistantStore.stopRun()}
          >
            Остановить
          </Button>
        </BaseCard>
      )}
      {runConfirmation && (
        <BaseCard
          className="business-assistant-column"
          aria-label="Подтверждение полного сбора"
        >
          <CardTitle as="h3">
            {plan.config.autoUpgrade
              ? "Подтвердите улучшение"
              : "Подтвердите полный сбор"}
          </CardTitle>
          {plan.config.autoUpgrade && (
            <CardDescription>
              Бизнес будет улучшаться до уровня {plan.targetLevel}. Каждое
              улучшение расходует игровую валюту и материалы; полная стоимость
              может быть неизвестна.
            </CardDescription>
          )}
          {plan.config.autoUpgrade && plan.cost.nextAmount == null && (
            <CardDescription>
              Цена следующего улучшения пока неизвестна; без подтверждённой цены
              списания не будет.
            </CardDescription>
          )}
          {runMaterials.map((item) => {
            const boss = selectedBoss(item);
            return (
              <CardDescription key={item.entityId}>
                {item.name}: не хватает {amountText(item.missingAmount)} · босс{" "}
                {boss?.name}
              </CardDescription>
            );
          })}
          <CardDescription>
            Общий лимит боёв: {cap || "без ограничения"} · время:{" "}
            {duration == null ? "без ограничения" : `${duration} ч.`}
          </CardDescription>
          {activeGoal?.status === "active" && (
            <CardDescription>
              Активная цель будет заменена. Подтвердите замену.
            </CardDescription>
          )}
          <div className="business-assistant-actions">
            <Button disabled={busy} onClick={() => setRunConfirmation(false)}>
              Отмена
            </Button>
            <Button
              variant="primary"
              disabled={busy || !runReady}
              onClick={() => void confirmRun()}
            >
              {plan.config.autoUpgrade ? "Начать улучшение" : "Начать сбор"}
            </Button>
          </div>
        </BaseCard>
      )}
    </Modal>
  );
}
