import { ErrorToast } from "../../../components/ui/ErrorToast/ErrorToast.jsx";
import { useId, useState } from "react";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { NumberField } from "../../../components/ui/NumberField/NumberField.jsx";
import { SelectField } from "../../../components/ui/SelectField/SelectField.jsx";
import { fmt } from "../../../lib/format.js";
import { canShopMedicines, canUseMedicine } from "./boss-battle-controller.js";
import {
  currencyNames,
  medicineNames,
  medicinePurchaseQuote,
} from "./boss-medicines.js";
import { bossBattle } from "./boss-battle-session.js";
import "./BossMedicinePanel.css";

export function BossMedicinePanel({ state, now }) {
  const id = useId();
  const [type, setType] = useState("heal_10");
  const [currencyChoice, setCurrency] = useState("");
  const [quantity, setQuantity] = useState("1");
  const item = state.medicines?.find((m) => m.type === type);
  const prices = item?.prices || [];
  const currency = prices.some((p) => p.currency === currencyChoice)
    ? currencyChoice
    : prices[0]?.currency || "";
  const quote = medicinePurchaseQuote(
    state.medicines,
    type,
    currency,
    Number(quantity),
  );
  const confirming = state.purchase;
  const busy = Boolean(state.pending);
  const fieldsDisabled = busy || Boolean(confirming);
  return (
    <BaseCard className="boss-medicine-panel" aria-label="Аптечки">
      <CardTitle as="h3">Аптечки</CardTitle>
      {state.notice && (
        <CardDescription role="status" title={state.notice}>
          {state.notice}
        </CardDescription>
      )}
      <div className="boss-medicine-fields">
        <SelectField
          id={`${id}-type`}
          label="Аптечка"
          value={type}
          disabled={fieldsDisabled}
          options={Object.entries(medicineNames).map(([value, label]) => ({
            id: value,
            value,
            label,
          }))}
          onChange={(event) => {
            setType(event.target.value);
            setCurrency("");
            bossBattle.cancelPurchase();
          }}
        />
      </div>
      <CardDescription>
        В запасе: {item?.quantity == null ? "нет данных" : fmt(item.quantity)}
      </CardDescription>
      <div className="boss-battle-actions">
        <Button
          icon="pill"
          disabled={!canUseMedicine(state, type, now)}
          onClick={() => void bossBattle.useMedicine(type)}
        >
          Использовать аптечку
        </Button>
      </div>
      {state.battle?.playerHealth != null &&
        state.battle.playerMaxHealth > 0 &&
        state.battle.playerHealth >= state.battle.playerMaxHealth && (
          <CardDescription>
            При полном здоровье лечение недоступно.
          </CardDescription>
        )}
      {state.medicines === null && (
        <CardDescription>Обновите данные о запасе и ценах.</CardDescription>
      )}
      <CardTitle as="h4">Покупка</CardTitle>
      <div className="boss-medicine-fields">
        <SelectField
          id={`${id}-currency`}
          label="Валюта и цена за штуку"
          value={currency}
          disabled={fieldsDisabled || !prices.length}
          options={
            prices.length
              ? prices.map((p) => ({
                  id: p.currency,
                  value: p.currency,
                  label: `${currencyNames[p.currency]}: ${fmt(p.amount)}`,
                }))
              : [{ id: "unknown", value: "", label: "Цены не получены" }]
          }
          onChange={(event) => {
            setCurrency(event.target.value);
            bossBattle.cancelPurchase();
          }}
        />
        <NumberField
          id={`${id}-quantity`}
          label="Количество"
          suffix="шт."
          min="1"
          max={item?.maxPurchaseQuantity ?? undefined}
          value={quantity}
          disabled={fieldsDisabled || !item?.maxPurchaseQuantity}
          onChange={(event) => {
            setQuantity(event.target.value);
            bossBattle.cancelPurchase();
          }}
        />
      </div>
      {item?.maxPurchaseQuantity != null && (
        <CardDescription>
          За одну покупку: до {fmt(item.maxPurchaseQuantity)} шт.
        </CardDescription>
      )}
      <CardDescription>
        Итого:{" "}
        {quote
          ? `${fmt(quote.total)} • ${currencyNames[quote.currency]}`
          : "выберите доступную цену и количество"}
      </CardDescription>
      {state.purchaseUncertain && (
        <>
          <ErrorToast message="Результат покупки неизвестен. Обновите и проверьте запас аптечек; покупка автоматически не повторяется." />
          <Button
            disabled={busy || state.needsRefresh || !state.medicines}
            onClick={bossBattle.acknowledgePurchase}
          >
            Запас проверен
          </Button>
        </>
      )}
      {confirming ? (
        <BaseCard
          className="boss-medicine-panel"
          aria-label="Подтверждение покупки"
        >
          <CardTitle>Подтвердите покупку</CardTitle>
          <CardDescription>
            {medicineNames[confirming.type]}: {fmt(confirming.quantity)} шт.
          </CardDescription>
          <CardDescription>
            Цена за штуку: {fmt(confirming.unitPrice)}
          </CardDescription>
          <CardDescription>
            Валюта: {currencyNames[confirming.currency]}
          </CardDescription>
          <CardTitle>Итого: {fmt(confirming.total)}</CardTitle>
          <CardDescription>
            После покупки аптечку нужно применить отдельно.
          </CardDescription>
          <div className="boss-battle-actions">
            <Button disabled={busy} onClick={bossBattle.cancelPurchase}>
              Отменить покупку
            </Button>
            <Button
              variant="primary"
              disabled={!canShopMedicines(state, now)}
              onClick={() => void bossBattle.buyMedicine()}
            >
              Подтвердить покупку
            </Button>
          </div>
        </BaseCard>
      ) : (
        <div className="boss-battle-actions">
          <Button
            icon="banknote"
            disabled={!quote || !canShopMedicines(state, now)}
            onClick={() =>
              bossBattle.preparePurchase(type, currency, Number(quantity))
            }
          >
            Купить…
          </Button>
        </div>
      )}
    </BaseCard>
  );
}
