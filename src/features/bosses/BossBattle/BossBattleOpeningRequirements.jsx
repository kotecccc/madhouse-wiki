import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";

/** Opening-condition wording is display context, not a new automation command. */
export function BossBattleOpeningRequirements({ targets = [] }) {
  return targets.map((target, index) => (
    <BaseCard
      key={`${target.destination}-${target.label}-${index}`}
      className="boss-battle-column"
      aria-label="Условие открытия"
    >
      <CardTitle>Для открытия {target.destination}</CardTitle>
      <CardDescription title={target.label}>{target.label}</CardDescription>
      {[target.note, target.verification]
        .filter((note) => typeof note === "string" && note.trim())
        .map((note, noteIndex) => (
          <CardDescription key={noteIndex} title={note}>
            {note}
          </CardDescription>
        ))}
    </BaseCard>
  ));
}
