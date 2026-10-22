import { useMemo, useState } from "react";
import { RequirementCalculatorDialog } from "../../calculator/RequirementCalculatorDialog/RequirementCalculatorDialog.jsx";

function WorkEnergyDialog({ work, energy, onClose }) {
  const [count, setCount] = useState("1");
  const conditionDialog = useMemo(
    () => ({
      energy,
      requirement: {
        type: "work_completions",
        label: work.title || work.name || "Работёнка",
        targetDepartmentId: work.departmentId,
      },
    }),
    [work, energy],
  );
  return (
    <RequirementCalculatorDialog
      conditionDialog={conditionDialog}
      countControl={{ value: count, onChange: setCount, unitEnergy: energy }}
      onClose={onClose}
    />
  );
}

export function WorkCalculatorDialog({ work, energy, visible, onClose }) {
  return visible && work ? (
    <WorkEnergyDialog
      key={work.id}
      work={work}
      energy={energy}
      onClose={onClose}
    />
  ) : null;
}
