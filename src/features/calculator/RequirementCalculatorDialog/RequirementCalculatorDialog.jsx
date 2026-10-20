import { MonoLabel } from "../../../components/ui/MonoLabel/MonoLabel.jsx";
import "./RequirementCalculatorDialog.css";
import { calculateRecovery } from "../../../lib/energy.js";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { useState } from "react";
import { Dialog } from "../../../components/ui/Dialog/Dialog.jsx";
import { NumberField } from "../../../components/ui/NumberField/NumberField.jsx";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { fmt, fmtEnergy, restoreTime } from "../../../lib/format.js";
import { Title } from "../../../components/ui/Title/Title.jsx";
export function RequirementCalculatorDialog({ conditionDialog, onClose }) {
  const [energyLimit, setEnergyLimit] = useState("");
  if (!conditionDialog) return null;
  const requirementCalc = conditionDialog?.energy;
  let conditionResult = "Введи лимит энергии для расчёта.";
  if (
    energyLimit !== "" &&
    Number.isFinite(Number(energyLimit)) &&
    Number(energyLimit) >= 0
  ) {
    if (!requirementCalc)
      conditionResult =
        "Для этого условия подтверждённая стоимость энергии в источниках не указана.";
    else {
      const recovery = calculateRecovery(requirementCalc, Number(energyLimit));
      const rem = recovery.remaining;
      conditionResult = `Энергия на условие: ${fmtEnergy(requirementCalc)} ⚡. При полном запасе ${fmt(energyLimit)} ⚡ останется восстановить ${fmtEnergy(rem)} ⚡ — ${restoreTime(recovery.minutes)}.${rem > 0 ? ` Дефибриллятор +280 ⚡: ${recovery.largeRefills} шт. · ${fmt(recovery.largeRefills * 10)} купюр. Дефибриллятор +28 ⚡: ${recovery.smallRefills} шт. · ${fmt(recovery.smallRefills * 2)} купюр.` : ""}`;
    }
  }

  return (
    <Dialog
      className="requirement-calculator-dialog"
      onClose={onClose}
      aria-labelledby="requirement-calc-title"
    >
      <form
        className="requirement-calculator-card"
        onSubmit={(e) => {
          e.preventDefault();
          onClose();
        }}
      >
        <Button
          className="requirement-calculator-close"
          onClick={onClose}
          aria-label="Закрыть"
        >
          ×
        </Button>
        <MonoLabel>РАСЧЁТ УСЛОВИЯ</MonoLabel>
        <Title as="h2" id="requirement-calc-title">Калькулятор</Title>
        <BaseCard as="p" className="requirement-calculator-condition">
          {conditionDialog.requirement.label || "Условие не указано"}
        </BaseCard>
        <NumberField
          id="requirement-energy-limit"
          label="Лимит энергии"
          suffix="⚡"
          placeholder="Например, 185"
          value={energyLimit}
          onChange={(event) => setEnergyLimit(event.target.value)}
        />
        <BaseCard className="requirement-calculator-result" aria-live="polite">
          {conditionDialog.energy
            ? `Стоимость условия: ${fmtEnergy(conditionDialog.energy)} ⚡. Расчёт времени предполагает полный запас перед началом.`
            : conditionDialog.requirement.type === "boss_kills"
              ? "Для убийств босса цена боя в подключённых источниках не указана — точное время рассчитать нельзя."
              : "Для этого условия в подключённых источниках не указана подтверждённая стоимость энергии."}
          <p>{conditionResult}</p>
        </BaseCard>
        <p className="requirement-calculator-note">
          1 энергия восстанавливается за 2 минуты. Дефибриллятор: +28 энергии за
          2 купюры или +280 за 10 купюр.
        </p>
      </form>
    </Dialog>
  );
}
