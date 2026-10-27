import { useState } from "react";
import { Button } from "../Button/Button.jsx";
import { Icon } from "../Icon/Icon.jsx";
import { Pill } from "../Pill/Pill.jsx";
import { Popover } from "../Popover/Popover.jsx";
import { CardTitle } from "../CardTitle/CardTitle.jsx";
import { CardDescription } from "../CardDescription/CardDescription.jsx";
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
  status = false,
}) {
  const [anchor, setAnchor] = useState(null);
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
  const description = `${active ? "Установлен" : "Неактивен"}: ${mutagen.name}`;
  const displayDetails = active ? details : [inactiveReason, ...details];
  if (status) {
    const code = mutagen.name.replace(/^Мутаген\s+/iu, "") || mutagen.name;
    return (
      <>
        <Button
          variant="text-tag"
          liftOnHover={false}
          title={[description, ...displayDetails].join("\n")}
          aria-label={description}
          aria-haspopup="dialog"
          aria-expanded={Boolean(anchor)}
          onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}
        >
          <Pill size="xs" dot={false} variant={active ? "active" : "locked"}>
            <Icon type="flask-filled" size="text" tone="inherit" />
            {code}
          </Pill>
        </Button>
        {anchor && (
          <Popover
            anchor={anchor}
            label={description}
            onClose={() => setAnchor(null)}
          >
            <CardTitle size="sm">{description}</CardTitle>
            {displayDetails.map((detail, index) => (
              <CardDescription size="sm" key={index}>
                {detail}
              </CardDescription>
            ))}
          </Popover>
        )}
      </>
    );
  }
  return (
    <StatTag
      icon={active ? "flask" : "flask-off"}
      mutagenType={mutagen.type}
      inactive={!active}
      label={mutagen.name}
      description={description}
      details={displayDetails}
    />
  );
}
