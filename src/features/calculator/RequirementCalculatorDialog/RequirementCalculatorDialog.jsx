import "./RequirementCalculatorDialog.css";
import { calculateRequirementEnergy } from "../../../lib/energy.js";
import { useEffect, useState } from "react";
import { Modal } from "../../../components/ui/Modal/Modal.jsx";
import { NumberField } from "../../../components/ui/NumberField/NumberField.jsx";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { fmt, fmtEnergy, restoreTime } from "../../../lib/format.js";
import { getSessionJson } from "../../../../shared/session-api.js";
import { departmentById } from "../../../model/knowledge-base.js";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
import {
  readSession,
  subscribeSession,
} from "../../../../shared/auth-session.js";

function formatCountWord(value) {
  const lastTwo = value % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return "раз";
  const last = value % 10;
  return last === 2 || last === 3 || last === 4 ? "раза" : "раз";
}

function DefibrillatorIcon({ variant }) {
  return (
    <svg
      className={`requirement-calculator-defibrillator-icon requirement-calculator-defibrillator-icon--${variant}`}
      viewBox="0 0 32 32"
      aria-hidden="true"
    >
      <rect x="5.5" y="3.5" width="21" height="25" rx="4" />
      <path d="M10 9h12M10 23h12" />
      <path d="m17 11-4 6h4l-2 5 5-7h-4l2-4Z" />
    </svg>
  );
}

export function RequirementCalculatorDialog({ conditionDialog, onClose }) {
  const [energyLimit, setEnergyLimit] = useState("");
  const [profileEnergy, setProfileEnergy] = useState(null);
  const [profileStatus, setProfileStatus] = useState("idle");

  useEffect(() => {
    if (!conditionDialog) {
      setEnergyLimit("");
      setProfileEnergy(null);
      setProfileStatus("idle");
      return;
    }

    let controller;
    const loadProfileEnergy = async () => {
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      setEnergyLimit("");
      setProfileEnergy(null);

      if (readSession().status !== "ready") {
        setProfileStatus("manual");
        return;
      }

      setProfileStatus("loading");
      try {
        const profile = await getSessionJson("/api/me", {
          signal,
          fresh: true,
        });
        const maxEnergy = profile?.energy?.max;
        const currentEnergy = profile?.energy?.current;
        if (
          !Number.isSafeInteger(maxEnergy) ||
          maxEnergy <= 0 ||
          !Number.isSafeInteger(currentEnergy) ||
          currentEnergy < 0
        )
          throw new Error("Energy data unavailable");
        if (!signal.aborted) {
          setProfileEnergy({ maxEnergy, currentEnergy });
          setProfileStatus("ready");
        }
      } catch {
        if (!signal.aborted) setProfileStatus("manual-fallback");
      }
    };

    loadProfileEnergy();
    const unsubscribe = subscribeSession(loadProfileEnergy);
    return () => {
      controller?.abort();
      unsubscribe();
    };
  }, [conditionDialog]);

  if (!conditionDialog) return null;
  const requirementCalc = conditionDialog.energy;
  const requirement = conditionDialog.requirement;
  const targetWork = requirement?.targetDepartmentId
    ? departmentById[requirement.targetDepartmentId]?.work
    : null;
  const rawConditionName =
    targetWork?.title || requirement?.label || "Условие не указано";
  const conditionName = rawConditionName
    .replace(/^выполнить\s+/i, "")
    .replace(/\s+\d+\s+раз(?:а)?$/i, "")
    .trim();
  const requirementCount = Number(requirement?.required);
  const hasRequirementCount =
    requirement?.required != null && Number.isFinite(requirementCount);
  const calculatorTitle = `Калькулятор энергии для «${conditionName}»${
    hasRequirementCount
      ? ` — ${fmt(requirementCount)} ${formatCountWord(requirementCount)}`
      : ""
  }`;
  const manualEnergy = energyLimit === "" ? null : Number(energyLimit);
  const maxEnergy =
    profileEnergy?.maxEnergy ??
    (Number.isSafeInteger(manualEnergy) && manualEnergy > 0
      ? manualEnergy
      : null);
  const currentEnergy = profileEnergy?.currentEnergy ?? maxEnergy;
  const energyPlan =
    requirementCalc != null && maxEnergy != null && currentEnergy != null
      ? calculateRequirementEnergy(requirementCalc, maxEnergy, currentEnergy)
      : null;

  return (
    <Modal
      className="requirement-calculator-dialog"
      title={calculatorTitle}
      titleId="requirement-calc-title"
      width={620}
      onClose={onClose}
    >
      <form
        className="requirement-calculator-card"
        onSubmit={(event) => {
          event.preventDefault();
          onClose();
        }}
      >
        {requirementCalc != null && (
          <BaseCard variant="floor-data" className="requirement-calculator-total">
            <span className="requirement-calculator-total-label">
              Необходимо энергии
            </span>
            <strong className="requirement-calculator-total-value">
              {fmtEnergy(requirementCalc)} <span aria-hidden="true">⚡</span>
            </strong>
          </BaseCard>
        )}
        {profileStatus === "loading" ? (
          <BaseCard variant="floor-data" className="requirement-calculator-profile" role="status">
            Загружаю запас энергии из профиля…
          </BaseCard>
        ) : profileEnergy ? (
          <BaseCard variant="floor-data" className="requirement-calculator-profile">
            Текущий запас: {fmt(profileEnergy.currentEnergy)} из{" "}
            {fmt(profileEnergy.maxEnergy)} ⚡
          </BaseCard>
        ) : (
          <div className="requirement-calculator-energy-field">
            <NumberField
              id="requirement-energy-limit"
              label="Максимальный лимит энергии"
              suffix="⚡"
              suffixClassName="requirement-calculator-energy-suffix"
              min="1"
              placeholder="Введите лимит энергии"
              value={energyLimit}
              onChange={(event) => setEnergyLimit(event.target.value)}
            />
          </div>
        )}
        {(requirementCalc == null || energyPlan) && (
          <div
            className="requirement-calculator-result"
            aria-live="polite"
          >
            {requirementCalc == null ? (
              <p>
                Для этого условия в подключённых источниках не указана
                подтверждённая стоимость энергии.
              </p>
            ) : (
              <>
                <BaseCard variant="floor-data" className="requirement-calculator-option">
                  <span className="requirement-calculator-option-icon" aria-hidden="true">⏱</span>
                  <h3>Вариант 1: ждать энергию</h3>
                  {energyPlan.remaining > 0 ? (
                    <div className="requirement-calculator-recovery">
                      <span>
                        Восстановить{" "}
                        <strong>{fmtEnergy(energyPlan.remaining)} ⚡</strong>
                      </span>
                      <strong className="requirement-calculator-recovery-time">
                        {restoreTime(energyPlan.minutes)}
                      </strong>
                    </div>
                  ) : (
                    <p className="requirement-calculator-enough-energy">
                      Текущего запаса энергии хватит.
                    </p>
                  )}
                </BaseCard>
                <BaseCard
                  variant="floor-data"
                  className="requirement-calculator-option requirement-calculator-option--purchase"
                >
                  <Icon
                    type="banknote"
                    className="requirement-calculator-option-icon"
                  />
                  <h3>Вариант 2: купить дефибрилляторы</h3>
                  <div
                    className="requirement-calculator-refills"
                    aria-label="Дефибрилляторы для восстановления энергии"
                  >
                    <div className="requirement-calculator-refill">
                      <DefibrillatorIcon variant="small" />
                      <span className="requirement-calculator-refill-copy">
                        <strong>Малый</strong>
                        <small>10% лимита</small>
                      </span>
                      <strong className="requirement-calculator-refill-count">
                        ×{fmt(energyPlan.smallRefills)}
                      </strong>
                    </div>
                    <div className="requirement-calculator-refill">
                      <DefibrillatorIcon variant="large" />
                      <span className="requirement-calculator-refill-copy">
                        <strong>Большой</strong>
                        <small>100% лимита</small>
                      </span>
                      <strong className="requirement-calculator-refill-count">
                        ×{fmt(energyPlan.largeRefills)}
                      </strong>
                    </div>
                  </div>
                  <div className="requirement-calculator-banknotes">
                    <span>Итого</span>
                    <span className="requirement-calculator-banknotes-value">
                      <strong>{fmt(energyPlan.banknotes)}</strong> купюр
                    </span>
                  </div>
                </BaseCard>
              </>
            )}
          </div>
        )}
      </form>
    </Modal>
  );
}
