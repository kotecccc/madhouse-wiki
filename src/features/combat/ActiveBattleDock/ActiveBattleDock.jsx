import { useEffect, useState, useSyncExternalStore } from "react";
import {
  readSession,
  subscribeSession,
} from "../../../../shared/auth-session.js";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
import { Modal } from "../../../components/ui/Modal/Modal.jsx";
import {
  workFarm,
  businessAssistant,
  bossBattle,
  bossBattleAuto,
  pvpBattle,
  connectBattleSession,
  disconnectBattleSession,
} from "../../bosses/BossBattle/boss-battle-session.js";
import { Pill } from "../../../components/ui/Pill/Pill.jsx";
import { ProgressBar } from "../../../components/ui/ProgressBar/ProgressBar.jsx";
import { ImageCard } from "../../../components/ui/ImageCard/ImageCard.jsx";
import { BossPortrait } from "../../bosses/BossPortrait/BossPortrait.jsx";
import { fmt } from "../../../lib/format.js";
import { activeBattleEntries } from "./active-battle-state.js";
import { WorkFarmDialog } from "../../works/WorkCard/WorkFarmDialog.jsx";
import "./ActiveBattleDock.css";

const outcomes = {
  active: "Бой идёт",
  won: "Победа",
  lost: "Поражение",
  expired: "Бой завершён",
  surrendered: "Бой завершён",
};

export function ActiveBattleAutoStatus({ auto, onStop }) {
  return (
    <div className="active-battle-auto">
      <Pill
        variant={auto.enabled ? "active" : "scheduled"}
        size="xs"
        dot={false}
      >
        {auto.enabled ? "Авто включено" : "Авто выключено"}
      </Pill>
      {auto.enabled && (
        <Button
          size="sm"
          onClick={(event) => {
            event.stopPropagation();
            onStop?.();
          }}
          aria-label="Остановить автоудары"
        >
          Стоп
        </Button>
      )}
    </div>
  );
}

export function BossActiveBattleBar({ battle, auto, boss, onOpen, onStop }) {
  const healthText = (value, max) =>
    value == null
      ? "нет данных"
      : `${fmt(value)}${max == null ? "" : ` / ${fmt(max)}`}`;
  const activate = (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    onOpen();
  };
  return (
    <BaseCard
      variant="glass-nav"
      className="active-battle-boss-bar"
      role="group"
      aria-label="Бой с боссом"
      onClick={onOpen}
    >
      <div
        className="active-battle-boss-open"
        role="button"
        tabIndex={0}
        aria-haspopup="dialog"
        aria-label={`Открыть бой с боссом: ${boss.name}`}
        onKeyDown={activate}
      >
        <BossPortrait src={boss.reference?.image} alt={boss.name} />
        <div className="active-battle-health">
          <CardDescription>
            HP босса · {healthText(battle?.bossHealth, battle?.bossMaxHealth)}
          </CardDescription>
          <ProgressBar
            animateLoss
            animationKey={battle?.id}
            label="HP босса"
            value={battle?.bossHealth ?? 0}
            max={battle?.bossMaxHealth ?? 1}
            valueText={healthText(battle?.bossHealth, battle?.bossMaxHealth)}
          />
        </div>
        <div className="active-battle-health">
          <CardDescription>
            Ваше HP ·{" "}
            {healthText(battle?.playerHealth, battle?.playerMaxHealth)}
          </CardDescription>
          <ProgressBar
            animateLoss
            animationKey={battle?.id}
            label="Ваше HP"
            value={battle?.playerHealth ?? 0}
            max={battle?.playerMaxHealth ?? 1}
            valueText={healthText(
              battle?.playerHealth,
              battle?.playerMaxHealth,
            )}
          />
        </div>
      </div>
      <ActiveBattleAutoStatus auto={auto} onStop={onStop} />
    </BaseCard>
  );
}

export function ActiveBattleControl() {
  const boss = useSyncExternalStore(
    bossBattle.subscribe,
    bossBattle.getSnapshot,
    bossBattle.getSnapshot,
  );
  const pvp = useSyncExternalStore(
    pvpBattle.subscribe,
    pvpBattle.getSnapshot,
    pvpBattle.getSnapshot,
  );
  const auto = useSyncExternalStore(
    bossBattleAuto.subscribe,
    bossBattleAuto.getSnapshot,
    bossBattleAuto.getSnapshot,
  );
  const business = useSyncExternalStore(
    businessAssistant.subscribe,
    businessAssistant.getSnapshot,
    businessAssistant.getSnapshot,
  );
  const farm = useSyncExternalStore(
    workFarm.subscribe,
    workFarm.getSnapshot,
    workFarm.getSnapshot,
  );
  const [farmOpen, setFarmOpen] = useState(false);
  const farmRun = farm.run?.status === "running" ? farm.run : null;
  const collection = business.run?.status === "running" ? business.run : null;
  const [now, setNow] = useState(Date.now);
  const [choosing, setChoosing] = useState(false);
  useEffect(() => {
    const sync = () => {
      disconnectBattleSession();
      if (readSession().status === "ready") void connectBattleSession();
    };
    sync();
    const unsubscribe = subscribeSession(sync);
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
      disconnectBattleSession();
    };
  }, []);
  const entries = activeBattleEntries(boss, pvp, now, auto);
  useEffect(() => {
    if (entries.length < 2) setChoosing(false);
  }, [entries.length]);
  function open(entry) {
    setChoosing(false);
    if (entry.kind === "boss") {
      pvpBattle.close();
      bossBattle.open(
        { numericId: boss.boss.id, name: boss.boss.name },
        { refresh: !bossBattleAuto.getSnapshot().enabled },
      );
    } else {
      bossBattle.close();
      pvpBattle.open();
    }
  }
  const activate = () =>
    entries.length === 1 ? open(entries[0]) : setChoosing(true);
  const bossEntry = entries.find((entry) => entry.kind === "boss");
  const pvpEntry = entries.find((entry) => entry.kind === "pvp");
  return (
    <>
      {farmRun && (
        <BaseCard variant="glass-nav" className="active-battle-control">
          <div className="active-battle-desktop">
            <Button icon="energy" onClick={() => setFarmOpen(true)}>
              Фарм · {farmRun.title} ·{" "}
              {farm.view?.completedCycles ?? farmRun.completedCycles} /{" "}
              {farmRun.targetCycles}
            </Button>
          </div>
          <div className="active-battle-mobile">
            <Button
              variant="nav-tab"
              aria-label={`Фарм: ${farmRun.title}`}
              onClick={() => setFarmOpen(true)}
            >
              <Icon type="energy" size="large" />
            </Button>
          </div>
          <Button size="sm" onClick={() => void workFarm.stop()}>
            Стоп
          </Button>
        </BaseCard>
      )}
      {farmOpen && farm.run && (
        <WorkFarmDialog
          work={{
            workId: farm.run.workId,
            id: `work:${farm.run.workId}`,
            title: farm.run.title,
          }}
          onClose={() => setFarmOpen(false)}
        />
      )}
      {collection && !bossEntry && (
        <BaseCard
          variant="glass-nav"
          className="active-battle-control"
          role="status"
        >
          <CardDescription>
            Сбор материалов · {collection.name} · уровень{" "}
            {collection.targetLevel}
          </CardDescription>
          <Button onClick={() => void businessAssistant.stopRun()}>
            Остановить сбор
          </Button>
        </BaseCard>
      )}
      {entries.length > 0 && (
        <div className="active-battle-control" aria-label="Текущий бой">
          {bossEntry && (
            <>
              <div className="active-battle-desktop active-battle-boss-desktop">
                <BossActiveBattleBar
                  boss={boss.boss}
                  battle={boss.battle}
                  auto={auto}
                  onOpen={() => open(bossEntry)}
                  onStop={bossBattleAuto.stop}
                />
              </div>
              <BaseCard variant="glass-nav" className="active-battle-mobile">
                <Button
                  variant="nav-tab"
                  aria-label={`Открыть бой с боссом: ${boss.boss.name}`}
                  title={boss.boss.name}
                  aria-haspopup="dialog"
                  onClick={() => open(bossEntry)}
                >
                  <ImageCard
                    src={boss.boss.reference?.image}
                    alt=""
                    size={32}
                    imageSize={32}
                  >
                    <Icon type="boss" size="large" />
                  </ImageCard>
                </Button>
              </BaseCard>
            </>
          )}
          {pvpEntry && (
            <BaseCard variant="glass-nav" className="active-battle-pvp-card">
              <div className="active-battle-desktop">
                <Button
                  variant="nav-tab"
                  aria-haspopup="dialog"
                  onClick={() => open(pvpEntry)}
                >
                  <Icon type="combat" size="large" />
                  <span className="active-battle-copy">
                    <CardTitle as="span" size="sm">
                      {pvpEntry.title}
                    </CardTitle>
                    <CardDescription as="span" size="xs">
                      Текущий бой PvP
                    </CardDescription>
                  </span>
                </Button>
              </div>
              <div className="active-battle-mobile">
                <Button
                  variant="nav-tab"
                  aria-haspopup="dialog"
                  aria-label={
                    entries.length > 1 ? "Текущие бои" : pvpEntry.title
                  }
                  onClick={activate}
                >
                  <Icon type="combat" size="large" />
                </Button>
              </div>
            </BaseCard>
          )}
        </div>
      )}
      {choosing && entries.length > 0 && (
        <Modal title="Текущие бои" onClose={() => setChoosing(false)}>
          {entries.map((entry) => (
            <Button
              key={entry.kind}
              icon={entry.kind === "boss" ? "boss" : "combat"}
              onClick={() => open(entry)}
            >
              {entry.title}
            </Button>
          ))}
        </Modal>
      )}
      {pvp.visible && (
        <Modal
          title="Текущий бой PvP"
          onClose={pvpBattle.close}
          footer={
            <>
              <Button onClick={pvpBattle.close}>Закрыть</Button>
              <Button
                disabled={pvp.pending}
                onClick={() => void pvpBattle.refresh()}
              >
                {pvp.pending ? "Обновление…" : "Обновить"}
              </Button>
            </>
          }
        >
          {pvp.battle ? (
            <>
              <CardTitle>
                {outcomes[pvp.battle.status] || "Состояние боя не определено"}
              </CardTitle>
              <BaseCard>
                <CardTitle>Вы</CardTitle>
                <CardDescription>
                  HP:{" "}
                  {pvp.battle.playerHealth == null
                    ? "нет данных"
                    : fmt(pvp.battle.playerHealth)}
                </CardDescription>
              </BaseCard>
              <BaseCard>
                <CardTitle>Соперник</CardTitle>
                <CardDescription>
                  HP:{" "}
                  {pvp.battle.opponentHealth == null
                    ? "нет данных"
                    : fmt(pvp.battle.opponentHealth)}
                </CardDescription>
              </BaseCard>
            </>
          ) : (
            <CardDescription>
              {pvp.pending
                ? "Обновляем бой…"
                : pvp.error
                  ? "Не удалось загрузить бой."
                  : "Активный бой PvP не найден."}
            </CardDescription>
          )}
        </Modal>
      )}
    </>
  );
}
