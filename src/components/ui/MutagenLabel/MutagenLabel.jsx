import { StatTag } from "../StatTag/StatTag.jsx";
import { fmt } from "../../../lib/format.js";

const statLabels = {
  madness: "Безумие",
  aggression: "Агрессия",
  rage: "Ярость",
  endurance: "Выносливость",
  maxHealth: "Здоровье",
  baseDamage: "Урон",
  attackCooldownSeconds: "Интервал атак",
  attackCooldownReductionSeconds: "Сокращение интервала атак",
};
export function MutagenLabel({
  mutagen,
  active = true,
  inactiveReason = "Наденьте предмет, чтобы мутаген добавлял бонусы к общим характеристикам.",
}) {
  if (!mutagen) return null;
  const bonuses = Object.entries(mutagen.bonuses || {}).filter(
    ([key, value]) => statLabels[key] && Number.isFinite(value) && value !== 0,
  );
  const details = bonuses.length
    ? bonuses.map(
        ([key, value]) =>
          `${statLabels[key]}: ${value > 0 ? "+" : ""}${fmt(value)}${key.startsWith("attackCooldown") ? " с" : ""}`,
      )
    : [
        mutagen.bonuses
          ? "Без бонусов к характеристикам"
          : "Бонусы мутагена не получены",
      ];
  return (
    <StatTag
      icon={active ? "flask" : "flask-off"}
      mutagenType={mutagen.type}
      label={mutagen.name}
      description={`${active ? "Установлен" : "Неактивен"}: ${mutagen.name}`}
      details={active ? details : [inactiveReason, ...details]}
    />
  );
}
