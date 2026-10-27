import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { Modal } from "../../../components/ui/Modal/Modal.jsx";
import { characterUpgrade } from "../../bosses/BossBattle/boss-battle-session.js";
import { characterUpgradeQuote } from "../../../lib/character-stat-upgrades.js";
import { getSessionJson } from "../../../../shared/session-api.js";
import { fmt } from "../../../lib/format.js";

const stats = [
  ["madness", "Безумие"],
  ["aggression", "Агрессия"],
  ["rage", "Ярость"],
];
const amountText = (value) => (Number.isSafeInteger(value) ? fmt(value) : "—");

export function CharacterUpgrade({ onClose }) {
  const state = useSyncExternalStore(
    characterUpgrade.subscribe,
    characterUpgrade.getSnapshot,
    characterUpgrade.getSnapshot,
  );
  const [confirmation, setConfirmation] = useState(null);
  const previousRunStatus = useRef(state.run?.status);
  useEffect(() => {
    void characterUpgrade.refresh();
  }, []);
  useEffect(() => {
    const finished =
      previousRunStatus.current === "running" &&
      state.run?.status !== "running";
    previousRunStatus.current = state.run?.status;
    if (finished) {
      void characterUpgrade.refresh();
      void getSessionJson("/api/me", {
        fresh: true,
        serverRefresh: "live",
      }).catch(() => {});
    }
  }, [state.run?.status]);
  const pending = Boolean(state.pending);
  const running = state.run?.status === "running";
  const blocked = Boolean(state.blocked);
  const profile = state.profile;
  const submit = async () => {
    if (!confirmation || state.busy || pending || running || blocked) return;
    const ok =
      confirmation.amount === 1
        ? await characterUpgrade.upgrade({
            stat: confirmation.stat,
            expected: confirmation,
          })
        : await characterUpgrade.start({
            stat: confirmation.stat,
            amount: confirmation.amount,
            expected: confirmation,
          });
    setConfirmation(null);
    if (ok)
      void getSessionJson("/api/me", {
        fresh: true,
        serverRefresh: "live",
      }).catch(() => {});
  };
  return (
    <Modal
      title="Прокачка характеристик"
      onClose={onClose}
      loading={state.busy}
    >
      {state.error && (
        <CardDescription role="alert">{state.error}</CardDescription>
      )}
      {state.notice && (
        <CardDescription role="status">{state.notice}</CardDescription>
      )}
      {blocked && !running && (
        <CardDescription>
          Остановите бой или другую автоматизацию перед прокачкой.
        </CardDescription>
      )}
      {state.run && (
        <BaseCard padding="12">
          <CardTitle>{running ? "Прокачка выполняется" : "Прокачка"}</CardTitle>
          <CardDescription>
            {state.run.reason ||
              `Выполнено ${fmt(state.run.completed)} из ${fmt(state.run.target)} · потрачено ${fmt(state.run.spent)}`}
          </CardDescription>
          {running && (
            <Button onClick={() => void characterUpgrade.stop()}>
              Остановить
            </Button>
          )}
        </BaseCard>
      )}
      {pending && (
        <Button
          onClick={() => void characterUpgrade.refresh()}
          disabled={state.busy}
        >
          Проверить состояние
        </Button>
      )}
      {stats.map(([stat, label]) => {
        const info = profile?.characterStatsUpgrade?.[stat];
        const quote = characterUpgradeQuote(profile, stat, 1);
        const maximum = characterUpgradeQuote(
          profile,
          stat,
          info?.dailyRemaining,
        );
        return (
          <BaseCard key={stat} padding="12">
            <CardTitle>
              {label} · {amountText(profile?.characterStats?.[stat]?.total)}
            </CardTitle>
            <CardDescription>
              Сегодня: {amountText(info?.dailyUsed)} /{" "}
              {amountText(info?.dailyLimit)}
            </CardDescription>
            <Button
              disabled={
                state.busy ||
                running ||
                blocked ||
                pending ||
                !quote ||
                quote.balance < quote.nextCost
              }
              onClick={() => setConfirmation(quote)}
            >
              +1 ·{" "}
              {quote
                ? `${fmt(quote.nextCost)} ${quote.currency === "gold" ? "монет" : "пилюль"}`
                : info?.dailyRemaining === 0
                  ? "Лимит достигнут"
                  : "Нет данных"}
            </Button>
            <Button
              disabled={
                state.busy ||
                running ||
                blocked ||
                pending ||
                !maximum ||
                maximum.balance < maximum.nextCost
              }
              onClick={() => setConfirmation(maximum)}
            >
              +MAX ·{" "}
              {maximum
                ? fmt(maximum.amount)
                : info?.dailyRemaining === 0
                  ? "0"
                  : "Нет данных"}
            </Button>
          </BaseCard>
        );
      })}
      {confirmation && (
        <BaseCard padding="12">
          <CardTitle>Подтвердите улучшение</CardTitle>
          <CardDescription>
            {confirmation.amount === 1
              ? "Расход"
              : `До ${fmt(confirmation.amount)} улучшений, расход не более`}
            : {fmt(confirmation.maxPrice)}{" "}
            {confirmation.currency === "gold" ? "монет" : "пилюль"}.
          </CardDescription>
          <Button onClick={() => setConfirmation(null)}>Отмена</Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            disabled={state.busy || pending || running || blocked}
          >
            Прокачать
          </Button>
        </BaseCard>
      )}
    </Modal>
  );
}
