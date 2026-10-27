import { ErrorToast } from "../../../components/ui/ErrorToast/ErrorToast.jsx";
import { Toast } from "../../../components/ui/Toast/Toast.jsx";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
import { ImageCard } from "../../../components/ui/ImageCard/ImageCard.jsx";
import { Wallet } from "../../../components/ui/Wallet/Wallet.jsx";
import "./CharacterUpgrade.css";
import { Modal } from "../../../components/ui/Modal/Modal.jsx";
import { characterUpgrade } from "../../bosses/BossBattle/boss-battle-session.js";
import {
  allCharacterUpgradesComplete,
  characterUpgradeQuote,
} from "../../../lib/character-stat-upgrades.js";
import { getSessionJson } from "../../../../shared/session-api.js";
import { fmt } from "../../../lib/format.js";

const stats = [
  ["madness", "Безумие", "madness", "здоровье"],
  ["aggression", "Агрессия", "aggression", "урон"],
  ["rage", "Ярость", "rage", "шанс крита"],
];
const amountText = (value) => (Number.isSafeInteger(value) ? fmt(value) : "—");

export function CharacterUpgrade({ onClose, profileWallet = [] }) {
  const state = useSyncExternalStore(
    characterUpgrade.subscribe,
    characterUpgrade.getSnapshot,
    characterUpgrade.getSnapshot,
  );
  const [armed, setArmed] = useState(null);
  const [approvedSingles, setApprovedSingles] = useState({});
  const [submittedSingle, setSubmittedSingle] = useState(null);
  const [queueNotice, setQueueNotice] = useState(false);
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
  useEffect(() => {
    if (
      !submittedSingle ||
      state.run?.id !== submittedSingle.id ||
      state.run?.status === "running"
    )
      return;
    setApprovedSingles((current) => ({
      ...current,
      [submittedSingle.key]: state.run?.status === "completed",
    }));
    setSubmittedSingle(null);
  }, [submittedSingle, state.run?.id, state.run?.status]);
  const pending = Boolean(state.pending);
  const running = state.run?.status === "running";
  const blocked = Boolean(state.blocked);
  const profile = state.profile;
  const allQuotes = stats.map(([stat]) => {
    const remaining = profile?.characterStatsUpgrade?.[stat]?.dailyRemaining;
    return remaining === 0
      ? null
      : characterUpgradeQuote(profile, stat, remaining);
  });
  const allReady = Boolean(
    profile &&
    stats.every(
      ([stat], index) =>
        profile.characterStatsUpgrade?.[stat]?.dailyRemaining === 0 ||
        allQuotes[index],
    ),
  );
  const availableQuotes = allQuotes.filter(Boolean);
  const allAffordable = ["gold", "pills"].every((currency) => {
    const total = availableQuotes
      .filter((q) => q.currency === currency)
      .reduce((sum, q) => sum + q.maxPrice, 0);
    return (
      Number.isSafeInteger(total) &&
      (total === 0 || profile?.wallet?.[currency] >= total)
    );
  });
  const activate = async (key, selection) => {
    if (!selection || state.busy || blocked) return;
    const signature = JSON.stringify(selection);
    const alreadyApproved = key.startsWith("single:") && approvedSingles[key];
    if (
      !alreadyApproved &&
      (armed?.key !== key || armed.signature !== signature)
    ) {
      setArmed({ key, signature });
      return;
    }
    setArmed(null);
    const previousRunId = characterUpgrade.getSnapshot().run?.id;
    const ok = selection.quotes
      ? await characterUpgrade.startAll({ quotes: selection.quotes })
      : selection.amount === 1
        ? await characterUpgrade.upgrade({
            stat: selection.stat,
            expected: selection,
          })
        : await characterUpgrade.start({
            stat: selection.stat,
            amount: selection.amount,
            expected: selection,
          });
    const runId = characterUpgrade.getSnapshot().run?.id;
    if (ok) setQueueNotice(true);
    if (
      ok &&
      key.startsWith("single:") &&
      !running &&
      !pending &&
      !characterUpgrade.getSnapshot().queued &&
      runId &&
      runId !== previousRunId
    )
      setSubmittedSingle({ key, id: runId });
    if (ok)
      void getSessionJson("/api/me", {
        fresh: true,
        serverRefresh: "live",
      }).catch(() => {});
  };
  const isArmed = (key, selection) =>
    Boolean(
      selection &&
      armed?.key === key &&
      armed.signature === JSON.stringify(selection),
    );
  const allSelection = { quotes: availableQuotes };
  const allArmed = isArmed("all", allSelection);
  return (
    <Modal
      title="Прокачка характеристик"
      onClose={onClose}
      loading={state.busy}
      footerStart={<Button onClick={onClose}>Закрыть</Button>}
      footer={
        allCharacterUpgradesComplete(profile?.characterStatsUpgrade) ? (
          <></>
        ) : (
          <Button
            variant={allArmed ? "warning" : "primary"}
            disabled={
              state.busy ||
              blocked ||
              !allReady ||
              !availableQuotes.length ||
              !allAffordable
            }
            onClick={() => void activate("all", allSelection)}
          >
            {allArmed ? "Точно? Прокачать всё" : "Прокачать всё"}
          </Button>
        )
      }
    >
      <ErrorToast message={state.error} />
      <ErrorToast
        message={
          state.notice === "Характеристика улучшена." ? null : state.notice
        }
      />
      {state.run &&
        !running &&
        ["uncertain", "stopped", "error"].includes(state.run.status) && (
          <ErrorToast message={state.run.reason} />
        )}
      {queueNotice && (
        <Toast
          floating
          success
          title="В очереди"
          onDismiss={() => setQueueNotice(false)}
        >
          Прокачка добавлена в очередь.
        </Toast>
      )}
      {pending && (
        <Button
          onClick={() => void characterUpgrade.refresh()}
          disabled={state.busy}
        >
          Проверить состояние
        </Button>
      )}
      {profile?.wallet && (
        <BaseCard padding="12">
          <Wallet
            entries={[
              ["Монеты", profile.wallet.gold, "coin"],
              ["Пилюли", profile.wallet.pills, "pill"],
              [
                "Доллары",
                profile.wallet.dollar ??
                  profileWallet.find(([, , icon]) => icon === "banknote")?.[1],
                "banknote",
              ],
            ]}
          />
        </BaseCard>
      )}
      {stats.map(([stat, label, icon, description]) => {
        const info = profile?.characterStatsUpgrade?.[stat];
        const quote = characterUpgradeQuote(profile, stat, 1);
        const maximum = characterUpgradeQuote(
          profile,
          stat,
          info?.dailyRemaining,
        );
        return (
          <BaseCard key={stat} padding="12" className="character-upgrade-card">
            <div className="character-upgrade-heading">
              <ImageCard size={48}>
                <Icon type={icon} size="large" />
              </ImageCard>
              <div className="character-upgrade-copy">
                <CardTitle>
                  {label} ({description})
                </CardTitle>
                <CardDescription>
                  <span className="character-upgrade-projection">
                    {amountText(profile?.characterStats?.[stat]?.total)}
                    <Icon type="arrow-right" size="text" />
                    <span className="sr-only">до</span>
                    {amountText(
                      Number.isSafeInteger(
                        profile?.characterStats?.[stat]?.total,
                      ) && Number.isSafeInteger(info?.dailyRemaining)
                        ? profile.characterStats[stat].total +
                            info.dailyRemaining
                        : null,
                    )}
                  </span>
                </CardDescription>
              </div>
              <CardDescription>
                Сегодня: {amountText(info?.dailyUsed)} /{" "}
                {amountText(info?.dailyLimit)}
              </CardDescription>
            </div>
            {info?.dailyRemaining !== 0 && (
              <div className="character-upgrade-actions">
                <Button
                  variant={
                    isArmed(`single:${stat}`, quote) ? "warning" : "primary"
                  }
                  disabled={
                    state.busy ||
                    blocked ||
                    !quote ||
                    quote.balance < quote.nextCost
                  }
                  onClick={() => void activate(`single:${stat}`, quote)}
                >
                  {isArmed(`single:${stat}`, quote) ? "Точно · " : "+1 · "}
                  {quote ? (
                    <>
                      {fmt(quote.nextCost)}{" "}
                      <Icon
                        type={quote.currency === "gold" ? "coin" : "pill"}
                        size="small"
                      />
                    </>
                  ) : (
                    "Нет данных"
                  )}
                </Button>
                <Button
                  variant={
                    isArmed(`max:${stat}`, maximum) ? "warning" : "primary"
                  }
                  disabled={
                    state.busy ||
                    blocked ||
                    !maximum ||
                    maximum.balance < maximum.maxPrice
                  }
                  onClick={() => void activate(`max:${stat}`, maximum)}
                >
                  {isArmed(`max:${stat}`, maximum) ? "Точно · " : "+MAX · "}
                  {maximum ? (
                    <>
                      до {fmt(maximum.maxPrice)}{" "}
                      <Icon
                        type={maximum.currency === "gold" ? "coin" : "pill"}
                        size="small"
                      />
                    </>
                  ) : (
                    "Нет данных"
                  )}
                </Button>
              </div>
            )}
          </BaseCard>
        );
      })}
    </Modal>
  );
}
