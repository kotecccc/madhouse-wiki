import { useBossRewardReference } from "../../features/bosses/useBossRewardReference.js";
import { VariantExport } from "./VariantExport.jsx";
import { validateImplementation } from "./entity-variants.js";
import { DisplayFieldPicker } from "./DisplayFieldPicker.jsx";
import {
  raidDisplayFields,
  normalizeFieldSelection,
} from "../../lib/card-display-fields.js";
import { departmentById } from "../../model/knowledge-base.js";
import { useEffect, useState } from "react";
import { Button } from "../../components/ui/Button/Button.jsx";
import { Icon } from "../../components/ui/Icon/Icon.jsx";
import { CardDescription } from "../../components/ui/CardDescription/CardDescription.jsx";
import { MonoLabel } from "../../components/ui/MonoLabel/MonoLabel.jsx";
import { CardTitle } from "../../components/ui/CardTitle/CardTitle.jsx";
import { FieldLabel } from "../../components/ui/FieldLabel/FieldLabel.jsx";
import { Popover } from "../../components/ui/Popover/Popover.jsx";
import "./BossCardEditor.css";
import { Input } from "../../components/ui/Input/Input.jsx";
import { NumberField } from "../../components/ui/NumberField/NumberField.jsx";
import { BossDropItem } from "../../features/bosses/BossDropItems/BossDropItems.jsx";
import { BossCardView } from "../../features/bosses/BossCard/BossCardView.jsx";
import { bossCardVariants } from "../../features/bosses/BossCard/boss-card-variants.js";

const fontSizes = [
  "2xs",
  "xs",
  "sm",
  "md",
  "lg",
  "xl",
  "2xl",
  "3xl",
  "display",
];
const itemSizes = [
  "--space-24",
  "--space-32",
  "--space-40",
  "--space-48",
  "--space-64",
];
const spacingSizes = ["4", "8", "12", "16", "24", "32", "40", "48", "64"];
const defaultSettings = {
  cardPadding: "16",
  contentGap: "8",
  columnGap: "12",
  titleSize: "md",
  infoSize: "sm",
  descriptionBreakBefore: [],
  showPortrait: true,
  showInfo: true,
  showDrops: true,
  showAction: false,
  showStatus: false,
  showAvailability: false,
  status: "scheduled",
  availability: "locked",
  actionSize: "md",
  statusSize: "sm",
  statusCompact: false,
  availabilitySize: "sm",
  actionText: "Весь дроп",
  drops: {},
};
const sourceVariantNames = {
  "boss-main": "Основная",
  "boss-raid": "Рейд",
  "boss-business": "Бизнес",
};
const sourceCardVariants = {
  "boss-main": "floor-data",
  "boss-raid": "raid",
  "boss-business": "floor-data",
};
const hasSourceVariant = (key) =>
  Object.prototype.hasOwnProperty.call(bossCardVariants, key);
const cardVariants = new Set(["floor-data", "raid", "boss"]);
const maxStoredVariants = 30 + Object.keys(bossCardVariants).length;
const newVariant = () => ({
  id: crypto.randomUUID(),
  name: "Основная",
  settings: { ...defaultSettings, drops: {} },
});
function normalizeSettings(source) {
  const settings = { ...defaultSettings, drops: {} };
  for (const prop of ["cardPadding", "contentGap", "columnGap"])
    if (spacingSizes.includes(source[prop])) settings[prop] = source[prop];
  for (const prop of [
    "titleFields",
    "descriptionFields",
    "descriptionBreakBefore",
  ]) {
    const selection = normalizeFieldSelection(source[prop]);
    if (selection) settings[prop] = selection;
  }
  for (const prop of ["titleSize", "infoSize"])
    if (fontSizes.includes(source[prop])) settings[prop] = source[prop];
  for (const prop of [
    "showPortrait",
    "showInfo",
    "showDrops",
    "showAction",
    "showStatus",
    "statusCompact",
    "showAvailability",
  ])
    if (typeof source[prop] === "boolean") settings[prop] = source[prop];
  if (["scheduled", "active", "completed"].includes(source.status))
    settings.status = source.status;
  for (const prop of ["title", "infoText", "actionText"])
    if (typeof source[prop] === "string")
      settings[prop] = source[prop].slice(0, 1000);
  for (const prop of ["actionSize", "statusSize", "availabilitySize"])
    if (
      (prop === "actionSize"
        ? ["sm", "md", "lg"]
        : ["xs", "sm", "md", "lg"]
      ).includes(source[prop])
    )
      settings[prop] = source[prop];
  for (const [index, drop] of Object.entries(source.drops || {}).slice(
    0,
    100,
  )) {
    if (!/^\d+$/.test(index) || !drop || typeof drop !== "object") continue;
    settings.drops[index] = {
      ...(fontSizes.includes(drop.textSize) ? { textSize: drop.textSize } : {}),
      ...(itemSizes.includes(drop.itemSize) ? { itemSize: drop.itemSize } : {}),
      ...(drop.position === "left" || drop.position === "right"
        ? { position: drop.position }
        : {}),
      ...(Number.isSafeInteger(drop.requiredAmount) && drop.requiredAmount >= 0
        ? { requiredAmount: drop.requiredAmount }
        : {}),
    };
  }

  return settings;
}
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  return value;
}
function isDefaultStarter(item) {
  return (
    item.name === "Основная" &&
    !item.sourceKey &&
    !item.implementation &&
    !item.mobileSettings &&
    JSON.stringify(stableValue(normalizeSettings(item.settings || {}))) ===
      JSON.stringify(stableValue(normalizeSettings(defaultSettings)))
  );
}
function sourceVariants() {
  return Object.entries(bossCardVariants)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sourceKey, settings]) => ({
      id: `runtime-${sourceKey}`,
      sourceKey,
      name: sourceVariantNames[sourceKey] || sourceKey,
      cardVariant: sourceCardVariants[sourceKey] || "boss",
      settings: normalizeSettings(settings.desktop),
      mobileSettings: normalizeSettings(settings.mobile || settings.desktop),
    }));
}
function loadVariants(key) {
  const defaults = sourceVariants();
  try {
    const parsed = JSON.parse(localStorage.getItem(key));
    if (
      Array.isArray(parsed) &&
      parsed.length &&
      parsed.length <= maxStoredVariants
    ) {
      const ids = new Set();
      const loaded = parsed.map((item) => {
        if (
          typeof item.id !== "string" ||
          ids.has(item.id) ||
          typeof item.name !== "string"
        )
          throw new Error("Invalid variant");
        ids.add(item.id);
        const settings = normalizeSettings(item.settings || {});
        const implementation = validateImplementation(item.implementation);
        const sourceKey =
          typeof item.sourceKey === "string" && hasSourceVariant(item.sourceKey)
            ? item.sourceKey
            : implementation?.key && hasSourceVariant(implementation.key)
              ? implementation.key
              : undefined;
        return {
          id: item.id,
          name: item.name.slice(0, 100),
          settings,
          ...(sourceKey ? { sourceKey } : {}),
          ...(cardVariants.has(item.cardVariant)
            ? { cardVariant: item.cardVariant }
            : {}),
          ...(item.mobileSettings
            ? { mobileSettings: normalizeSettings(item.mobileSettings) }
            : {}),
          ...(implementation ? { implementation } : {}),
        };
      });
      const sourceOverrides = new Map();
      const customVariants = [];
      for (const item of loaded) {
        if (isDefaultStarter(item)) continue;
        if (item.sourceKey) {
          sourceOverrides.set(item.sourceKey, item);
          continue;
        }
        customVariants.push(item);
      }
      return defaults
        .map((item) => {
          const override = sourceOverrides.get(item.sourceKey);
          return override
            ? { ...item, ...override, id: item.id, sourceKey: item.sourceKey }
            : item;
        })
        .concat(customVariants);
    }
  } catch {
    /* An unusable local draft falls back to the source-controlled variants. */
  }
  return defaults.length ? defaults : [newVariant()];
}
function TokenSwitch({ label, value, choices, onChange, labels }) {
  const index = choices.indexOf(value);
  return (
    <div className="boss-editor-token-row">
      <CardDescription>{label}</CardDescription>
      <div className="boss-editor-inline" role="group" aria-label={label}>
        <Button
          size="sm"
          disabled={index <= 0}
          aria-label={`${label}: меньше`}
          onClick={() => onChange(choices[index - 1])}
        >
          −
        </Button>
        <MonoLabel>
          {labels?.[value] || value.replace("--space-", "")}
        </MonoLabel>
        <Button
          size="sm"
          disabled={index >= choices.length - 1}
          aria-label={`${label}: больше`}
          onClick={() => onChange(choices[index + 1])}
        >
          +
        </Button>
      </div>
    </div>
  );
}
function TextField({ id, label, value, onChange }) {
  return (
    <div className="ui-kit-entity-field">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        size="sm"
        value={value}
        maxLength={1000}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
export function BossCardEditor({ boss, raid }) {
  const referenceBoss = useBossRewardReference(boss);
  const storageKey = `madhouse.ui-kit.boss-variants.v1.${boss.id}`;
  const [variants, setVariants] = useState(() => loadVariants(storageKey));
  const [variantId, setVariantId] = useState(variants[0].id);
  const [device, setDevice] = useState("desktop");
  const [popup, setPopup] = useState(null);
  const [saveError, setSaveError] = useState(false);
  const variant = variants.find((item) => item.id === variantId) || variants[0];
  const variantIndex = variants.indexOf(variant);
  const settings = {
    ...defaultSettings,
    ...(device === "mobile"
      ? variant.mobileSettings || variant.settings
      : variant.settings),
  };
  const availableFields = raidDisplayFields(
    raid || {},
    referenceBoss,
    departmentById[boss.departmentId] || {},
  );
  const part = popup?.part || "";
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(variants));
      setSaveError(false);
    } catch {
      setSaveError(true);
    }
  }, [storageKey, variants]);
  const update = (patch) =>
    setVariants((current) =>
      current.map((item) =>
        item.id === variant.id
          ? {
              ...item,
              [device === "mobile" ? "mobileSettings" : "settings"]: {
                ...settings,
                ...patch,
              },
            }
          : item,
      ),
    );
  const open = (part, anchor, event) =>
    setPopup({
      part,
      anchor,
      point:
        event?.type === "click" && event.detail > 0
          ? { x: event.clientX, y: event.clientY }
          : undefined,
    });
  const close = () => setPopup(null);
  const dismiss = (reason) => {
    if (reason !== "outside" && popup?.anchor?.isConnected)
      popup.anchor.focus({ preventScroll: true });
    close();
  };
  const dropIndex = part.startsWith("drop:")
    ? Number(part.split(":")[1])
    : null;
  const drop = dropIndex != null ? boss.dropItems?.[dropIndex] : null;
  const dropSettings = settings.drops[dropIndex] || {};
  const updateDrop = (patch) =>
    update({
      drops: { ...settings.drops, [dropIndex]: { ...dropSettings, ...patch } },
    });
  const draftBoss = {
    ...referenceBoss,
    dropItems: boss.dropItems?.map((item, index) => {
      const override = settings.drops[index];
      return override && Object.hasOwn(override, "requiredAmount")
        ? { ...item, requiredAmount: override.requiredAmount }
        : item;
    }),
  };
  const rightBusinessItems = (draftBoss.dropItems || [])
    .map((item, index) => ({ item, index }))
    .filter(({ index }) => settings.drops[index]?.position === "right");
  const businessItemAction = rightBusinessItems.length ? (
    settings.showDrops ? (
      <div className="boss-card-business-items-right">
        {rightBusinessItems.map(({ item, index }) => (
          <BossDropItem
            key={`${item.entityId}-${index}`}
            item={item}
            index={index}
            itemOverrides={settings.drops}
            placement="right"
            loading="eager"
            onSelectItem={(selectedIndex, anchor, event) =>
              open(`drop:${selectedIndex}`, anchor, event)
            }
          />
        ))}
      </div>
    ) : (
      false
    )
  ) : undefined;
  const labels = {
    card: "Карточка",
    title: "Название",
    info: "Описание",
    portrait: "Портрет",
    drops: "Предметы бизнеса",
    action: "Кнопка",
    status: "Статус",
    availability: "Доступность босса",
    variation: "Вариация",
  };
  const toggle = (key, label) => (
    <Button
      size="sm"
      variant="toggle"
      aria-pressed={settings[key]}
      onClick={() => {
        update({ [key]: !settings[key] });
        if (part !== "card") close();
      }}
    >
      {settings[key] && <Icon type="check" size="small" />} {label}
    </Button>
  );

  return (
    <div className="ui-kit-entity-card">
      <div className="boss-editor-toolbar">
        <div
          className="boss-editor-inline"
          role="group"
          aria-label="Вариации карточки"
        >
          <Button
            size="sm"
            disabled={variantIndex === 0}
            aria-label="Предыдущая вариация"
            onClick={() => {
              setVariantId(variants[variantIndex - 1].id);
              close();
            }}
          >
            <Icon type="arrow-left" size="small" />
          </Button>
          <Button
            size="sm"
            aria-haspopup="dialog"
            onClick={(event) => open("variation", event.currentTarget, event)}
          >
            {variant.name} • {variantIndex + 1}/{variants.length}
          </Button>
          <Button
            size="sm"
            disabled={variantIndex === variants.length - 1}
            aria-label="Следующая вариация"
            onClick={() => {
              setVariantId(variants[variantIndex + 1].id);
              close();
            }}
          >
            <Icon type="arrow-right" size="small" />
          </Button>
          <Button
            size="sm"
            disabled={variants.length >= 30}
            aria-label="Создать вариацию"
            title="Создать вариацию"
            onClick={() => {
              const copy = {
                ...variant,
                id: crypto.randomUUID(),
                name: `${variant.name} • копия`,
                sourceKey: undefined,
                settings: structuredClone(variant.settings),
                ...(variant.mobileSettings
                  ? { mobileSettings: structuredClone(variant.mobileSettings) }
                  : {}),
                implementation: variant.implementation
                  ? { ...variant.implementation, key: undefined }
                  : undefined,
              };
              setVariants((current) => [...current, copy]);
              setVariantId(copy.id);
              close();
            }}
          >
            +
          </Button>
        </div>
        <div
          className="boss-editor-inline"
          role="group"
          aria-label="Версия карточки"
        >
          {[
            ["desktop", "Десктоп"],
            ["mobile", "Мобилка"],
          ].map(([value, label]) => (
            <Button
              key={value}
              size="sm"
              variant="toggle"
              aria-pressed={device === value}
              onClick={() => {
                if (value === "mobile" && !variant.mobileSettings)
                  setVariants((current) =>
                    current.map((item) =>
                      item.id === variant.id
                        ? {
                            ...item,
                            mobileSettings: structuredClone(item.settings),
                          }
                        : item,
                    ),
                  );
                setDevice(value);
                close();
              }}
            >
              {label}
            </Button>
          ))}
        </div>
        <Button
          size="sm"
          aria-haspopup="dialog"
          onClick={(event) => open("card", event.currentTarget, event)}
        >
          Отступы и элементы
        </Button>
      </div>
      {saveError && (
        <CardDescription role="status">
          Не удалось сохранить вариации в браузере.
        </CardDescription>
      )}
      <BossCardView
        boss={draftBoss}
        variant={variant.cardVariant || "floor-data"}
        title={settings.title ?? boss.name}
        cardPadding={settings.cardPadding}
        columnGap={settings.columnGap}
        contentGap={settings.contentGap}
        titleFields={settings.titleFields}
        descriptionFields={settings.descriptionFields}
        descriptionBreakBefore={settings.descriptionBreakBefore}
        titleSize={settings.titleSize}
        infoSize={settings.infoSize}
        infoText={settings.infoText}
        hasPortrait={settings.showPortrait}
        showInfo={settings.showInfo}
        showStats
        displayFields={availableFields}
        showStatus={settings.showStatus}
        showAvailability={settings.showAvailability}
        status={settings.status}
        statusSize={settings.statusSize}
        statusCompact={settings.statusCompact}
        availabilitySize={settings.availabilitySize}
        availability={settings.availability}

        showDropList={settings.showDrops}
        dropItemOverrides={settings.drops}
        action={businessItemAction ?? (settings.showAction ? undefined : false)}
        actionText={settings.actionText}
        actionSize={settings.actionSize}
        onSelectPart={open}
        imageLoading="eager"
      />
      {popup && (
        <Popover
          anchor={popup.anchor}
          point={popup.point}
          onClose={dismiss}
          label={`Настройки: ${labels[part] || "Предмет бизнеса"}`}
        >
          <div className="boss-editor-popup-heading">
            <CardTitle>{labels[part] || "Предмет бизнеса"}</CardTitle>
            <Button size="sm" onClick={dismiss} aria-label="Закрыть настройки">
              <Icon type="close" size="small" />
            </Button>
          </div>
          {part === "variation" && (
            <>
              <TextField
                id="boss-variation-name"
                label="Название вариации"
                value={variant.name}
                onChange={(name) =>
                  setVariants((current) =>
                    current.map((item) =>
                      item.id === variant.id
                        ? { ...item, name: name.slice(0, 100) }
                        : item,
                    ),
                  )
                }
              />
              <VariantExport
                editor="boss"
                entityKey={`boss:${boss.id}`}
                variant={variant}
                onChange={(implementation) =>
                  setVariants((current) =>
                    current.map((item) =>
                      item.id === variant.id
                        ? { ...item, implementation }
                        : item,
                    ),
                  )
                }
              />
              <Button
                size="sm"
                onClick={() => {
                  const sourceSettings = variant.sourceKey
                    ? bossCardVariants[variant.sourceKey]?.[device] ||
                      bossCardVariants[variant.sourceKey]?.desktop
                    : null;
                  if (sourceSettings) {
                    update({
                      ...normalizeSettings(sourceSettings),
                      title: undefined,
                      infoText: undefined,
                    });
                    return;
                  }
                  update({
                    ...defaultSettings,
                    title: undefined,
                    infoText: undefined,
                    titleFields: undefined,
                    descriptionFields: undefined,
                    drops: {},
                  });
                }}
              >
                Сбросить свойства
              </Button>
              <Button
                size="sm"
                disabled={variants.length === 1 || Boolean(variant.sourceKey)}
                onClick={() => {
                  const next = variants.filter(
                    (item) => item.id !== variant.id,
                  );
                  setVariants(next);
                  setVariantId(next[0].id);
                  close();
                }}
              >
                Удалить вариацию
              </Button>
            </>
          )}
          {part === "card" && (
            <>
              <TokenSwitch
                label="Внутри карточки"
                value={settings.cardPadding}
                choices={spacingSizes}
                onChange={(cardPadding) => update({ cardPadding })}
              />
              <TokenSwitch
                label="Между колонками"
                value={settings.columnGap}
                choices={spacingSizes}
                onChange={(columnGap) => update({ columnGap })}
              />
              <TokenSwitch
                label="Между строками"
                value={settings.contentGap}
                choices={spacingSizes}
                onChange={(contentGap) => update({ contentGap })}
              />
              <div className="boss-editor-visibility">
                {toggle("showPortrait", "Портрет")}
                {toggle("showInfo", "Описание")}
                {toggle("showDrops", "Дроп")}
                {toggle("showAction", "Кнопка")}
                {toggle("showStatus", "Статус")}
                {toggle("showAvailability", "Доступность")}
              </div>
            </>
          )}
          {part === "title" && (
            <>
              <DisplayFieldPicker
                fields={availableFields}
                selected={settings.titleFields ?? ["name"]}
                onChange={(titleFields) =>
                  update({ titleFields, title: undefined })
                }
              />
              <TokenSwitch
                label="Размер текста"
                value={settings.titleSize}
                choices={fontSizes}
                onChange={(titleSize) => update({ titleSize })}
              />
            </>
          )}
          {part === "info" && (
            <>
              <DisplayFieldPicker
                fields={availableFields}
                breakBefore={settings.descriptionBreakBefore}
                onBreakChange={(descriptionBreakBefore) =>
                  update({ descriptionBreakBefore })
                }
                selected={
                  settings.descriptionFields ?? ["accessLevel", "hp", "damage"]
                }
                onChange={(descriptionFields) =>
                  update({ descriptionFields, infoText: undefined })
                }
              />
              <TokenSwitch
                label="Размер текста"
                value={settings.infoSize}
                choices={fontSizes}
                onChange={(infoSize) => update({ infoSize })}
              />
              {toggle("showInfo", "Описание")}
            </>
          )}
          {part === "status" && (
            <>
              <TokenSwitch
                label="Размер"
                value={settings.statusSize}
                choices={["xs", "sm", "md", "lg"]}
                onChange={(statusSize) => update({ statusSize })}
              />
              <TokenSwitch
                label="Статус"
                value={settings.status}
                choices={["scheduled", "active", "completed"]}
                labels={{
                  scheduled: "Запланирован",
                  active: "Идёт",
                  completed: "Завершён",
                }}
                onChange={(status) => update({ status })}
              />
              {toggle("statusCompact", "Компактный — только точка")}
              {toggle("showStatus", "Показывать статус")}
            </>
          )}
          {part === "availability" && (
            <>
              <TokenSwitch
                label="Размер"
                value={settings.availabilitySize}
                choices={["xs", "sm", "md", "lg"]}
                onChange={(availabilitySize) => update({ availabilitySize })}
              />
              {toggle("showAvailability", "Показывать доступность")}
            </>
          )}
          {part === "portrait" && toggle("showPortrait", "Портрет")}
          {part === "drops" && toggle("showDrops", "Предметы бизнеса")}
          {drop && (
            <>
              <TokenSwitch
                label="Положение предмета бизнеса"
                value={dropSettings.position ?? "left"}
                choices={["left", "right"]}
                labels={{ left: "Слева", right: "Справа" }}
                onChange={(position) => updateDrop({ position })}
              />
              <NumberField
                id="boss-business-item-amount"
                label="Количество предмета бизнеса"
                size="sm"
                min="0"
                step="1"
                suffix="шт."
                value={dropSettings.requiredAmount ?? drop.requiredAmount ?? ""}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === "") {
                    updateDrop({ requiredAmount: undefined });
                    return;
                  }
                  const requiredAmount = Number(value);
                  if (
                    Number.isSafeInteger(requiredAmount) &&
                    requiredAmount >= 0
                  )
                    updateDrop({ requiredAmount });
                }}
              />
              <TokenSwitch
                label="Размер текста"
                value={dropSettings.textSize ?? "sm"}
                choices={fontSizes}
                onChange={(textSize) => updateDrop({ textSize })}
              />
              <TokenSwitch
                label="Размер карточки предмета"
                value={
                  dropSettings.itemSize ??
                  (dropSettings.position === "right"
                    ? "--space-64"
                    : "--space-32")
                }
                choices={itemSizes}
                onChange={(itemSize) => updateDrop({ itemSize })}
              />
            </>
          )}
          {part === "action" && (
            <>
              <TextField
                id="boss-action-text"
                label="Текст кнопки"
                value={settings.actionText}
                onChange={(actionText) => update({ actionText })}
              />
              <TokenSwitch
                label="Размер кнопки"
                value={settings.actionSize}
                choices={["sm", "md", "lg"]}
                onChange={(actionSize) => update({ actionSize })}
              />
              {toggle("showAction", "Кнопка")}
            </>
          )}
        </Popover>
      )}
    </div>
  );
}
