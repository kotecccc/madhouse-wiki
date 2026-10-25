import { Divider } from "../../../components/ui/Divider/Divider.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { NumberStepper } from "../../../components/ui/NumberStepper/NumberStepper.jsx";
import { ProgressBar } from "../../../components/ui/ProgressBar/ProgressBar.jsx";
import { LoadingStatus } from "../../../components/ui/LoadingStatus/LoadingStatus.jsx";
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

export function RequirementCalculatorDialog({
  conditionDialog,
  onClose,
  countControl,
  title,
  intro,
  showCloseButton = false,
  accountState,
  energyOverride,
  recoveryPlan,
  optionActions,
  afterOptions,
  loading = false,
}) {
  const [energyLimit, setEnergyLimit] = useState("");
  const [localProfileEnergy, setProfileEnergy] = useState(null);
  const [localProfileStatus, setProfileStatus] = useState("idle");

  const profileEnergy =
    accountState === undefined ? localProfileEnergy : accountState.energy;
  const profileStatus =
    accountState === undefined ? localProfileStatus : accountState.status;

  useEffect(() => {
    if (accountState !== undefined) return;
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
  }, [conditionDialog, accountState]);

  if (!conditionDialog) return null;
  const countValue =
    countControl && countControl.value !== ""
      ? Number(countControl.value)
      : null;
  const countResult =
    countControl && countValue !== null
      ? calculateCycleEnergy(countControl.unitEnergy, countValue)
      : null;
  const requirementCalc =
    energyOverride !== undefined
      ? energyOverride
      : countControl
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
    recoveryPlan !== undefined
      ? recoveryPlan
      : requirementCalc != null && maxEnergy != null && currentEnergy != null
        ? calculateRequirementEnergy(requirementCalc, maxEnergy, currentEnergy)
        : null;

  return (
    <Modal
      className="requirement-calculator-dialog"
      title={title || calculatorTitle}
      titleId="requirement-calc-title"
      width={620}
      showCloseButton={showCloseButton}
      contentVariant="inset"
      loading={loading}
      onClose={onClose}
    >
      <form
        className="requirement-calculator-card"
        onSubmit={(event) => {
          event.preventDefault();
          onClose();
        }}
      >
        {intro}
        {countControl && (
          <NumberStepper
            id="work-calculator-count"
            label={countControl.label || "Количество выполнений"}
            hideLabel
            compact
            min={countControl.min ?? 1}
            max={countControl.max ?? Number.MAX_SAFE_INTEGER}
            value={Number(countControl.value)}
            onChange={(value) => countControl.onChange(String(value))}
            decrementLabel="Уменьшить количество выполнений"
            incrementLabel="Увеличить количество выполнений"
            rangeLabel={
              countControl.rangeLabel || "Количество полных выполнений работы"
            }
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
              <div className="requirement-calculator-total">
                <LoadingStatus>
                  Загружаю запас энергии из профиля…
                </LoadingStatus>
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
                      {energyPlan.minutes == null
                        ? "—"
                        : restoreTime(energyPlan.minutes)}
                    </CardTitle>
                  </div>
                  {optionActions?.wait}
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
                      size="medium"
                      className="requirement-calculator-option-icon"
                    />
                  </div>
                  <Divider fullWidth />
                  <div
                    className="requirement-calculator-refills"
                    aria-label="Дефибрилляторы для восстановления энергии"
                  >
                    <div className="requirement-calculator-refill">
                      <Icon type="defibrillator-small" size="large" />
                      <span className="requirement-calculator-refill-copy">
                        <CardTitle size="sm">Малый</CardTitle>
                        <CardDescription size="2xs">
                          {energyPlan.smallLabel || "10% лимита"}
                        </CardDescription>
                      </span>
                      <CardTitle
                        as="span"
                        size="sm"
                        className="requirement-calculator-refill-count"
                      >
                        ×
                        {energyPlan.smallRefills == null
                          ? "—"
                          : fmt(energyPlan.smallRefills)}
                      </CardTitle>
                    </div>
                    <div className="requirement-calculator-refill">
                      <Icon type="defibrillator-large" size="large" />
                      <span className="requirement-calculator-refill-copy">
                        <CardTitle size="sm">Большой</CardTitle>
                        <CardDescription size="2xs">
                          {energyPlan.largeLabel || "100% лимита"}
                        </CardDescription>
                      </span>
                      <CardTitle
                        as="span"
                        size="sm"
                        className="requirement-calculator-refill-count"
                      >
                        ×
                        {energyPlan.largeRefills == null
                          ? "—"
                          : fmt(energyPlan.largeRefills)}
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
                        {energyPlan.banknotes == null
                          ? "—"
                          : fmt(energyPlan.banknotes)}
                      </CardTitle>{" "}
                      купюр
                    </CardDescription>
                  </div>
                  {optionActions?.purchase && (
                    <div className="requirement-calculator-action">
                      {optionActions.purchase}
                    </div>
                  )}
                </BaseCard>
              </>
            )}
          </div>
        )}
        {afterOptions}
      </form>
    </Modal>
  );
}
