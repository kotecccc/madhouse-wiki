import test from "node:test";
import assert from "node:assert/strict";
import {
  bossCardVariants,
  getBossCardVariantProps,
} from "./boss-card-variants.js";

test("raid boss variant maps desktop and mobile responsive settings", () => {
  assert.deepEqual(getBossCardVariantProps("boss-raid"), {
    cardPadding: "12",
    contentGap: "4",
    columnGap: "12",
    titleSize: "sm",
    infoSize: "2xs",
    titleFields: ["name", "block"],
    descriptionFields: ["time", "duration", "leader", "drop"],
    descriptionBreakBefore: [],
    hasPortrait: true,
    showInfo: true,
    showDropList: true,
    action: false,
    actionText: "Весь дроп",
    actionSize: "md",
    showStatus: true,
    showAvailability: true,
    statusSize: "sm",
    availabilitySize: "sm",
    statusCompact: false,
    dropItemOverrides: { 0: { textSize: "2xs", itemSize: "--space-32" } },
  });
  assert.deepEqual(getBossCardVariantProps("boss-raid", true), {
    cardPadding: "12",
    contentGap: "4",
    columnGap: "12",
    titleSize: "xs",
    infoSize: "2xs",
    titleFields: ["name", "block"],
    descriptionFields: ["time", "duration", "leader", "drop"],
    descriptionBreakBefore: ["leader"],
    hasPortrait: true,
    showInfo: true,
    showDropList: true,
    action: false,
    actionText: "Весь дроп",
    actionSize: "md",
    showStatus: true,
    showAvailability: false,
    statusSize: "xs",
    availabilitySize: "xs",
    statusCompact: true,
    dropItemOverrides: { 0: { textSize: "2xs", itemSize: "--space-24" } },
  });
});

test("main boss variant leaves action enabled and maps drops and fields", () => {
  const props = getBossCardVariantProps("boss-main");
  assert.equal(props.action, undefined);
  assert.equal(props.actionText, "Дроп");
  assert.equal(props.showStatus, false);
  assert.equal(props.showAvailability, false);
  assert.deepEqual(props.titleFields, ["name", "block"]);
  assert.deepEqual(props.descriptionFields, ["accessLevel", "drop"]);
  assert.deepEqual(props.dropItemOverrides, {
    0: { textSize: "2xs", itemSize: "--space-32" },
  });
  assert.deepEqual(getBossCardVariantProps("boss-main", true), props);
});

test("registry omits persisted status and availability values", () => {
  for (const variant of Object.values(bossCardVariants)) {
    for (const settings of Object.values(variant)) {
      assert.equal("status" in settings, false);
      assert.equal("availability" in settings, false);
    }
  }
});

test("unknown variant keys return undefined", () => {
  assert.equal(getBossCardVariantProps("unknown"), undefined);
});
