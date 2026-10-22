import { CardEditScope } from "../../../components/ui/CardEditing/CardEditing.jsx";
import { EditableValue } from "../../../components/ui/CardEditing/EditableValue.jsx";
import "./UpgradeTable.css";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { fmt } from "../../../lib/format.js";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
export function UpgradeTable({ upgrade, showSource = true, showNote = true }) {
  const fields = [
    { id: "name", label: "Название", value: upgrade.name },
    { id: "source", label: "Источник", value: upgrade.source || "" },
    { id: "note", label: "Примечание", value: upgrade.note || "" },
  ];
  return (
    <CardEditScope
      scope={`upgrade:${upgrade.id || upgrade.businessId || upgrade.name}`}
    >
      <BaseCard
        editKey="card"
        className="business-upgrade-card business-upgrade-unmatched"
      >
        <CardTitle
          composition={{ fields, defaultFields: ["name"] }}
          editKey="title"
        >
          {upgrade.name}
        </CardTitle>
        {showSource && upgrade.source && (
          <CardDescription
            composition={{ fields, defaultFields: ["source"] }}
            editKey="source"
            as="small"
          >
            {upgrade.source}
          </CardDescription>
        )}
        <div className="business-upgrade-table-wrap">
          <table className="business-upgrade-table">
            <thead>
              <tr>
                <EditableValue as="th" editKey="level-heading">
                  Уровень
                </EditableValue>
                {upgrade.items.map((i, itemIndex) => (
                  <EditableValue
                    as="th"
                    key={itemIndex}
                    editKey={`item:${itemIndex}:heading`}
                  >
                    {i.name}
                  </EditableValue>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from(
                {
                  length: Math.max(
                    ...upgrade.items.map((i) => i.levels.length),
                  ),
                },
                (_, n) => (
                  <tr key={n}>
                    <EditableValue
                      as="th"
                      editKey={`level:${n}`}
                    >{`${n + 1} ур.`}</EditableValue>
                    {upgrade.items.map((i, itemIndex) => (
                      <EditableValue
                        as="td"
                        key={itemIndex}
                        editKey={`item:${itemIndex}:level:${n}`}
                      >
                        {i.levels[n] == null ? "—" : fmt(i.levels[n])}
                      </EditableValue>
                    ))}
                  </tr>
                ),
              )}
              <tr className="business-upgrade-total">
                <EditableValue as="th" editKey="total-heading">
                  Всего
                </EditableValue>
                {upgrade.items.map((i, itemIndex) => (
                  <EditableValue
                    as="td"
                    key={itemIndex}
                    editKey={`item:${itemIndex}:total`}
                  >
                    {fmt(i.levels.reduce((s, n) => s + n, 0))}
                  </EditableValue>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        {showNote && upgrade.note && (
          <EditableValue
            as="p"
            editKey="note"
            className="floor-work-source-note"
          >
            {upgrade.note}
          </EditableValue>
        )}
      </BaseCard>
    </CardEditScope>
  );
}
