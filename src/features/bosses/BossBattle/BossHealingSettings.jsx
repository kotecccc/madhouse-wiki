import { useEffect, useState } from "react";
import { Disclosure } from "../../../components/ui/Disclosure/Disclosure.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
import { NumberStepper } from "../../../components/ui/NumberStepper/NumberStepper.jsx";
import { Pill } from "../../../components/ui/Pill/Pill.jsx";
import { SegmentedControl } from "../../../components/ui/SegmentedControl/SegmentedControl.jsx";
import { fmt } from "../../../lib/format.js";
import "./BossHealingSettings.css";

const ITEMS = [
  {
    type: "heal_10",
    label: "Малая",
    effect: "10% HP",
    icon: "medicine-small",
    currency: "gold",
  },
  {
    type: "heal_full",
    label: "Большая",
    effect: "100% HP",
    icon: "medicine-full",
    currency: "pills",
  },
];
const DEFAULTS = {
  enabled: false,
  autoBuy: false,
  items: Object.fromEntries(
    ITEMS.map(({ type, currency }) => [
      type,
      { enabled: false, limit: 0, currency },
    ]),
  ),
  budgets: { gold: 0, dollar: 0, pills: 0 },
};
export function normalizeHealingDraft(settings) {
  return {
    ...DEFAULTS,
    ...settings,
    items: Object.fromEntries(
      ITEMS.map(({ type }) => [
        type,
        { ...DEFAULTS.items[type], ...settings?.items?.[type] },
      ]),
    ),
    budgets: { ...DEFAULTS.budgets, ...settings?.budgets },
  };
}

export function BossHealingSettings({
  state,
  onSave,
  collapsed = false,
  readOnly = false,
  onDraftChange,
}) {
  const healing = state.healing ?? {};
  const [localDraft, setLocalDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const draft = localDraft ?? normalizeHealingDraft(healing.settings);
  const pending = Boolean(state.pending);
  const blocked = readOnly || (pending && !saving);
  const inBattle = state.battle?.status === "active";
  const limit = draft.enabled
    ? ITEMS.reduce(
        (total, { type }) =>
          total + (draft.items[type].enabled ? draft.items[type].limit : 0),
        0,
      )
    : 0;
  const used = healing.used
    ? ITEMS.reduce((total, { type }) => total + (healing.used[type] ?? 0), 0)
    : null;
  useEffect(() => {
    if (
      readOnly ||
      onDraftChange ||
      !localDraft ||
      pending ||
      saving ||
      saveError
    )
      return;
    const timer = setTimeout(async () => {
      setSaving(true);
      let saved = false;
      try {
        saved = await onSave(localDraft);
        setSaveError(saved === false);
      } catch {
        setSaveError(true);
      } finally {
        // A newer edit stays queued until the current request finishes.
        if (saved !== false)
          setLocalDraft((current) => (current === localDraft ? null : current));
        setSaving(false);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [localDraft, pending, saving, onSave, readOnly, onDraftChange, saveError]);
  const change = (update) => {
    if (blocked) return;
    setSaveError(false);
    const next = normalizeHealingDraft(update(draft));
    next.enabled = Object.values(next.items).some(
      (item) => item.enabled && item.limit > 0,
    );
    next.budgetMode = "item_limits";
    setLocalDraft(next);
    onDraftChange?.(next);
  };
  const updateItem = (type, patch) =>
    change((current) => ({
      ...current,
      items: {
        ...current.items,
        [type]: { ...current.items[type], ...patch },
      },
    }));

  return (
    <Disclosure
      key={`${collapsed}:${Boolean(state.battle)}`}
      title={inBattle ? "Аптечки" : "Использовать аптечки?"}
      size="sm"
      separated
      leading={<Icon type="medical-cross" size="medium" />}
      defaultOpen={!collapsed && !state.battle && Boolean(healing.uncertain)}
      status={
        <Pill variant="unknown" size="xs" dot={false}>
          {inBattle
            ? `${used === null ? "—" : fmt(used)} / ${fmt(limit)}`
            : `${fmt(limit)} шт.`}
        </Pill>
      }
    >
      <div className="boss-healing-settings">
        {saveError && (
          <CardDescription role="alert">
            Не удалось сохранить настройки аптечек. Проверьте их и попробуйте
            снова.
          </CardDescription>
        )}
        {ITEMS.map(({ type, label, effect, icon }) => {
          const item = draft.items[type];
          const stock = state.medicines?.find(
            (medicine) => medicine.type === type,
          )?.quantity;
          return (
            <div className="boss-healing-row" key={type}>
              <Icon type={icon} size="large" />
              <div className="boss-healing-copy">
                <CardTitle size="sm">
                  {label} · {effect}
                </CardTitle>
                <CardDescription size="xs">
                  В наличии: {Number.isFinite(stock) ? stock : "Нет данных"}
                </CardDescription>
              </div>
              <div className="boss-healing-limit">
                <NumberStepper
                  id={`healing-${state.boss?.id}-${type}-limit`}
                  label={`${label} аптечка: лимит на бой`}
                  hideLabel
                  compact
                  min={0}
                  max={10000}
                  rangeLabel={null}
                  value={item.enabled ? item.limit : 0}
                  disabled={blocked}
                  decrementLabel={`Меньше ${label.toLowerCase()} аптечек`}
                  incrementLabel={`Больше ${label.toLowerCase()} аптечек`}
                  onChange={(limit) =>
                    updateItem(type, { limit, enabled: limit > 0 })
                  }
                />
              </div>
            </div>
          );
        })}
        <div className="boss-healing-purchase">
          <CardTitle size="sm">Автопокупка</CardTitle>
          <SegmentedControl
            label="Автопокупка аптечек"
            size="sm"
            options={[
              {
                value: "off",
                label: "Выкл",
                ariaLabel: "Автопокупка выключена",
              },
              {
                value: "gold",
                label: <Icon type="coin" size="medium" />,
                ariaLabel: "Покупать за монеты",
              },
              {
                value: "pills",
                label: <Icon type="pill" size="medium" />,
                ariaLabel: "Покупать за пилюли",
              },
            ].map((option) => ({ ...option, disabled: blocked }))}
            value={draft.autoBuy ? draft.items.heal_10.currency : "off"}
            onChange={(value) => {
              change((current) => ({
                ...current,
                autoBuy: value !== "off",
                budgetMode: "item_limits",
                items:
                  value === "off"
                    ? current.items
                    : Object.fromEntries(
                        ITEMS.map(({ type }) => [
                          type,
                          { ...current.items[type], currency: value },
                        ]),
                      ),
              }));
            }}
          />
        </div>
        {healing.uncertain && !onDraftChange && (
          <>
            <CardDescription>
              Обновите бой и запас, затем подтвердите учёт резерва.
            </CardDescription>
            <Button
              disabled={
                readOnly ||
                pending ||
                state.needsRefresh ||
                Boolean(state.error)
              }
              onClick={() => void onSave(null)}
            >
              Состояние проверено
            </Button>
          </>
        )}
      </div>
    </Disclosure>
  );
}
