import { Icon } from "../../../components/ui/Icon/Icon.jsx";
import { Pill } from "../../../components/ui/Pill/Pill.jsx";
import { summarizeBossCollection } from "./boss-collection.js";

export function BossCollectionStatus({ boss, state }) {
  if (!state || state.status !== "ready") return null;
  const summary =
    boss.collection ?? summarizeBossCollection(boss, state.responses);
  if (!summary.total || summary.known !== summary.total) return null;
  const count = `${summary.collected} из ${summary.total}`;
  const detail = summary.complete
    ? "Все вещевые награды босса получены или открыты для покупки."
    : `Получено или открыто ${summary.collected} из ${summary.total} вещевых наград.`;
  return (
    <Pill
      variant={summary.complete ? "completed" : "scheduled"}
      size="xs"
      dot={false}
      title={`${detail} Материалы бизнеса и расходники не учитываются.`}
      aria-label={`Получено ${count} вещевых наград`}
    >
      <Icon type="loot" size="medium" />
      {!summary.complete && count}
    </Pill>
  );
}
