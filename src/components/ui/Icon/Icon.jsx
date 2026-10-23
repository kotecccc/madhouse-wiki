import {
  IconArrowDown,
  IconArrowLeft,
  IconArrowRight,
  IconArrowUp,
  IconBatteryVerticalCharging,
  IconBook,
  IconBolt,
  IconBugFilled,
  IconBuilding,
  IconBuildingHospital,
  IconBuildingStore,
  IconCalculator,
  IconCashBanknote,
  IconChartBar,
  IconCheck,
  IconChevronDown,
  IconCoin,
  IconCopy,
  IconCornerDownLeft,
  IconDice,
  IconExternalLink,
  IconFlame,
  IconHandGrab,
  IconLock,
  IconLockOpen,
  IconMessage,
  IconPackage,
  IconPillFilled,
  IconSkull,
  IconStopwatch,
  IconSwords,
  IconTreasureChest,
  IconUser,
  IconVaccine,
  IconX,
} from "@tabler/icons-react";
import "./Icon.css";

function iconSizeVariant(size) {
  if (typeof size !== "number") return size;
  if (size <= 14) return "small";
  if (size <= 16) return "medium";
  return "large";
}

const iconComponents = {
  boss: IconSkull,
  character: IconUser,
  chevron: IconChevronDown,
  "external-link": IconExternalLink,
  message: IconMessage,
  copy: IconCopy,
  loot: IconPackage,
  levels: IconChartBar,
  lock: IconLock,
  unlock: IconLockOpen,
  business: IconBuildingStore,
  bug: IconBugFilled,
  department: IconBuildingHospital,
  floor: IconBuilding,
  combat: IconSwords,
  fist: IconHandGrab,
  fire: IconFlame,
  timer: IconStopwatch,
  energy: IconBolt,
  dice: IconDice,
  stash: IconTreasureChest,
  book: IconBook,
  calc: IconCalculator,
  coin: IconCoin,
  pill: IconPillFilled,
  banknote: IconCashBanknote,
  "defibrillator-small": IconVaccine,
  "defibrillator-large": IconBatteryVerticalCharging,
  "arrow-left": IconArrowLeft,
  "arrow-right": IconArrowRight,
  "arrow-up": IconArrowUp,
  "arrow-down": IconArrowDown,
  "corner-down-left": IconCornerDownLeft,
  check: IconCheck,
  close: IconX,
};

export function Icon({ type, size, className = "" }) {
  const IconComponent = iconComponents[type] || IconMessage;
  const iconClasses = [
    "ui-icon",
    [
      "energy",
      "coin",
      "pill",
      "banknote",
      "defibrillator-small",
      "defibrillator-large",
    ].includes(type) && `ui-icon--${type}`,
    size && `ui-icon--${iconSizeVariant(size)}`,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  if (type === "pill") {
    return (
      <span className={`${iconClasses} ui-icon--duotone`} aria-hidden="true">
        <IconPillFilled className="ui-icon__duotone-layer" focusable="false" />
        <IconPillFilled
          className="ui-icon__duotone-layer ui-icon__duotone-layer--accent"
          focusable="false"
        />
      </span>
    );
  }

  return (
    <IconComponent
      className={iconClasses}
      aria-hidden="true"
      focusable="false"
    />
  );
}
