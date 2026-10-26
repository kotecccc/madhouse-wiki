import {
  IconArrowDown,
  IconArrowLeft,
  IconArrowRight,
  IconArrowUp,
  IconAlertTriangle,
  IconBatteryVerticalCharging,
  IconBook,
  IconBrain,
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
  IconHeart,
  IconInfoCircle,
  IconInfinity2,
  IconLoader2,
  IconLock,
  IconLockOpen,
  IconMessage,
  IconMenu2,
  IconPackage,
  IconRobot,
  IconRefresh,
  IconUsersGroup,
  IconPlayerPlay,
  IconPlayerPause,
  IconPlayerStop,
  IconPillFilled,
  IconSkull,
  IconStar,
  IconStopwatch,
  IconSwords,
  IconSword,
  IconTarget,
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

// Both medicine variants share the same broad, equal-arm cross silhouette.
function MedicineCross({ filled = false, ...props }) {
  return (
    <svg viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} {...props}>
      <path
        d="M9 3H15V9H21V15H15V21H9V15H3V9H9Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MedicineCrossFilled(props) {
  return <MedicineCross filled {...props} />;
}

const iconComponents = {
  brain: IconBrain,
  madness: IconHeart,
  aggression: IconSwords,
  rage: IconFlame,
  star: IconStar,
  boss: IconSkull,
  character: IconUser,
  chevron: IconChevronDown,
  "external-link": IconExternalLink,
  message: IconMessage,
  menu: IconMenu2,
  copy: IconCopy,
  loot: IconPackage,
  levels: IconChartBar,
  lock: IconLock,
  unlock: IconLockOpen,
  business: IconBuildingStore,
  bug: IconBugFilled,
  warning: IconAlertTriangle,
  info: IconInfoCircle,
  department: IconBuildingHospital,
  floor: IconBuilding,
  combat: IconSwords,
  target: IconTarget,
  sword: IconSword,
  robot: IconRobot,
  refresh: IconRefresh,
  group: IconUsersGroup,
  play: IconPlayerPlay,
  pause: IconPlayerPause,
  stop: IconPlayerStop,
  fist: IconHandGrab,
  fire: IconFlame,
  timer: IconStopwatch,
  "infinity-2": IconInfinity2,
  energy: IconBolt,
  dice: IconDice,
  stash: IconTreasureChest,
  book: IconBook,
  calc: IconCalculator,
  coin: IconCoin,
  pill: IconPillFilled,
  banknote: IconCashBanknote,
  "medical-cross": MedicineCross,
  "medicine-small": MedicineCross,
  "medicine-full": MedicineCrossFilled,
  "defibrillator-small": IconVaccine,
  "defibrillator-large": IconBatteryVerticalCharging,
  "arrow-left": IconArrowLeft,
  "arrow-right": IconArrowRight,
  "arrow-up": IconArrowUp,
  "arrow-down": IconArrowDown,
  "corner-down-left": IconCornerDownLeft,
  loader: IconLoader2,
  check: IconCheck,
  close: IconX,
};

export function Icon({ type, size, motion, className = "" }) {
  const IconComponent = iconComponents[type] || IconMessage;
  const iconClasses = [
    "ui-icon",
    [
      "energy",
      "madness",
      "aggression",
      "rage",
      "star",
      "coin",
      "pill",
      "banknote",
      "medicine-small",
      "medicine-full",
      "defibrillator-small",
      "defibrillator-large",
    ].includes(type) && `ui-icon--${type}`,
    size && `ui-icon--${iconSizeVariant(size)}`,
    ["pulse", "spin"].includes(motion) && `ui-icon--${motion}`,
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
