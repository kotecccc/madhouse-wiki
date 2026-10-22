import { Divider } from "../../../components/ui/Divider/Divider.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { NumberStepper } from "../../../components/ui/NumberStepper/NumberStepper.jsx";
import { ProgressBar } from "../../../components/ui/ProgressBar/ProgressBar.jsx";
import "./RequirementCalculatorDialog.css";
import {
  calculateCycleEnergy,
  calculateRequirementEnergy,
} from "../../../lib/energy.js";
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

export function RequirementCalculatorDialog({
  conditionDialog,
  onClose,
  countControl,
}) {
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
  const countValue =
    countControl && countControl.value !== ""
      ? Number(countControl.value)
      : null;
  const countResult =
    countControl && countValue !== null
      ? calculateCycleEnergy(countControl.unitEnergy, countValue)
      : null;
  const requirementCalc = countControl
    ? (countResult?.total ?? null)
    : conditionDialog.energy;
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
  const calculatorTitle = `Калькулятор энергии для «${conditionName}»`;
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
      showCloseButton={false}
      contentVariant="inset"
      onClose={onClose}
    >
      <form
        className="requirement-calculator-card"
        onSubmit={(event) => {
          event.preventDefault();
          onClose();
        }}
      >
        {countControl && (
          <NumberStepper
            id="work-calculator-count"
            label="Количество выполнений"
            hideLabel
            compact
            min={1}
            max={Number.MAX_SAFE_INTEGER}
            value={Number(countControl.value)}
            onChange={(value) => countControl.onChange(String(value))}
            decrementLabel="Уменьшить количество выполнений"
            incrementLabel="Увеличить количество выполнений"
            rangeLabel="Количество полных выполнений работы"
          />
        )}
        {(requirementCalc != null || profileStatus === "loading") && (
          <BaseCard
            variant="floor-data"
            className="requirement-calculator-energy-summary"
          >
            {requirementCalc != null && (
              <div className="requirement-calculator-total">
                <CardDescription size="sm">Необходимо энергии</CardDescription>
                <CardTitle size="sm" as="span">
                  <span className="requirement-calculator-energy-value">
                    {fmtEnergy(requirementCalc)}{" "}
                    <Icon type="energy" size="text" />
                  </span>
                </CardTitle>
              </div>
            )}
            {profileStatus === "loading" && (
              <div className="requirement-calculator-total" role="status">
                <CardDescription size="sm">
                  Загружаю запас энергии из профиля…
                </CardDescription>
              </div>
            )}
            {requirementCalc > 0 && profileEnergy && (
              <div className="requirement-calculator-progress">
                <ProgressBar
                  value={profileEnergy.currentEnergy}
                  max={requirementCalc}
                  segments={countResult?.count}
                  label="Запас энергии для выполнения"
                  valueText={`Есть ${fmt(profileEnergy.currentEnergy)} энергии, не хватает ${fmt(Math.max(0, requirementCalc - profileEnergy.currentEnergy))}`}
                />
                <CardDescription
                  size="2xs"
                  className="requirement-calculator-progress-caption"
                >
                  Есть {fmt(profileEnergy.currentEnergy)} · Не хватает{" "}
                  {fmt(
                    Math.max(0, requirementCalc - profileEnergy.currentEnergy),
                  )}
                </CardDescription>
              </div>
            )}
          </BaseCard>
        )}
        {!profileEnergy && profileStatus !== "loading" && (
          <div className="requirement-calculator-energy-field">
            <NumberField
              id="requirement-energy-limit"
              label="Максимальный лимит энергии"
              suffix={<Icon type="energy" size="text" />}
              suffixClassName="requirement-calculator-energy-suffix"
              min="1"
              placeholder="Введите лимит энергии"
              value={energyLimit}
              onChange={(event) => setEnergyLimit(event.target.value)}
            />
          </div>
        )}
        {(requirementCalc == null || energyPlan) && (
          <div className="requirement-calculator-result" aria-live="polite">
            {requirementCalc == null ? (
              <CardDescription size="sm">
                Для этого условия в подключённых источниках не указана
                подтверждённая стоимость энергии.
              </CardDescription>
            ) : (
              <>
                <BaseCard
                  variant="floor-data"
                  className="requirement-calculator-option"
                >
                  <div className="requirement-calculator-option-heading">
                    <CardTitle as="h3" size="sm">
                      Вариант 1: ждать энергию
                    </CardTitle>
                    <Icon
                      type="timer"
                      size="medium"
                      className="requirement-calculator-option-icon"
                    />
                  </div>
                  <Divider fullWidth />
                  <div className="requirement-calculator-banknotes">
                    <CardDescription size="sm">Итого</CardDescription>
                    <CardTitle as="span" size="sm">
                      {restoreTime(energyPlan.minutes)}
                    </CardTitle>
                  </div>
                </BaseCard>
                <BaseCard
                  variant="floor-data"
                  className="requirement-calculator-option requirement-calculator-option--purchase"
                >
                  <div className="requirement-calculator-option-heading">
                    <CardTitle as="h3" size="sm">
                      Вариант 2: купить дефибрилляторы
                    </CardTitle>
                    <Icon
                      type="banknote"
                      className="requirement-calculator-option-icon"
                    />
                  </div>
                  <Divider fullWidth />
                  <div
                    className="requirement-calculator-refills"
                    aria-label="Дефибрилляторы для восстановления энергии"
                  >
                    <div className="requirement-calculator-refill">
                      <DefibrillatorIcon variant="small" />
                      <span className="requirement-calculator-refill-copy">
                        <CardTitle size="sm">Малый</CardTitle>
                        <CardDescription size="2xs">10% лимита</CardDescription>
                      </span>
                      <CardTitle
                        as="span"
                        size="sm"
                        className="requirement-calculator-refill-count"
                      >
                        ×{fmt(energyPlan.smallRefills)}
                      </CardTitle>
                    </div>
                    <div className="requirement-calculator-refill">
                      <DefibrillatorIcon variant="large" />
                      <span className="requirement-calculator-refill-copy">
                        <CardTitle size="sm">Большой</CardTitle>
                        <CardDescription size="2xs">
                          100% лимита
                        </CardDescription>
                      </span>
                      <CardTitle
                        as="span"
                        size="sm"
                        className="requirement-calculator-refill-count"
                      >
                        ×{fmt(energyPlan.largeRefills)}
                      </CardTitle>
                    </div>
                  </div>
                  <Divider fullWidth />
                  <div className="requirement-calculator-banknotes">
                    <CardDescription size="sm">Итого</CardDescription>
                    <CardDescription
                      size="sm"
                      className="requirement-calculator-banknotes-value"
                    >
                      <CardTitle
                        as="span"
                        size="sm"
                        className="requirement-calculator-inline"
                      >
                        {fmt(energyPlan.banknotes)}
                      </CardTitle>{" "}
                      купюр
                    </CardDescription>
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
