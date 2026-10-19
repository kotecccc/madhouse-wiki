import "./UpgradeTable.css";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { fmt } from "../../../lib/format.js";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
export function UpgradeTable({ upgrade }) {
  return (
    <BaseCard className="business-upgrade-card business-upgrade-unmatched">
      <CardTitle>{upgrade.name}</CardTitle>
      <CardDescription as="small">{upgrade.source}</CardDescription>
      <div className="business-upgrade-table-wrap">
        <table className="business-upgrade-table">
          <thead>
            <tr>
              <th>Уровень</th>
              {upgrade.items.map((i) => (
                <th key={i.name}>{i.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from(
              {
                length: Math.max(...upgrade.items.map((i) => i.levels.length)),
              },
              (_, n) => (
                <tr key={n}>
                  <th>{n + 1} ур.</th>
                  {upgrade.items.map((i) => (
                    <td key={i.name}>
                      {i.levels[n] == null ? "—" : fmt(i.levels[n])}
                    </td>
                  ))}
                </tr>
              ),
            )}
            <tr className="business-upgrade-total">
              <th>Всего</th>
              {upgrade.items.map((i) => (
                <td key={i.name}>{fmt(i.levels.reduce((s, n) => s + n, 0))}</td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      {upgrade.note && <p className="floor-work-source-note">{upgrade.note}</p>}
    </BaseCard>
  );
}
