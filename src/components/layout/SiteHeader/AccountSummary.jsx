import { useEffect, useRef, useState } from "react";
import { StatChange } from "../../ui/StatChange/StatChange.jsx";
import { StatTag } from "../../ui/StatTag/StatTag.jsx";
import { fmt } from "../../../lib/format.js";
import "./AccountSummary.css";

const compact = new Intl.NumberFormat("ru-RU", {
  notation: "compact",
  maximumFractionDigits: 1,
});
function formatCompact(value) {
  return compact
    .formatToParts(value)
    .map((part) =>
      part.type === "compact"
        ? { "тыс.": "К", млн: "М" }[part.value] || part.value
        : part.type === "literal" && /^\s+$/.test(part.value)
          ? ""
          : part.value,
    )
    .join("");
}
const statIcons = {
  Безумие: "madness",
  Агрессия: "aggression",
  Ярость: "rage",
};

function AnimatedAccountStat({ name, value, icon, animated }) {
  const [displayed, setDisplayed] = useState(value);
  const displayedRef = useRef(value);
  const previousRef = useRef(value);
  const [change, setChange] = useState(null);
  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = value;
    if (!animated || value === previous) return;
    setChange(value - previous);
    const timeout = setTimeout(() => setChange(null), 1600);
    return () => clearTimeout(timeout);
  }, [value, animated]);
  useEffect(() => {
    const start = displayedRef.current;
    if (
      !animated ||
      value === start ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      displayedRef.current = value;
      setDisplayed(value);
      return;
    }
    let frame;
    let startTime;
    const step = (time) => {
      startTime ??= time;
      const progress = Math.min((time - startTime) / 800, 1);
      const current = start + (value - start) * (1 - (1 - progress) ** 3);
      displayedRef.current = current;
      setDisplayed(current);
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, animated]);
  return (
    <>
      <StatTag
        size="responsive-compact"
        statTarget={animated ? icon : undefined}
        icon={icon}
        label={formatCompact(displayed)}
        description={`${name}: ${fmt(value)}`}
      />
      {change !== null && (
        <StatChange icon={icon} delta={change} size="responsive-compact" />
      )}
    </>
  );
}

export function AccountSummary({ profile }) {
  if (!profile || (!profile.wallet.length && !profile.stats.length))
    return null;
  const groups = [
    {
      label: "Валюта",
      values: profile.wallet,
    },
    {
      label: "Характеристики",
      values: profile.stats.map(([name, value]) => [
        name,
        value,
        statIcons[name],
      ]),
    },
  ];
  return (
    <div className="header-summary-surface">
      <div className="account-summary" aria-label="Состояние персонажа">
        {groups.map(({ label, values }) => (
          <div
            className="account-summary-group"
            role="group"
            aria-label={label}
            key={label}
          >
            {values.map(([name, value, icon]) => (
              <AnimatedAccountStat
                key={name}
                name={name}
                value={value}
                icon={icon}
                animated
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
