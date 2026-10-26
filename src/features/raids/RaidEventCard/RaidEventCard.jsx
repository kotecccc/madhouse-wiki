import { useBossRewardReference } from "../../bosses/useBossRewardReference.js";
import { raidDisplayFields } from "../../../lib/card-display-fields.js";
import { CardEditScope } from "../../../components/ui/CardEditing/CardEditing.jsx";
import { useState } from "react";
import { knowledgeBase } from "virtual:madhouse-catalogue";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { BossCardVariant } from "../../bosses/BossCard/BossCardVariant.jsx";
import {
  departmentById,
  getBossFloorCode,
} from "../../../model/knowledge-base.js";
import {
  getRaidDisplayZone,
  getRaidStatus,
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

function wordSimilarity(left, right) {
  if (left === right) return 1;
  const previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return 1 - previous[right.length] / Math.max(left.length, right.length);
}

function bossNameSimilarity(raidName, bossName) {
  const raidWords = normaliseBossName(raidName).split(/\s+/u).filter(Boolean);
  const bossWords = normaliseBossName(bossName).split(/\s+/u).filter(Boolean);
  if (!raidWords.length || !bossWords.length) return 0;

  const coverage = (words, otherWords) =>
    words.reduce(
      (total, word) =>
        total +
        Math.max(...otherWords.map((other) => wordSimilarity(word, other))),
      0,
    ) / words.length;
  const raidCoverage = coverage(raidWords, bossWords);
  const bossCoverage = coverage(bossWords, raidWords);
  return (2 * raidCoverage * bossCoverage) / (raidCoverage + bossCoverage || 1);
}

function findRaidBoss(raid) {
  const zoneMatch = getRaidDisplayZone(raid).match(/^([A-Z])\s*([1-3])$/iu);
  const departmentCode = zoneMatch
    ? `${zoneMatch[1]}${zoneMatch[2]}`.toLocaleUpperCase("en-US")
    : null;
  const floorCode = departmentCode?.[0];
  const exactDepartmentBosses = departmentCode
    ? knowledgeBase.bosses.filter(
        (boss) =>
          departmentById[boss.departmentId]?.code?.toLocaleUpperCase(
            "en-US",
          ) === departmentCode,
      )
    : [];
  const sameFloorBosses = floorCode
    ? knowledgeBase.bosses.filter(
        (boss) => getBossFloorCode(boss) === floorCode,
      )
    : [];
  const candidates =
    exactDepartmentBosses.length > 0
      ? exactDepartmentBosses
      : sameFloorBosses.length > 0
        ? sameFloorBosses
        : knowledgeBase.bosses;

  return [...candidates].sort((left, right) => {
    const similarity =
      bossNameSimilarity(raid?.boss, right.name) -
      bossNameSimilarity(raid?.boss, left.name);
    return similarity || String(left.id).localeCompare(String(right.id));
  })[0];
}

function RaidLeader({ leader }) {
  const [copyState, setCopyState] = useState("");
  const sourceText = String(leader || "").trim();
  const copyText = sourceText;
  if (!copyText) return <span>—</span>;

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
      <span className="raid-leader-name">{copyText}</span>
      <Button
        editKey="leader-copy"
        type="button"
        variant="icon-copy-inline"
        icon="copy"
        iconSize="small"
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

export function RaidEventCard({
  raid,
  status: statusOverride,
  floorAvailability = {},
  bossOverride,
  goalAction,
}) {
  const name = String(raid?.boss || "Босс не указан").trim();
  const boss = bossOverride ||
    findRaidBoss(raid) || {
      id: `raid-${name}`,
      name,
      image: null,
      possibleDrops: [],
      dropItems: [],
    };
  const referenceBoss = useBossRewardReference(boss);
  const status = statusOverride || getRaidStatus(raid);
  const zone = getRaidDisplayZone(raid) || "—";
  const floorCode = String(raid?.zone || "")
    .trim()
    .match(/^[A-Z]/i)?.[0];
  const floorLocked =
    floorCode && floorAvailability[floorCode.toUpperCase()] === false;

  const displayFields = raidDisplayFields(
    raid,
    referenceBoss,
    departmentById[boss.departmentId] || {},
    zone,
  ).map((field) =>
    field.id === "leader"
      ? {
          ...field,
          content: (
            <span className="raid-leader-group">
              <span>Ведущий:</span>
              <RaidLeader leader={raid?.leader} />
            </span>
          ),
        }
      : field,
  );
  return (
    <CardEditScope scope="raid">
      <BossCardVariant
        preset="boss-raid"
        boss={referenceBoss}
        as="article"
        variant="raid"
        titleAs="h3"
        className="raid-card"
        displayFields={displayFields}
        raid={raid}
        status={status}
        availabilityLocked={Boolean(floorLocked)}
        goalAction={goalAction}
      />
    </CardEditScope>
  );
}
