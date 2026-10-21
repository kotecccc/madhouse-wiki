import { useState } from "react";
import { knowledgeBase } from "virtual:madhouse-catalogue";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { BossCardView } from "../../bosses/BossCard/BossCardView.jsx";
import {
  getRaidDisplayZone,
  getRaidStatus,
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
  const username = /^@[A-Za-z0-9_]{1,64}$/.test(sourceText)
    ? sourceText
    : null;

  async function copyUsername() {
    try {
      await navigator.clipboard.writeText(username);
      setCopyState("Скопировано");
    } catch {
      setCopyState("Не удалось скопировать");
    }
    window.setTimeout(() => setCopyState(""), 1800);
  }

  if (!username)
    return (
      <CardDescription as="span">{sourceText || "—"}</CardDescription>
    );

  return (
    <span className="raid-leader-control">
      <span className="raid-leader-avatar" aria-hidden="true">
        {username.slice(1, 2).toLocaleUpperCase("ru-RU")}
      </span>
      <Button
        type="button"
        variant="secondary"
        icon="copy"
        iconSize="small"
        className="raid-leader-copy"
        title={`Скопировать ${username}`}
        aria-label={`Скопировать имя ведущего ${username}`}
        onClick={copyUsername}
      >
        {username}
      </Button>
      <span className="sr-only" aria-live="polite">
        {copyState}
      </span>
    </span>
  );
}

function RaidStatus({ status }) {
  const info = RAID_STATUS_INFO[status] || RAID_STATUS_INFO.unknown;
  return (
    <span className={`raid-status raid-status--${info.color}`}>
      <span className="raid-status-dot" aria-hidden="true" />
      <span>{info.label}</span>
    </span>
  );
}

export function RaidEventCard({ raid, status: statusOverride }) {
  const name = String(raid?.boss || "Босс не указан").trim();
  const boss = bossesByName.get(normaliseBossName(name)) || {
    id: `raid-${name}`,
    name,
    image: null,
    possibleDrops: [],
    dropItems: [],
  };
  const status = statusOverride || getRaidStatus(raid);
  const fields = [
    ["Зона", getRaidDisplayZone(raid)],
    ["Клан", raid?.clan],
    ["Ведущий", <RaidLeader key="leader" leader={raid?.leader} />],
    ["Длительность", raid?.duration],
  ];

  return (
    <BossCardView
      boss={boss}
      as="article"
      variant="raid"
      titleAs="h3"
      showInfo={false}
      showDropList={false}
      action={<RaidStatus status={status} />}
      hasPortrait={Boolean(boss.image)}
    >
      <dl className="raid-event-fields">
        {fields.map(([label, value]) => (
          <div className="raid-event-field" key={label}>
            <dt>{label}</dt>
            <dd title={typeof value === "string" ? value || "—" : undefined}>
              {label === "Ведущий" ? (
                value
              ) : (
                <CardDescription as="span" className="raid-event-field-value">
                  {value || "—"}
                </CardDescription>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </BossCardView>
  );
}
