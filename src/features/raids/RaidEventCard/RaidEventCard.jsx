import { useState } from "react";
import { knowledgeBase } from "virtual:madhouse-catalogue";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
import { BossCardView } from "../../bosses/BossCard/BossCardView.jsx";
import {
  getRaidDisplayZone,
  getRaidStatus,
  hasUnknownRaidStatusMarker,
  RAID_STATUS_INFO,
} from "../../../lib/raid-schedule.js";
import "./RaidEventCard.css";

function normaliseBossName(name) {
  return String(name || "")
    .normalize("NFC")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const bossesByName = new Map();
for (const boss of knowledgeBase.bosses) {
  const key = normaliseBossName(boss.name);
  if (!key) continue;
  bossesByName.set(key, bossesByName.has(key) ? null : boss);
}

function RaidLeader({ leader }) {
  const [copyState, setCopyState] = useState("");
  const sourceText = String(leader || "").trim();
  const copyText = sourceText;
  if (!copyText) return <CardDescription as="span">—</CardDescription>;

  async function copyLeader() {
    try {
      await navigator.clipboard.writeText(copyText);
      setCopyState("Скопировано");
    } catch {
      setCopyState("Не удалось скопировать");
    }
    window.setTimeout(() => setCopyState(""), 1800);
  }

  return (
    <span className="raid-leader-control">
      <CardDescription as="span" className="raid-leader-name">
        {copyText}
      </CardDescription>
      <Button
        type="button"
        variant="icon-copy"
        icon="copy"
        iconSize="small"
        className="raid-leader-copy"
        title="Скопировать имя ведущего"
        aria-label="Скопировать имя ведущего"
        onClick={copyLeader}
      />
      <span className="sr-only" aria-live="polite">
        {copyState}
      </span>
    </span>
  );
}

function RaidStatus({ raid, status }) {
  const info = RAID_STATUS_INFO[status] || RAID_STATUS_INFO.unknown;
  const hasUnknownMarker = hasUnknownRaidStatusMarker(raid);
  const label = hasUnknownMarker ? "Маркер не распознан" : info.label;
  if (status === "locked")
    return (
      <span
        className="raid-status raid-status--locked"
        aria-label="Этаж закрыт"
      >
        <Icon type="lock" size="small" />
        <span>Закрыт</span>
      </span>
    );
  return (
    <span
      className={`raid-status raid-status--${info.color}`}
      title={
        hasUnknownMarker ? "В канале нераспознанный маркер состояния." : label
      }
      aria-label={label}
    >
      <span className="raid-status-dot" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

export function RaidEventCard({
  raid,
  status: statusOverride,
  floorAvailability = {},
}) {
  const name = String(raid?.boss || "Босс не указан").trim();
  const boss = bossesByName.get(normaliseBossName(name)) || {
    id: `raid-${name}`,
    name,
    image: null,
    possibleDrops: [],
    dropItems: [],
  };
  const status = statusOverride || getRaidStatus(raid);
  const zone = getRaidDisplayZone(raid) || "—";
  const floorCode = String(raid?.zone || "")
    .trim()
    .match(/^[A-Z]/i)?.[0];
  const floorLocked =
    floorCode && floorAvailability[floorCode.toUpperCase()] === false;

  return (
    <BossCardView
      boss={boss}
      as="article"
      variant="raid"
      titleAs="h3"
      className="raid-card"
      title={`${name} • Зона ${zone}`}
      showInfo={false}
      showDropList={!!boss.dropItems?.length}
      hasPortrait
      action={
        <div className="raid-event-meta">
          <div className="raid-event-statuses">
            {floorLocked && <RaidStatus raid={raid} status="locked" />}
            <RaidStatus raid={raid} status={status} />
          </div>
        </div>
      }
    >
      <CardDescription className="raid-event-summary">
        <span>Время: {raid?.time || "не указано"}</span>
        <span aria-hidden="true">•</span>
        <span>Длительность: {raid?.duration || "не указана"}</span>
        <span aria-hidden="true">•</span>
        <span>Ведущий:{raid?.clan ? ` [${raid.clan}]` : ""}</span>
        <RaidLeader leader={raid?.leader} />
      </CardDescription>
    </BossCardView>
  );
}
