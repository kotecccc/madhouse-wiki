import { Pill } from "../../../components/ui/Pill/Pill.jsx";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
import { summarizeBossCollection } from "./boss-collection.js";

export function BossCollectionStatus({ boss, state }) {
  if (!state || state.status === "idle") return null;
  const summary = summarizeBossCollection(boss, state.responses);
  if (!summary.total) return null;
  const known = summary.known === summary.total;
  const count =
    state.status === "loading"
      ? "…"
      : known
        ? summary.collected
        : summary.collected > 0
          ? `${summary.collected}+`
          : "?";
  const detail = summary.complete
    ? "Все вещевые награды босса получены или открыты для покупки."
    : known
      ? `Получено или открыто ${summary.collected} из ${summary.total} вещевых наград.`
      : `Подтверждено ${summary.collected} из ${summary.total}. Данные о ${summary.total - summary.known} наградах пока неизвестны.`;
  return (
    <Pill
      variant={summary.complete ? "completed" : "scheduled"}
      size="xs"
      dot={false}
      title={`${detail} Материалы бизнеса и расходники не учитываются.`}
      aria-label={`Получено ${count} из ${summary.total} вещевых наград`}
    >
      {summary.complete ? (
        <Icon type="loot" size="medium" />
      ) : (
        `${count} из ${summary.total}`
      )}
    </Pill>
  );
}
