import { formatTelegramBattle } from "./telegram-battle-report.mjs";

const MIN_UPDATE_MS = 15000;

// Uses only saved automation state and the local bridge status; never reads the game.
export function createTelegramBattleNotifier({
  telegram,
  now = Date.now,
  save,
  siteUrl,
}) {
  const inFlight = new Set();
  return {
    async tick(entry) {
      const report = entry.telegramReport;
      if (
        !telegram ||
        entry.storageFailed ||
        !report?.enabled ||
        !report.run ||
        inFlight.has(entry.playerId)
      )
        return;
      if (
        report.pendingSend ||
        now() < (report.nextAt || 0) ||
        now() < (entry.telegramNextCheckAt || 0)
      )
        return;
      entry.telegramNextCheckAt = now() + MIN_UPDATE_MS;
      inFlight.add(entry.playerId);
      try {
        const owner = telegram.ownerForPlayer(entry.playerId);
        if (!owner || owner !== report.owner) return;
        const state = entry.controller.getSnapshot();
        const observedOnline = await telegram.online(owner).catch(() => null);
        if (observedOnline === true) {
          entry.telegramOfflineChecks = 0;
          entry.telegramConfirmedOnline = true;
        } else if (observedOnline === false) {
          entry.telegramOfflineChecks = (entry.telegramOfflineChecks || 0) + 1;
          if (entry.telegramOfflineChecks >= 2)
            entry.telegramConfirmedOnline = false;
        }
        const online = entry.telegramConfirmedOnline ?? null;
        const text = formatTelegramBattle(report, {
          battle: state.battle,
          boss: state.boss,
          goal: entry.goal.getSnapshot(),
          raid: entry.raidWorker.getSnapshot(),
          subscription: entry.raidSubscription?.getSnapshot(),
          pausedAuto: Boolean(entry.pausedAuto),
          online,
          needsRefresh: state.needsRefresh,
          now: now(),
        });
        if (
          !entry.telegramReport?.enabled ||
          entry.telegramReport.owner !== owner ||
          entry.telegramReport.run?.startedAt !== report.run.startedAt ||
          telegram.ownerForPlayer(entry.playerId) !== owner
        )
          return;
        if (!text || text === report.lastText) return;
        const runStarted = report.run.startedAt;
        const messageId = report.messageId;
        const bossId = Number(
          state.boss?.id ?? entry.raidWorker.getSnapshot()?.bossId,
        );
        const page =
          Number.isSafeInteger(bossId) && bossId > 0
            ? new URL(`/boss/${bossId}`, siteUrl).toString()
            : new URL("/", siteUrl).toString();
        if (!messageId) {
          // A lost response may have created a Telegram message. Keep the
          // checkpoint so restart cannot create duplicate messages silently.
          entry.telegramReport = { ...report, pendingSend: true };
          save(entry);
          if (entry.storageFailed || !entry.telegramReport?.enabled) return;
        }
        try {
          const result = await telegram.request(
            messageId ? "editMessageText" : "sendMessage",
            {
              chat_id: Number(owner),
              ...(messageId ? { message_id: messageId } : {}),
              text,
              parse_mode: "HTML",
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text:
                        Number.isSafeInteger(bossId) && bossId > 0
                          ? "Открыть бой"
                          : "Открыть Wiki",
                      web_app: { url: page },
                    },
                  ],
                ],
              },
            },
          );
          if (entry.telegramReport?.run?.startedAt !== runStarted) return;
          const id = messageId || result?.message_id;
          if (!Number.isSafeInteger(id) || id <= 0)
            throw new Error("missing_message_id");
          entry.telegramReport = {
            ...entry.telegramReport,
            messageId: id,
            pendingSend: false,
            lastText: text,
            nextAt: now() + MIN_UPDATE_MS,
          };
          save(entry);
        } catch (error) {
          if (entry.telegramReport?.run?.startedAt !== runStarted) return;
          // Known rate-limit rejections did not create a message. Unknown send
          // outcomes remain checkpointed; edits are safe to retry.
          const knownRejected =
            Number.isInteger(error?.status) &&
            error.status >= 400 &&
            error.status < 500;
          entry.telegramReport = {
            ...entry.telegramReport,
            ...(error?.status === 403 ? { enabled: false } : {}),
            ...(error?.code === "message_missing" ? { messageId: null } : {}),
            pendingSend: !messageId && !knownRejected,
            nextAt:
              now() +
              Math.max(MIN_UPDATE_MS, Number(error?.retryAfterMs) || 30000),
          };
          save(entry);
        }
      } catch {
        // Notifications must never stop or retry a game action.
      } finally {
        inFlight.delete(entry.playerId);
      }
    },
  };
}
