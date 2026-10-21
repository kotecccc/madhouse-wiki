import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import "./RaidEventCard.css";

const FIELDS = [
  ["Зона", "zone"],
  ["Время", "time"],
  ["Клан", "clan"],
  ["Ведущий", "leader"],
  ["Длительность", "duration"],
];

export function RaidEventCard({ raid }) {
  return (
    <BaseCard as="article" variant="raid" className="raid-event-card">
      <CardTitle as="h4" title={raid.boss}>
        {raid.boss || "Босс не указан"}
      </CardTitle>
      <dl className="raid-event-fields">
        {FIELDS.map(([label, key]) => (
          <div className="raid-event-field" key={key}>
            <dt>{label}</dt>
            <dd title={raid[key] || "—"}>
              <CardDescription as="span">{raid[key] || "—"}</CardDescription>
            </dd>
          </div>
        ))}
      </dl>
    </BaseCard>
  );
}
