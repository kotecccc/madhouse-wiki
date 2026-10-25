import { useState } from "react";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { NumberField } from "../../../components/ui/NumberField/NumberField.jsx";
import { SelectField } from "../../../components/ui/SelectField/SelectField.jsx";
import "./BossHealingSettings.css";

const CURRENCIES = [
  { value: "gold", label: "Монеты" },
  { value: "dollar", label: "Купюры" },
  { value: "pills", label: "Пилюли" },
].map((option) => ({ ...option, id: option.value }));

const DEFAULTS = {
  enabled: false,
  autoBuy: false,
  items: {
    heal_10: { enabled: false, limit: 0, currency: "gold" },
    heal_full: { enabled: false, limit: 0, currency: "pills" },
  },
  budgets: { gold: 0, dollar: 0, pills: 0 },
};

const ITEM_LABELS = {
  heal_10: "Аптечка на 10% здоровья",
  heal_full: "Аптечка до полного здоровья",
};

function normalized(settings) {
  return {
    ...DEFAULTS,
    ...settings,
    items: Object.fromEntries(
      Object.keys(DEFAULTS.items).map((key) => [
        key,
        { ...DEFAULTS.items[key], ...settings?.items?.[key] },
      ]),
    ),
    budgets: { ...DEFAULTS.budgets, ...settings?.budgets },
  };
}

export function BossHealingSettings({ state, onSave }) {
  const [draftOverride, setDraftOverride] = useState(null);
  const draft = draftOverride ?? normalized(state.healing?.settings);

  const change = (update) =>
    setDraftOverride((current) => normalized(update(current ?? draft)));
  const updateItem = (key, patch) =>
    change((current) => ({
      ...current,
      items: { ...current.items, [key]: { ...current.items[key], ...patch } },
    }));
  const pending = Boolean(state.pending);
  const healing = state.healing ?? {};
  return (
    <BaseCard className="boss-healing-settings" aria-label="Автоаптечки">
      <div className="boss-healing-heading">
        <CardTitle as="h3">Автоаптечки</CardTitle>
        <Button
          variant="toggle"
          aria-pressed={draft.enabled}
          disabled={pending}
          onClick={() =>
            change((current) => ({ ...current, enabled: !current.enabled }))
          }
        >
          {draft.enabled ? "Включены" : "Выключены"}
        </Button>
      </div>
      <CardDescription>
        Настройки сохраняются для этого босса. Автоматическое использование
        ограничено заданными лимитами и бюджетами.
      </CardDescription>
      {Object.entries(draft.items).map(([key, item]) => (
        <section className="boss-healing-item" key={key}>
          <div className="boss-healing-heading">
            <CardTitle>{ITEM_LABELS[key]}</CardTitle>
            <Button
              variant="toggle"
              aria-pressed={item.enabled}
              disabled={pending || !draft.enabled}
              onClick={() => updateItem(key, { enabled: !item.enabled })}
            >
              {item.enabled ? "Включена" : "Выключена"}
            </Button>
          </div>
          <div className="boss-healing-fields">
            <NumberField
              id={`healing-${state.boss?.id}-${key}-limit`}
              label="Лимит на бой"
              hint="0 — не использовать"
              min="0"
              step="1"
              value={item.limit}
              disabled={pending || !draft.enabled || !item.enabled}
              onChange={(event) =>
                updateItem(key, {
                  limit: Math.max(0, Number(event.target.value) || 0),
                })
              }
            />
            <SelectField
              id={`healing-${state.boss?.id}-${key}-currency`}
              label="Валюта покупки"
              options={CURRENCIES}
              value={item.currency}
              disabled={pending || !draft.enabled || !item.enabled}
              onChange={(event) =>
                updateItem(key, { currency: event.target.value })
              }
            />
          </div>
          <CardDescription>
            Использовано в этом бою: {healing.used?.[key] ?? 0} / {item.limit}
          </CardDescription>
          <CardDescription>
            В запасе:{" "}
            {state.medicines?.find((medicine) => medicine.type === key)
              ?.quantity ?? "нет данных"}
          </CardDescription>
        </section>
      ))}
      <section className="boss-healing-item">
        <div className="boss-healing-heading">
          <CardTitle>Покупка аптечек</CardTitle>
          <Button
            variant="toggle"
            aria-pressed={draft.autoBuy}
            disabled={pending || !draft.enabled}
            onClick={() =>
              change((current) => ({ ...current, autoBuy: !current.autoBuy }))
            }
          >
            {draft.autoBuy ? "Разрешена" : "Запрещена"}
          </Button>
        </div>
        <div className="boss-healing-fields">
          {Object.entries(draft.budgets).map(([currency, amount]) => (
            <NumberField
              key={currency}
              id={`healing-${state.boss?.id}-budget-${currency}`}
              label={`Бюджет: ${CURRENCIES.find((item) => item.value === currency)?.label}`}
              hint="0 — покупки запрещены"
              min="0"
              step="1"
              value={amount}
              disabled={pending || !draft.enabled || !draft.autoBuy}
              onChange={(event) =>
                change((current) => ({
                  ...current,
                  budgets: {
                    ...current.budgets,
                    [currency]: Math.max(0, Number(event.target.value) || 0),
                  },
                }))
              }
            />
          ))}
        </div>
        <CardDescription>
          Потрачено за запуск: монеты {healing.spent?.gold ?? 0}, купюры{" "}
          {healing.spent?.dollar ?? 0}, пилюли {healing.spent?.pills ?? 0}
        </CardDescription>
      </section>
      {healing.forecast?.hitsNeeded > 0 && (
        <CardDescription>
          Оценочно до нормы: {healing.forecast.hitsNeeded} ударов,{" "}
          {healing.forecast.secondsNeeded} с без дополнительного лечения.
          {healing.forecast.atRisk
            ? " Есть риск не успеть до завершения боя."
            : " Темп других игроков может измениться."}
        </CardDescription>
      )}
      {(healing.notice || healing.invitationNotice) && (
        <CardDescription role="status">
          {healing.notice || healing.invitationNotice}
        </CardDescription>
      )}
      {healing.uncertain && (
        <>
          <CardDescription>
            Результат действия неизвестен. Обновите бой и запас, затем
            подтвердите учёт максимального зарезервированного расхода.
          </CardDescription>
          <Button
            disabled={pending || state.needsRefresh || Boolean(state.error)}
            onClick={() => void onSave(null)}
          >
            Расход проверен — учесть резерв
          </Button>
        </>
      )}
      <Button
        variant="primary"
        disabled={
          pending ||
          JSON.stringify(draft) === JSON.stringify(normalized(healing.settings))
        }
        onClick={() => void onSave(draft)}
      >
        Сохранить автоаптечки
      </Button>
    </BaseCard>
  );
}
