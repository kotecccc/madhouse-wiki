import { useMemo, useState, useSyncExternalStore } from "react";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import "./WorkCalculatorDialog.css";
import { RequirementCalculatorDialog } from "../../calculator/RequirementCalculatorDialog/RequirementCalculatorDialog.jsx";
import {
  readSession,
  subscribeSession,
} from "../../../../shared/auth-session.js";
import { WorkFarmDialog } from "./WorkFarmDialog.jsx";

const isAuthenticated = () => readSession().status === "ready";

export function WorkEnergyDialog({ work, energy, onClose, goalTargets = [] }) {
  const [count, setCount] = useState(() =>
    String(
      Math.max(
        1,
        ...goalTargets
          .map((target) => target.required)
          .filter((value) => Number.isSafeInteger(value) && value > 0),
      ),
    ),
  );
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
      showCloseButton
      conditionDialog={conditionDialog}
      title={`Фарм · ${work.title || work.name || "Работёнка"}`}
      intro={
        goalTargets.length
          ? goalTargets.map((target) => (
              <BaseCard
                key={`${target.destination}-${target.label}`}
                className="work-calculator-goal"
              >
                <CardTitle>Для открытия {target.destination}</CardTitle>
                <CardDescription title={target.label}>
                  {target.label}
                </CardDescription>
              </BaseCard>
            ))
          : undefined
      }
      countControl={{ value: count, onChange: setCount, unitEnergy: energy }}
      onClose={onClose}
    />
  );
}

export function WorkCalculatorDialog({
  work,
  energy,
  visible,
  onClose,
  goalTargets,
}) {
  const authenticated = useSyncExternalStore(
    subscribeSession,
    isAuthenticated,
    () => false,
  );
  if (!visible || !work) return null;
  return authenticated ? (
    <WorkFarmDialog
      key={work.id}
      work={work}
      goalTargets={goalTargets}
      onClose={onClose}
    />
  ) : (
    <WorkEnergyDialog
      key={work.id}
      work={work}
      energy={energy}
      goalTargets={goalTargets}
      onClose={onClose}
    />
  );
}
