import test from "node:test";
import assert from "node:assert/strict";
import {
  createVariation,
  validateVariations,
  patchVariation,
} from "./entity-variants.js";

test("edits are scoped to an entity field and a single variation", () => {
  const a = createVariation();
  const b = { ...createVariation(), fields: { ...a.fields } };
  const source = [a, b];
  const edited = patchVariation(
    source,
    a.id,
    "floor:A/department:A1/title",
    "title",
    { text: "Первый", size: "sm" },
  );
  assert.deepEqual(edited[0].fields["floor:A/department:A1/title"].props, {
    text: "Первый",
    size: "sm",
  });
  assert.equal(edited[0].fields["floor:A/department:A2/title"], undefined);
  assert.deepEqual(edited[1].fields, {});
  assert.deepEqual(source[0].fields, {});
});

test("mobile fields are sanitized and edited independently from desktop fields", () => {
  const variation = createVariation();
  variation.fields = {
    title: { kind: "title", props: { text: "Desktop", size: "md" } },
  };
  variation.mobileFields = {
    title: { kind: "title", props: { text: "Mobile", size: "sm" } },
    unsafe: { kind: "html", props: { text: "ignored" } },
  };
  const loaded = validateVariations(JSON.parse(JSON.stringify([variation])));
  assert.deepEqual(loaded[0].mobileFields, {
    title: { kind: "title", props: { text: "Mobile", size: "sm" } },
  });

  const updated = patchVariation(
    loaded,
    variation.id,
    "title",
    "title",
    { text: "Mobile edit" },
    "mobile",
  );
  assert.equal(updated[0].mobileFields.title.props.text, "Mobile edit");
  assert.equal(updated[0].fields.title.props.text, "Desktop");
});

test("copying a variation does not share mutable field edits", () => {
  const original = {
    ...createVariation(),
    fields: {
      "business:1/title": { kind: "title", props: { text: "Исходный" } },
    },
  };
  const copy = {
    ...original,
    id: crypto.randomUUID(),
    fields: { ...original.fields },
  };
  const updated = patchVariation(
    [original, copy],
    copy.id,
    "business:1/title",
    "title",
    { text: "Копия" },
  );
  assert.equal(updated[0].fields["business:1/title"].props.text, "Исходный");
  assert.equal(updated[1].fields["business:1/title"].props.text, "Копия");
});

test("JSON round trip retains valid typography, spacing and per-cell overrides", () => {
  let variants = [createVariation()];
  const id = variants[0].id;
  variants = patchVariation(variants, id, "raid/card", "card", {
    padding: "24",
    gap: "12",
  });
  variants = patchVariation(variants, id, "upgrade/item:1:level:2", "text", {
    text: "125",
  });
  assert.deepEqual(
    validateVariations(JSON.parse(JSON.stringify(variants))),
    variants,
  );
});

test("saved drafts filter unknown fields, props and unsupported visual values", () => {
  const variation = createVariation();
  variation.fields = {
    unsafe: { kind: "html", props: { text: "ignored" } },
    title: {
      kind: "title",
      props: {
        text: "Hello",
        size: "15px",
        style: { color: "red" },
        onClick: "code",
      },
    },
    image: {
      kind: "image",
      props: { size: "123px", imageSize: "var(--space-32)" },
    },
  };
  const restored = validateVariations([variation])[0];
  assert.equal(restored.fields.unsafe, undefined);
  assert.deepEqual(restored.fields.title.props, { text: "Hello" });
  assert.deepEqual(restored.fields.image.props, {
    imageSize: "var(--space-32)",
  });
});

test("invalid and duplicate variation identities are rejected", () => {
  const variation = createVariation();
  assert.throws(() => validateVariations([]));
  assert.throws(() => validateVariations([variation, variation]));
  assert.throws(() => validateVariations([{ ...variation, name: null }]));
});

test("field composition order survives saving, copying and reloading", () => {
  const original = createVariation();
  const edited = patchVariation(
    [original],
    original.id,
    "raid/title",
    "title",
    { displayFields: ["block", "name"] },
  );
  const copied = {
    ...edited[0],
    id: crypto.randomUUID(),
    fields: { ...edited[0].fields },
  };
  const updated = patchVariation(
    [edited[0], copied],
    copied.id,
    "raid/title",
    "title",
    { displayFields: ["name"] },
  );
  const restored = validateVariations(JSON.parse(JSON.stringify(updated)));
  assert.deepEqual(restored[0].fields["raid/title"].props.displayFields, [
    "block",
    "name",
  ]);
  assert.deepEqual(restored[1].fields["raid/title"].props.displayFields, [
    "name",
  ]);
});

test("old drafts keep their text and absent composition differs from an empty selection", () => {
  const variant = createVariation();
  variant.fields = {
    old: { kind: "title", props: { text: "Ранее введённый текст" } },
    empty: { kind: "description", props: { displayFields: [] } },
  };
  const restored = validateVariations([variant])[0];
  assert.deepEqual(restored.fields.old.props, {
    text: "Ранее введённый текст",
  });
  assert.deepEqual(restored.fields.empty.props, { displayFields: [] });
});

test("implementation instructions survive local saving and reject unrelated data", () => {
  const variant = createVariation();
  variant.implementation = {
    key: "floor-compact",
    usage: "В блоке этажа",
    note: "Сохранять порядок полей",
    unknown: "ignored",
  };
  const restored = validateVariations(JSON.parse(JSON.stringify([variant])))[0];
  assert.deepEqual(restored.implementation, {
    key: "floor-compact",
    usage: "В блоке этажа",
    note: "Сохранять порядок полей",
  });
  assert.deepEqual(restored.fields, {});
});

test("block section order and visibility survive independent mobile saving", () => {
  const saved = validateVariations([
    {
      id: "block-v1",
      name: "Block",
      fields: {
        "block:A/sections": {
          kind: "block",
          props: {
            sectionOrder: ["bosses", "works", "bosses", "invalid"],
            hiddenSections: ["businesses", "invalid"],
          },
        },
      },
      mobileFields: {
        "block:A/sections": {
          kind: "block",
          props: { sectionOrder: ["works"], hiddenSections: ["bosses"] },
        },
      },
    },
  ]);
  assert.deepEqual(saved[0].fields["block:A/sections"].props.sectionOrder, [
    "bosses",
    "works",
    "requirements",
    "businesses",
  ]);
  assert.deepEqual(saved[0].fields["block:A/sections"].props.hiddenSections, [
    "businesses",
  ]);
  assert.deepEqual(
    saved[0].mobileFields["block:A/sections"].props.hiddenSections,
    ["bosses"],
  );
});
