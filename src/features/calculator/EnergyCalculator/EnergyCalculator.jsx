import { MonoLabel } from "../../../components/ui/MonoLabel/MonoLabel.jsx";
import "./EnergyCalculator.css";
import { calculateCycleEnergy } from "../../../lib/energy.js";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { NumberField } from "../../../components/ui/NumberField/NumberField.jsx";
import { SelectField } from "../../../components/ui/SelectField/SelectField.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { useState } from "react";
import { calcFloors, getDepartmentWorks } from "../../../model/knowledge-base.js";
import { fmt, fmtEnergy } from "../../../lib/format.js";
import { Title } from "../../../components/ui/Title/Title.jsx";
export function EnergyCalculator() {
  const [calcFloor, setCalcFloor] = useState(calcFloors[0]?.code || "A");
  const [calcWork, setCalcWork] = useState("");
  const [runCount, setRunCount] = useState("");
  const [calcResult, setCalcResult] = useState(null);
  const selectedFloor =
    calcFloors.find((floor) => floor.code === calcFloor) || calcFloors[0];
  const calcWorks = getDepartmentWorks(selectedFloor);
  const activeWork =
    calcWorks.find((work) => work.code === calcWork) || calcWorks[0];
  const currentCost = activeWork?.energyCycle?.full;
  return (
    <section
      className="calculator-section"
      id="calculator"
      aria-labelledby="calc-title"
    >
      <BaseCard
        as="form"
        className="calc-card"
        onSubmit={(e) => {
          e.preventDefault();
          setCalcResult(calculateCycleEnergy(currentCost, Number(runCount)));
        }}
      >
        <div className="calc-card-head">
          <div>
            <MonoLabel>РАСЧЁТ ПОЛНОГО ЦИКЛА</MonoLabel>
            <Title as="h2" id="calc-title">Энергия на работёнку</Title>
          </div>
        </div>
        <SelectField
          id="calc-floor"
          label="Этаж"
          value={selectedFloor?.code || ""}
          options={calcFloors.map((floor) => ({
            id: floor.id,
            value: floor.code,
            label: `Этаж ${floor.code}`,
          }))}
          onChange={(event) => {
            setCalcFloor(event.target.value);
            setCalcWork("");
            setCalcResult(null);
          }}
        />
        <SelectField
          id="calc-work"
          label="Работёнка"
          value={activeWork?.code || ""}
          options={calcWorks.map((work) => ({
            id: work.id,
            value: work.code,
            label: work.code,
          }))}
          onChange={(event) => {
            setCalcWork(event.target.value);
            setCalcResult(null);
          }}
        />
        <NumberField
          id="run-count"
          label="Количество циклов "
          hint="N"
          suffix="РАЗ"
          placeholder="Например, 5"
          required
          value={runCount}
          onChange={(event) => setRunCount(event.target.value)}
        />
        <Button variant="primary" className="calculate-button" type="submit">
          Посчитать <span aria-hidden="true">→</span>
        </Button>
        <BaseCard className="calc-result" aria-live="polite">
          <span>ИТОГО</span>
          <strong>
            {calcResult ? fmtEnergy(calcResult.total) : "—"} <small>⚡</small>
          </strong>
          <p>
            {calcResult
              ? `${fmt(calcResult.cost)} ⚡ за полный цикл × ${fmt(calcResult.count)} циклов`
              : currentCost == null
                ? "Для этой работёнки пока нет цены полного цикла"
                : `${fmt(currentCost)} ⚡ за полный цикл`}
          </p>
        </BaseCard>
      </BaseCard>
    </section>
  );
}
