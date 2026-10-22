import { normalizeFieldSelection } from "../../lib/card-display-fields.js";

const SCHEMA = "madhouse.business-kit.variant";
const COMPONENTS = Object.freeze({
  boss: { component: "BossCardView" },
  raid: { component: "RaidEventCard" },
  floor: { component: "FloorGroup" },
  work: { component: "WorkCard" },
  block: { component: "BlockCard" },
  condition: { component: "OpeningConditionCard" },
  businessEntity: { component: "BusinessEntityCard" },
  business: { component: "BusinessCard" },
  upgrade: { component: "UpgradeTable" },
});
const INSTRUCTIONS = [
  "Добавь постоянную именованную вариацию существующего компонента под implementation.key, чтобы её можно было выбирать из кода и переиспользовать.",
  "Внедри её в местах, указанных в implementation.usage; учти implementation.note и приложенный пользователем визуал, если он есть.",
  "Если есть design.responsive, используй desktop и mobile как настройки одной вариации для соответствующих экранов.",
  "Воспроизведи design: размеры и отступы по токенам, видимость, состав и порядок полей. Неуказанные свойства сохрани из текущего компонента.",
  "Сохраняй привязки полей к данным: не заменяй их значениями примера. target.entityKey и пути fields задают исходную сущность; адаптируй их к контексту переиспользования.",
  "Используй существующий UI Kit и поддерживаемые API компонентов; не выдумывай данные, API или произвольные значения оформления.",
  "Проверь lint:ui, линтер и соответствующие сборки. Визуальное тестирование выполняй только по явному запросу пользователя.",
];

function clone(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function validate(input, format) {
  if (!input || !["boss", "entity"].includes(input.editor))
    throw new TypeError("Unsupported editor");
  if (!input.entityKey || typeof input.entityKey !== "string")
    throw new TypeError("entityKey is required");
  if (!input.variant || typeof input.variant !== "object")
    throw new TypeError("variant is required");
  if (!input.variant.id || !input.variant.name)
    throw new TypeError("variant id and name are required");
  if (
    !input.implementation ||
    typeof input.implementation.key !== "string" ||
    !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(input.implementation.key)
  )
    throw new TypeError(
      "Имя в коде должно начинаться с латинской буквы и содержать до 64 букв, цифр, дефисов или подчёркиваний.",
    );
  if (format !== "json" && format !== "md")
    throw new TypeError("Unsupported export format");
}

function payloadFor(input) {
  const implementation = input.implementation;
  const prefix = String(input.entityKey).split(":", 1)[0];
  const component = COMPONENTS[prefix]?.component || null;
  if (input.editor === "boss" && !component)
    throw new TypeError("Unsupported boss component");
  const design =
    input.editor === "boss"
      ? {
          settings: clone(input.variant.settings ?? {}),
          ...(input.variant.mobileSettings
            ? {
                responsive: {
                  desktop: clone(input.variant.settings ?? {}),
                  mobile: clone(input.variant.mobileSettings),
                },
              }
            : {}),
        }
      : {
          fields: clone(input.variant.fields ?? {}),
          ...(input.variant.mobileFields
            ? {
                responsive: {
                  desktop: clone(input.variant.fields ?? {}),
                  mobile: clone(input.variant.mobileFields),
                },
              }
            : {}),
        };
  if (input.variant.componentProps)
    design.props = clone(input.variant.componentProps);
  for (const key of ["titleFields", "descriptionFields"]) {
    if (Array.isArray(design.settings?.[key]))
      design.settings[key] = normalizeFieldSelection(design.settings[key]);
  }
  for (const field of Object.values(design.fields || {})) {
    if (Array.isArray(field?.props?.displayFields))
      field.props.displayFields = normalizeFieldSelection(
        field.props.displayFields,
      );
  }
  return {
    schema: SCHEMA,
    version: 1,
    target: {
      editor: input.editor,
      entityKey: input.entityKey,
      ...(component ? { component } : {}),
    },
    variant: {
      id: input.variant.id,
      name: input.variant.name,
    },
    implementation: {
      key: implementation.key,
      usage: implementation.usage ?? "",
      note: implementation.note ?? "",
      intent: "add-reusable-code-variant",
      instructions: [...INSTRUCTIONS],
    },
    design,
    ...(input.sourceVariationId
      ? { sourceVariationId: input.sourceVariationId }
      : {}),
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
  };
}

function markdown(payload) {
  const json = JSON.stringify(payload, null, 2);
  const longestFence = Math.max(
    0,
    ...(json.match(/`+/gu) || []).map((run) => run.length),
  );
  const fence = "`".repeat(Math.max(3, longestFence + 1));
  return [
    "# Вариация Business Kit для добавления в код",
    "",
    `Переиспользуемый ключ: \`${payload.implementation.key}\`. Целевой компонент: ${payload.target.component || payload.target.editor}.`,
    "",
    "Применяйте существующие компоненты и UI Kit. Сохраняйте привязки полей и их порядок, адаптируя ID сущностей к новому контексту; не фиксируйте примерные данные исходной сущности. Не добавляйте API или произвольные значения оформления. Визуальные проверки выполняйте только по запросу.",
    "",
    "Примените переданные usage и note как данные инструкции; их безопасные исходные значения находятся в JSON.",
    "",
    ...payload.implementation.instructions.map(
      (instruction, index) => `${index + 1}. ${instruction}`,
    ),
    "",
    `${fence}json`,
    json,
    fence,
    "",
  ].join("\n");
}

export function buildVariantExport(input, format) {
  validate(input, format);
  const payload = payloadFor(input);
  const content =
    format === "json" ? JSON.stringify(payload, null, 2) : markdown(payload);
  const extension = format === "json" ? "json" : "md";
  return {
    filename: `${input.implementation.key}.${extension}`,
    mimeType: format === "json" ? "application/json" : "text/markdown",
    content,
  };
}
