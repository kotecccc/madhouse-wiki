import { useEffect, useSyncExternalStore } from "react";
import { characterUpgrade } from "../../bosses/BossBattle/boss-battle-session.js";
import {
  affordableCharacterUpgradeQuote,
  characterUpgradeQuote,
} from "../../../lib/character-stat-upgrades.js";
import { ApprovableButton } from "../../../components/ui/ConfirmButton/ConfirmButton.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { Divider } from "../../../components/ui/Divider/Divider.jsx";
import { ErrorToast } from "../../../components/ui/ErrorToast/ErrorToast.jsx";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
import { fmt } from "../../../lib/format.js";

const stats = [
  ["madness", "Безумие"],
  ["aggression", "Агрессия"],
  ["rage", "Ярость"],
];

export function ProfileStatsMenu() {
  const state = useSyncExternalStore(
    characterUpgrade.subscribe,
    characterUpgrade.getSnapshot,
    characterUpgrade.getSnapshot,
  );
  useEffect(() => {
    void characterUpgrade.refresh({ ifComplete: true });
  }, []);
  const resetAt = Date.parse(state.profile?.characterStatsUpgrade?.resetAtUtc);
  useEffect(() => {
    const delay = resetAt - Date.now();
    if (!Number.isFinite(delay) || delay <= 0 || delay > 2147483647)
      return undefined;
    const timer = setTimeout(() => void characterUpgrade.refresh(), delay + 1);
    return () => clearTimeout(timer);
  }, [resetAt]);
  const blocked =
    state.busy ||
    state.blocked ||
    state.pending ||
    state.run?.status === "running";
  const activate = async (selection) => {
    if (selection.amount === 1)
      await characterUpgrade.upgrade({
        stat: selection.stat,
        expected: selection,
      });
    else
      await characterUpgrade.start({
        stat: selection.stat,
        amount: selection.amount,
        expected: selection,
      });
  };
  return (
    <>
      <ErrorToast
        message={
          state.error ||
          (state.notice === "Характеристика улучшена." ? null : state.notice)
        }
      />
      {stats.map(([stat, label]) => {
        const current = resetAt > Date.now();
        const single = current
          ? characterUpgradeQuote(state.profile, stat, 1)
          : null;
        const maximum = current
          ? affordableCharacterUpgradeQuote(state.profile, stat)
          : null;
        const total = state.profile?.characterStats?.[stat]?.total;
        const limitReached =
          resetAt > Date.now() &&
          state.profile?.characterStatsUpgrade?.[stat]?.dailyRemaining === 0;
        return (
          <div key={stat}>
            <div className="overview-stat-menu-heading">
              <div className="overview-stat-menu-label">
                <Icon type={stat} />
                <CardTitle size="sm">{label}</CardTitle>
              </div>
              <CardTitle size="sm">
                {Number.isSafeInteger(total) ? fmt(total) : "—"}
              </CardTitle>
            </div>
            {!limitReached &&
              [
                { label: "Прокачать", quote: single, value: "+1" },
                {
                  label: "Прокачать MAX",
                  quote: maximum,
                  value: `+${maximum?.amount ?? 0}`,
                },
              ].map(({ label: action, quote, value }) => (
                <ApprovableButton
                  key={action}
                  variant="menu-item"
                  icon={
                    action === "Прокачать MAX" ? "chevrons-up" : "chevron-up"
                  }
                  menuValue={value}
                  liftOnHover={false}
                  confirmationKey={JSON.stringify(quote)}
                  confirmationLabel={
                    quote ? (
                      <>
                        Точно? · {fmt(quote.maxPrice)}{" "}
                        <Icon
                          type={quote.currency === "gold" ? "coin" : "pill"}
                          size="small"
                        />
                      </>
                    ) : (
                      "Точно?"
                    )
                  }
                  disabled={blocked || !quote || quote.balance < quote.maxPrice}
                  onClick={() => void activate(quote)}
                >
                  {action}
                </ApprovableButton>
              ))}
            <Divider menu />
          </div>
        );
      })}
    </>
  );
}
