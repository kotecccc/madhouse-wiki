import test from "node:test";
import assert from "node:assert/strict";
import { buildVariantExport } from "./variant-export.js";

const bossInput = () => ({
  editor: "boss",
  entityKey: "boss:oswald",
  variant: {
    id: "variation-uuid",
    name: "Compact raid",
    settings: {
      titleFields: ["block", "name"],
      descriptionFields: ["accessLevel"],
      cardPadding: "8",
    },
  },
  implementation: {
    key: "compact-raid",
    usage: "Use on raid cards",
    note: "Source note",
  },
  createdAt: "2026-10-22T12:00:00Z",
});

test("boss export has versioned schema, component target, and exact settings", () => {
  const result = buildVariantExport(bossInput(), "json");
  const payload = JSON.parse(result.content);
  assert.equal(result.filename, "compact-raid.json");
  assert.equal(result.mimeType, "application/json");
  assert.equal(payload.schema, "madhouse.business-kit.variant");
  assert.equal(payload.version, 1);
  assert.deepEqual(payload.target, {
    editor: "boss",
    entityKey: "boss:oswald",
    component: "BossCardView",
  });
  assert.deepEqual(payload.design.settings, bossInput().variant.settings);
  assert.equal(payload.sourceVariationId, undefined);
  assert.equal(payload.createdAt, "2026-10-22T12:00:00Z");
});

test("entity export keeps field order and nested data without mutating input", () => {
  const input = {
    editor: "entity",
    entityKey: "floor:A",
    variant: {
      id: "v1",
      name: "Floor ordered",
      fields: {
        "floor:A/department:A1/title": {
          kind: "title",
          props: { displayFields: ["block", "name"], size: "sm" },
        },
      },
    },
    implementation: { key: "floor-order", usage: "Apply fields", note: "" },
    sourceVariationId: "source-v1",
  };
  const before = structuredClone(input);
  const payload = JSON.parse(buildVariantExport(input, "json").content);
  assert.deepEqual(payload.design.fields, input.variant.fields);
  assert.deepEqual(payload.target, {
    editor: "entity",
    entityKey: "floor:A",
    component: "FloorGroup",
  });
  assert.equal(payload.sourceVariationId, "source-v1");
  assert.deepEqual(input, before);
});

test("markdown embeds the same payload using a safe fence", () => {
  const input = bossInput();
  input.implementation.note = "Contains ```json and ````";
  const md = buildVariantExport(input, "md");
  assert.equal(md.filename, "compact-raid.md");
  assert.equal(md.mimeType, "text/markdown");
  const match = md.content.match(/(`{5})json\n([\s\S]*?)\n\1/u);
  assert.ok(match);
  assert.deepEqual(
    JSON.parse(match[2]),
    JSON.parse(buildVariantExport(input, "json").content),
  );
  assert.match(md.content, /Сохраняйте привязки полей и их порядок/u);
});

test("all known entity prefixes map to their reusable components", () => {
  const components = {
    raid: "RaidEventCard",
    floor: "FloorGroup",
    business: "BusinessCard",
    upgrade: "UpgradeTable",
  };
  for (const [prefix, component] of Object.entries(components)) {
    const input = {
      ...bossInput(),
      editor: "entity",
      entityKey: `${prefix}:x`,
    };
    assert.equal(
      JSON.parse(buildVariantExport(input, "json").content).target.component,
      component,
    );
  }
});

test("export rejects unsupported editors, formats, variants, and unsafe keys", () => {
  const input = bossInput();
  assert.throws(() =>
    buildVariantExport({ ...input, editor: "other" }, "json"),
  );
  assert.throws(() => buildVariantExport(input, "html"));
  assert.throws(() => buildVariantExport({ ...input, variant: null }, "json"));
  assert.throws(() =>
    buildVariantExport(
      {
        ...input,
        implementation: { ...input.implementation, key: "x/../../tmp" },
      },
      "json",
    ),
  );
});

test("both formats carry actionable permanent-variant instructions and usage", () => {
  const input = bossInput();
  const payload = JSON.parse(buildVariantExport(input, "json").content);
  assert.equal(payload.implementation.intent, "add-reusable-code-variant");
  assert.equal(payload.implementation.key, "compact-raid");
  assert.equal(payload.implementation.usage, input.implementation.usage);
  assert.ok(
    payload.implementation.instructions.some((line) =>
      line.includes("постоянную именованную вариацию"),
    ),
  );
  assert.ok(
    payload.implementation.instructions.some((line) =>
      line.includes("Визуальное тестирование"),
    ),
  );
  const md = buildVariantExport(input, "md").content;
  for (const instruction of payload.implementation.instructions)
    assert.ok(md.includes(instruction));
});

test("legacy currency selections export as one grouped drop field without changing the draft", () => {
  const input = bossInput();
  input.variant.settings.descriptionFields = [
    "coins",
    "name",
    "pills",
    "banknotes",
  ];
  const payload = JSON.parse(buildVariantExport(input, "json").content);
  assert.deepEqual(payload.design.settings.descriptionFields, ["drop", "name"]);
  assert.deepEqual(input.variant.settings.descriptionFields, [
    "coins",
    "name",
    "pills",
    "banknotes",
  ]);
});

test("one boss variation exports independent desktop and mobile settings", () => {
  const input = bossInput();
  input.variant.settings.statusSize = "lg";
  input.variant.mobileSettings = {
    ...structuredClone(input.variant.settings),
    statusSize: "sm",
    availabilitySize: "md",
    descriptionFields: ["drop", "accessLevel"],
  };
  const payload = JSON.parse(buildVariantExport(input, "json").content);
  assert.deepEqual(payload.design.responsive.desktop, input.variant.settings);
  assert.deepEqual(
    payload.design.responsive.mobile,
    input.variant.mobileSettings,
  );
  assert.equal(payload.variant.id, input.variant.id);
  assert.match(buildVariantExport(input, "md").content, /responsive/);
});

test("entity responsive export retains both profiles without sharing mutable data", () => {
  const input = {
    editor: "entity",
    entityKey: "floor:A",
    variant: {
      id: "v1",
      name: "Adaptive",
      fields: {},
      mobileFields: { title: { kind: "title", props: { size: "sm" } } },
    },
    implementation: { key: "adaptive-floor" },
  };
  const before = structuredClone(input);
  const payload = JSON.parse(buildVariantExport(input, "json").content);
  assert.deepEqual(payload.design.responsive, {
    desktop: input.variant.fields,
    mobile: input.variant.mobileFields,
  });
  assert.deepEqual(input, before);
});

test("new business entities export reusable targets and selected presentation props", () => {
  for (const [prefix, component] of [
    ["work", "WorkCard"],
    ["block", "BlockCard"],
    ["condition", "OpeningConditionCard"],
    ["businessEntity", "BusinessEntityCard"],
  ]) {
    const payload = JSON.parse(
      buildVariantExport(
        {
          editor: "entity",
          entityKey: `${prefix}:example`,
          variant: {
            id: "v1",
            name: "Example",
            fields: {},
            componentProps: { mode: "detailed" },
          },
          implementation: { key: "entity-example" },
        },
        "json",
      ).content,
    );
    assert.equal(payload.target.component, component);
    assert.deepEqual(payload.design.props, { mode: "detailed" });
  }
});
