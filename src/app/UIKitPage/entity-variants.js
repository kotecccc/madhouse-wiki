import { normalizeBlockSections } from "../../lib/block-sections.js";
import { normalizeFieldSelection } from "../../lib/card-display-fields.js";
export const FONT_SIZES = [
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
export const SPACES = ["4", "8", "12", "16", "24", "32", "40", "48", "64"];
export const IMAGE_SIZES = SPACES.map((size) => `var(--space-${size})`);
export const BUTTON_VARIANTS = [
  "primary",
  "secondary",
  "card-action",
  "toggle",
  "nav-tab",
  "icon-copy",
  "icon-copy-inline",
];
export const STATUSES = [
  "scheduled",
  "active",
  "completed",
  "locked",
  "warning",
  "unknown",
];
export function validateImplementation(value) {
  if (!value || typeof value !== "object") return undefined;
  const implementation = {};
  for (const [key, limit] of [
    ["key", 64],
    ["usage", 1000],
    ["note", 2000],
  ]) {
    if (typeof value[key] === "string")
      implementation[key] = value[key].slice(0, limit);
  }
  return implementation;
}
export function createVariation() {
  return { id: crypto.randomUUID(), name: "Основная", fields: {} };
}
function validateFields(source) {
  const fields = {};
  for (const [key, field] of Object.entries(source || {}).slice(0, 1000)) {
    if (
      !field ||
      typeof field !== "object" ||
      ![
        "card",
        "block",
        "title",
        "description",
        "heading",
        "button",
        "image",
        "pill",
        "text",
      ].includes(field.kind)
    )
      continue;
    const props = {};
    if (field.kind === "block") {
      props.sectionOrder = normalizeBlockSections(
        field.props?.sectionOrder,
        true,
      );
      props.hiddenSections = normalizeBlockSections(
        field.props?.hiddenSections,
      );
    }
    const selection = normalizeFieldSelection(field.props?.displayFields);
    if (selection) props.displayFields = selection;
    const breakBefore = normalizeFieldSelection(field.props?.breakBefore);
    if (field.kind === "description" && breakBefore)
      props.breakBefore = breakBefore;
    if (typeof field.props?.text === "string")
      props.text = field.props.text.slice(0, 1000);
    const enums = {
      padding: SPACES,
      gap: SPACES,
      size:
        field.kind === "image"
          ? IMAGE_SIZES
          : field.kind === "button"
            ? ["sm", "md", "lg"]
            : field.kind === "pill"
              ? ["xs", "sm", "md", "lg"]
              : FONT_SIZES,
      imageSize: IMAGE_SIZES,
      level: ["h1", "h2", "h3", "h4", "h5", "h6"],
      variant: field.kind === "button" ? BUTTON_VARIANTS : STATUSES,
    };
    for (const [prop, allowed] of Object.entries(enums))
      if (allowed.includes(field.props?.[prop]))
        props[prop] = field.props[prop];
    if (typeof field.props?.dot === "boolean") props.dot = field.props.dot;
    fields[key] = { kind: field.kind, props };
  }
  return fields;
}
export function validateVariations(parsed) {
  if (!Array.isArray(parsed) || !parsed.length || parsed.length > 30)
    throw new Error("Некорректные вариации");
  const ids = new Set();
  return parsed.map((item) => {
    if (
      !item ||
      typeof item.id !== "string" ||
      ids.has(item.id) ||
      typeof item.name !== "string"
    )
      throw new Error("Некорректная вариация");
    ids.add(item.id);
    const fields = validateFields(item.fields);
    const mobileFields = item.mobileFields
      ? validateFields(item.mobileFields)
      : undefined;
    const implementation = validateImplementation(item.implementation);
    return {
      id: item.id,
      name: item.name.slice(0, 100),
      fields,
      ...(mobileFields ? { mobileFields } : {}),
      ...(implementation ? { implementation } : {}),
    };
  });
}
export function loadVariations(key) {
  try {
    const saved = localStorage.getItem(key);
    if (saved && saved.length <= 1000000)
      return validateVariations(JSON.parse(saved));
  } catch {
    /* Ignore an unavailable or invalid local draft. */
  }
  return [createVariation()];
}
export function patchVariation(
  variants,
  id,
  key,
  kind,
  patch,
  surface = "desktop",
) {
  return variants.map((item) =>
    item.id === id
      ? {
          ...item,
          ...(surface === "mobile"
            ? { mobileFields: item.mobileFields || { ...item.fields } }
            : {}),
          [surface === "mobile" ? "mobileFields" : "fields"]: {
            ...(surface === "mobile"
              ? item.mobileFields || item.fields
              : item.fields),
            [key]: {
              kind,
              props: {
                ...(surface === "mobile"
                  ? (item.mobileFields || item.fields)[key]?.props
                  : item.fields[key]?.props),
                ...patch,
              },
            },
          },
        }
      : item,
  );
}
