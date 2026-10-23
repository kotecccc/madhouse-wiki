import {
  BLOCK_SECTIONS,
  BLOCK_SECTION_LABELS,
} from "../../lib/block-sections.js";
import { VariantExport } from "./VariantExport.jsx";
import { DisplayFieldPicker } from "./DisplayFieldPicker.jsx";
import { useEffect, useId, useState } from "react";
import { CardEditingContext } from "../../components/ui/CardEditing/CardEditing.jsx";
import { Button } from "../../components/ui/Button/Button.jsx";
import { CardTitle } from "../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../components/ui/CardDescription/CardDescription.jsx";
import { Icon } from "../../components/ui/Icon/Icon.jsx";
import { FieldLabel } from "../../components/ui/FieldLabel/FieldLabel.jsx";
import { Input } from "../../components/ui/Input/Input.jsx";
import { MonoLabel } from "../../components/ui/MonoLabel/MonoLabel.jsx";
import { Popover } from "../../components/ui/Popover/Popover.jsx";
import {
  FONT_SIZES,
  SPACES,
  IMAGE_SIZES,
  BUTTON_VARIANTS,
  STATUSES,
  loadVariations,
  patchVariation,
} from "./entity-variants.js";
import "./EntityCardEditor.css";

function Tokens({ label, value, choices, onChange }) {
  const index = choices.indexOf(value);
  return (
    <div className="entity-editor-token">
      <CardDescription>{label}</CardDescription>
      <div className="entity-editor-inline" role="group" aria-label={label}>
        <Button
          size="sm"
          aria-label={`${label}: меньше`}
          disabled={index === 0}
          onClick={() => onChange(choices[index < 0 ? 0 : index - 1])}
        >
          −
        </Button>
        <MonoLabel>
          {String(value ?? "По умолчанию")
            .replace("var(--space-", "")
            .replace(")", "")}
        </MonoLabel>
        <Button
          size="sm"
          aria-label={`${label}: больше`}
          disabled={index === choices.length - 1}
          onClick={() => onChange(choices[index < 0 ? 0 : index + 1])}
        >
          +
        </Button>
      </div>
    </div>
  );
}
function TextField({ label, value, onChange }) {
  const id = useId();
  return (
    <div className="entity-editor-field">
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
const kindLabels = {
  card: "Карточка",
  block: "Состав блока",
  title: "Название",
  description: "Описание",
  heading: "Заголовок",
  image: "Изображение",
  button: "Кнопка",
  pill: "Статус",
  text: "Значение",
};
export function EntityCardEditor({ entityKey, children, componentProps }) {
  const storageKey = `madhouse.ui-kit.entity-variants.v1.${entityKey}`;
  const [variants, setVariants] = useState(() => loadVariations(storageKey));
  const [variantId, setVariantId] = useState(variants[0].id);
  const [surface, setSurface] = useState("desktop");
  const [isEditing, setIsEditing] = useState(true);
  const [popup, setPopup] = useState(null);
  const [saveError, setSaveError] = useState(false);
  const variant = variants.find((item) => item.id === variantId) || variants[0];
  const index = variants.indexOf(variant);
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(variants));
      setSaveError(false);
    } catch {
      setSaveError(true);
    }
  }, [storageKey, variants]);
  function dismiss(reason) {
    if (reason !== "outside" && popup?.anchor?.isConnected)
      popup.anchor.focus({ preventScroll: true });
    setPopup(null);
  }
  const fields =
    surface === "mobile"
      ? variant.mobileFields || variant.fields
      : variant.fields;
  const values = { ...popup?.defaults, ...fields[popup?.key]?.props };
  const change = (patch) =>
    setVariants((current) =>
      patchVariation(
        current,
        variant.id,
        popup.key,
        popup.kind,
        patch,
        surface,
      ),
    );
  function select(next) {
    setVariantId(next);
    setPopup(null);
  }
  return (
    <div className="entity-editor">
      <div
        className="entity-editor-inline"
        role="group"
        aria-label="Представление карточки"
      >
        <Button
          size="sm"
          variant="toggle"
          aria-pressed={!isEditing}
          title="Переключить между настройками и рабочей карточкой"
          onClick={() => {
            setIsEditing((value) => !value);
            setPopup(null);
          }}
        >
          Просмотр
        </Button>
        <Button
          size="sm"
          variant="toggle"
          aria-pressed={surface === "desktop"}
          onClick={() => {
            setPopup(null);
            setSurface("desktop");
          }}
        >
          Десктоп
        </Button>
        <Button
          size="sm"
          variant="toggle"
          aria-pressed={surface === "mobile"}
          onClick={() => {
            setPopup(null);
            if (!variant.mobileFields) {
              setVariants((current) =>
                current.map((item) =>
                  item.id === variant.id
                    ? { ...item, mobileFields: { ...item.fields } }
                    : item,
                ),
              );
            }
            setSurface("mobile");
          }}
        >
          Мобилка
        </Button>
      </div>
      <div
        className="entity-editor-inline"
        role="group"
        aria-label="Вариации карточки"
      >
        <Button
          size="sm"
          disabled={index === 0}
          aria-label="Предыдущая вариация"
          onClick={() => select(variants[index - 1].id)}
        >
          <Icon type="arrow-left" size="small" />
        </Button>
        <Button
          size="sm"
          aria-haspopup="dialog"
          onClick={(event) =>
            setPopup({
              kind: "variation",
              anchor: event.currentTarget,
              point:
                event.detail > 0
                  ? { x: event.clientX, y: event.clientY }
                  : undefined,
            })
          }
        >
          {variant.name} • {index + 1}/{variants.length}
        </Button>
        <Button
          size="sm"
          disabled={index === variants.length - 1}
          aria-label="Следующая вариация"
          onClick={() => select(variants[index + 1].id)}
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
              name: `${variant.name} • копия`.slice(0, 100),
              fields: { ...variant.fields },
              ...(variant.mobileFields
                ? { mobileFields: { ...variant.mobileFields } }
                : {}),
              implementation: variant.implementation
                ? { ...variant.implementation, key: undefined }
                : undefined,
            };
            setVariants((current) => [...current, copy]);
            select(copy.id);
          }}
        >
          +
        </Button>
      </div>
      {saveError && (
        <CardDescription role="status">
          Не удалось сохранить вариации в браузере.
        </CardDescription>
      )}
      <CardEditingContext.Provider
        value={{
          scope: entityKey,
          fields,
          open: setPopup,
          readOnly: !isEditing,
        }}
      >
        {children}
      </CardEditingContext.Provider>
      {popup && (
        <Popover
          anchor={popup.anchor}
          point={popup.point}
          onClose={dismiss}
          label={`Настройки: ${kindLabels[popup.kind] || "Вариация"}`}
        >
          <div className="entity-editor-token">
            <CardTitle>{kindLabels[popup.kind] || "Вариация"}</CardTitle>
            <Button size="sm" aria-label="Закрыть настройки" onClick={dismiss}>
              <Icon type="close" size="small" />
            </Button>
          </div>
          {popup.kind === "variation" ? (
            <>
              <TextField
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
                editor="entity"
                entityKey={entityKey}
                variant={{
                  ...variant,
                  ...(componentProps ? { componentProps } : {}),
                }}
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
                onClick={() =>
                  setVariants((current) =>
                    current.map((item) =>
                      item.id === variant.id
                        ? surface === "mobile"
                          ? { ...item, mobileFields: {} }
                          : { ...item, fields: {} }
                        : item,
                    ),
                  )
                }
              >
                Сбросить свойства
              </Button>
              <Button
                size="sm"
                disabled={variants.length === 1}
                onClick={() => {
                  const next = variants.filter(
                    (item) => item.id !== variant.id,
                  );
                  setVariants(next);
                  select(next[0].id);
                }}
              >
                Удалить вариацию
              </Button>
            </>
          ) : (
            <>
              {popup.kind === "block" &&
                (values.sectionOrder || BLOCK_SECTIONS).map(
                  (key, index, order) => (
                    <div key={key} className="entity-editor-token">
                      <Button
                        size="sm"
                        variant="toggle"
                        aria-pressed={!values.hiddenSections?.includes(key)}
                        onClick={() =>
                          change({
                            hiddenSections: values.hiddenSections?.includes(key)
                              ? values.hiddenSections.filter(
                                  (item) => item !== key,
                                )
                              : [...(values.hiddenSections || []), key],
                          })
                        }
                      >
                        {BLOCK_SECTION_LABELS[key]}
                      </Button>
                      <div className="entity-editor-inline">
                        <Button
                          size="sm"
                          disabled={index === 0}
                          aria-label={`${BLOCK_SECTION_LABELS[key]}: выше`}
                          onClick={() => {
                            const next = [...order];
                            [next[index - 1], next[index]] = [
                              next[index],
                              next[index - 1],
                            ];
                            change({ sectionOrder: next });
                          }}
                        >
                          <Icon type="arrow-up" size="small" />
                        </Button>
                        <Button
                          size="sm"
                          disabled={index === order.length - 1}
                          aria-label={`${BLOCK_SECTION_LABELS[key]}: ниже`}
                          onClick={() => {
                            const next = [...order];
                            [next[index + 1], next[index]] = [
                              next[index],
                              next[index + 1],
                            ];
                            change({ sectionOrder: next });
                          }}
                        >
                          <Icon type="arrow-down" size="small" />
                        </Button>
                      </div>
                    </div>
                  ),
                )}
              {popup.composition && (
                <DisplayFieldPicker
                  key={popup.key}
                  fields={popup.composition.fields}
                  breakBefore={values.breakBefore || []}
                  onBreakChange={
                    popup.kind === "description"
                      ? (breakBefore) => change({ breakBefore })
                      : undefined
                  }
                  selected={
                    values.displayFields ?? popup.composition.defaultFields
                  }
                  onChange={(displayFields) => change({ displayFields })}
                />
              )}
              {!popup.composition && "text" in values && (
                <TextField
                  label="Текст"
                  value={values.text}
                  onChange={(text) => change({ text })}
                />
              )}
              {["title", "description"].includes(popup.kind) && (
                <Tokens
                  label="Размер текста"
                  value={values.size}
                  choices={FONT_SIZES}
                  onChange={(size) => change({ size })}
                />
              )}
              {popup.kind === "heading" && (
                <Tokens
                  label="Уровень заголовка"
                  value={values.level}
                  choices={["h6", "h5", "h4", "h3", "h2", "h1"]}
                  onChange={(level) => change({ level })}
                />
              )}
              {popup.kind === "card" && (
                <>
                  <Tokens
                    label="Внутри карточки"
                    value={values.padding}
                    choices={SPACES}
                    onChange={(padding) => change({ padding })}
                  />
                  <Tokens
                    label="Между элементами"
                    value={values.gap}
                    choices={SPACES}
                    onChange={(gap) => change({ gap })}
                  />
                </>
              )}
              {popup.kind === "image" && (
                <>
                  <Tokens
                    label="Размер блока"
                    value={values.size}
                    choices={IMAGE_SIZES}
                    onChange={(size) => change({ size })}
                  />
                  <Tokens
                    label="Размер картинки"
                    value={values.imageSize}
                    choices={IMAGE_SIZES}
                    onChange={(imageSize) => change({ imageSize })}
                  />
                </>
              )}
              {popup.kind === "button" && (
                <>
                  <Tokens
                    label="Размер кнопки"
                    value={values.size}
                    choices={["sm", "md", "lg"]}
                    onChange={(size) => change({ size })}
                  />
                  <Tokens
                    label="Вариант"
                    value={values.variant}
                    choices={BUTTON_VARIANTS}
                    onChange={(variant) => change({ variant })}
                  />
                </>
              )}
              {popup.kind === "pill" && (
                <>
                  <Tokens
                    label="Размер статуса"
                    value={values.size}
                    choices={["xs", "sm", "md", "lg"]}
                    onChange={(size) => change({ size })}
                  />
                  <Tokens
                    label="Статус"
                    value={values.variant}
                    choices={STATUSES}
                    onChange={(variant) => change({ variant })}
                  />
                  <Button
                    size="sm"
                    variant="toggle"
                    aria-pressed={values.dot}
                    onClick={() => change({ dot: !values.dot })}
                  >
                    Индикатор
                  </Button>
                </>
              )}
              <Button
                size="sm"
                onClick={() =>
                  setVariants((current) =>
                    current.map((item) => {
                      if (item.id !== variant.id) return item;
                      const currentFields = {
                        ...(surface === "mobile"
                          ? item.mobileFields || item.fields
                          : item.fields),
                      };
                      delete currentFields[popup.key];
                      return surface === "mobile"
                        ? { ...item, mobileFields: currentFields }
                        : { ...item, fields: currentFields };
                    }),
                  )
                }
              >
                Сбросить элемент
              </Button>
            </>
          )}
        </Popover>
      )}
    </div>
  );
}
