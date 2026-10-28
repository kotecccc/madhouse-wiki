const TERMINAL = new Set(["won", "lost", "expired", "surrendered"]);
const MAX_REPORT_BYTES = 512 * 1024;
const number = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : null;
const escape = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
const format = (value) =>
  number(value) == null ? "—" : new Intl.NumberFormat("ru-RU").format(value);
function dropName(item) {
  if (typeof item.name === "string" && item.name.trim())
    return item.name.trim().slice(0, 80);
  if (
    item.type === "mutagen" &&
    typeof item.mutagenType === "string" &&
    /^[IAXFSZW]$/i.test(item.mutagenType) &&
    number(item.mutagenLevel) > 0
  )
    return `Мутаген ${item.mutagenType.toUpperCase()}-${item.mutagenLevel}`;
  if (item.type === "stash_ingredient" && item.setId && item.ingredientId)
    return `Компонент ${item.setId}/${item.ingredientId}`.slice(0, 80);
  const id = item.entityId ?? item.itemId ?? item.elementId;
  return `${item.type || "Предмет"}${id != null ? ` №${id}` : ""}`.slice(0, 80);
}

// Called when server-owned battle state is saved. No game requests are made.
export function observeTelegramBattle(
  previous,
  {
    battle,
    boss,
    auto,
    raid,
    subscription,
    pausedAuto,
    needsRefresh,
    healing,
    now,
  },
) {
  if (!previous?.enabled) return previous;
  const running =
    battle?.status === "active" ||
    auto?.enabled ||
    pausedAuto ||
    raid?.enabled ||
    raid?.userPaused ||
    subscription?.enabled;
  let next = { ...previous };
  if (running && (!next.run || next.run.endedAt)) {
    next = {
      ...next,
      messageId: null,
      lastText: null,
      pendingSend: false,
      trackingLimited: false,
      run: { startedAt: now, endedAt: null, battles: {} },
    };
  }
  if (!next.run) return next;
  if (battle?.id && TERMINAL.has(battle.status) && !needsRefresh) {
    const old = next.run.battles[battle.id];
    const record = {
      bossId: number(battle.bossId ?? boss?.id),
      bossName: String(boss?.name || "Босс").slice(0, 80),
      status: battle.status,
      rewardKnown: battle.rewardKnown === true,
      currencyRewards:
        battle.rewardKnown === true && Array.isArray(battle.currencyRewards)
          ? battle.currencyRewards
              .filter(
                (item) =>
                  ["gold", "pills", "dollar", "exp"].includes(item?.type) &&
                  number(item?.amount) != null,
              )
              .map(({ type, amount }) => ({ type, amount }))
              .slice(0, 4)
          : [],
      drops:
        battle.rewardKnown === true && Array.isArray(battle.grantedDrops)
          ? battle.grantedDrops
              .filter((item) => number(item?.amount) > 0)
              .slice(0, 100)
              .map((item) => ({
                name: dropName(item),
                amount: item.amount,
              }))
          : [],
      healing: {
        heal_10: number(healing?.used?.heal_10) ?? 0,
        heal_full: number(healing?.used?.heal_full) ?? 0,
      },
    };
    if (old?.rewardKnown && !record.rewardKnown) {
      record.rewardKnown = true;
      record.currencyRewards = old.currencyRewards;
      record.drops = old.drops;
    }
    if (!old || JSON.stringify(old) !== JSON.stringify(record)) {
      next.run = {
        ...next.run,
        battles: { ...next.run.battles, [battle.id]: record },
      };
    }
  }
  if (!running && !next.run.endedAt) next.run = { ...next.run, endedAt: now };
  // A reporting history must never exhaust the storage used by game actions.
  if (Buffer.byteLength(JSON.stringify(next)) > MAX_REPORT_BYTES)
    return {
      ...previous,
      trackingLimited: true,
      run:
        !running && previous.run && !previous.run.endedAt
          ? { ...previous.run, endedAt: now }
          : previous.run,
    };
  return next;
}

export function formatTelegramBattle(
  report,
  {
    battle,
    boss,
    goal,
    raid,
    subscription,
    pausedAuto,
    online,
    needsRefresh,
    now,
  },
) {
  if (!report?.run) return "";
  const run = report.run;
  const records = Object.values(run.battles || {});
  const wins = records.filter((entry) => entry.status === "won").length;
  const lines = [
    run.endedAt
      ? "<b>Боевая серия завершена</b>"
      : raid?.enabled || raid?.userPaused || subscription?.enabled
        ? "<b>Рейд</b>"
        : "<b>Бой</b>",
  ];
  if (boss?.name) lines.push(`<b>${escape(boss.name)}</b>`);
  if (battle) {
    if (
      number(battle.bossHealth) != null &&
      number(battle.bossMaxHealth) != null
    )
      lines.push(
        `Босс: ${format(battle.bossHealth)} / ${format(battle.bossMaxHealth)} HP`,
      );
    if (
      number(battle.playerHealth) != null &&
      number(battle.playerMaxHealth) != null
    )
      lines.push(
        `Вы: ${format(battle.playerHealth)} / ${format(battle.playerMaxHealth)} HP`,
      );
    const parts = [];
    if (number(battle.attackCount) != null)
      parts.push(`Ударов: ${format(battle.attackCount)}`);
    else if (Array.isArray(battle.events)) {
      const observed = new Set(
        battle.events
          .filter(
            (event) =>
              event.isSelf &&
              number(event.turn) != null &&
              number(event.damage) != null &&
              !event.itemType,
          )
          .map((event) => event.turn),
      ).size;
      if (observed) parts.push(`Ударов: не менее ${format(observed)}`);
    }
    if (number(battle.totalDamage) != null)
      parts.push(`Урон: ${format(battle.totalDamage)}`);
    if (parts.length) lines.push(parts.join(" · "));
    if (
      number(battle.dropDamageRequired) != null &&
      number(battle.totalDamage) != null
    )
      lines.push(
        `Норма: ${format(battle.totalDamage)} / ${format(battle.dropDamageRequired)}`,
      );
    if (TERMINAL.has(battle.status) && needsRefresh)
      lines.push("Результат боя уточняется.");
    else if (TERMINAL.has(battle.status))
      lines.push(
        {
          won: "Победа",
          lost: "Поражение",
          expired: "Время боя истекло",
          surrendered: "Бой сдан",
        }[battle.status],
      );
  } else if (raid?.enabled || subscription?.enabled)
    lines.push("Ждём приглашение.");
  if (raid?.userPaused || pausedAuto) lines.push("На паузе.");
  if (online === false && !run.endedAt) lines.push("Связь с мостом потеряна.");
  if (needsRefresh && !run.endedAt)
    lines.push("Данные боя могут быть неактуальны.");
  if (records.length)
    lines.push(
      `За серию${Number.isFinite(now) ? ` (${Math.max(0, Math.floor(((run.endedAt ?? now) - run.startedAt) / 60000))} мин)` : ""}: ${records.length} боёв, побед: ${wins}.`,
    );
  if (report.trackingLimited)
    lines.push("Длинная серия: часть боёв не вошла в сводку.");
  const bosses = new Map();
  for (const record of records)
    bosses.set(record.bossName, (bosses.get(record.bossName) || 0) + 1);
  if (bosses.size)
    lines.push(
      `Боссы: ${[...bosses]
        .slice(0, 8)
        .map(([name, count]) => `${escape(name)} — ${count}`)
        .join(", ")}`,
    );
  if (
    goal?.rewardUncertain ||
    records.some((item) => item.status === "won" && !item.rewardKnown)
  )
    lines.push("Награда уточняется.");
  const totals = {};
  for (const record of records)
    for (const reward of record.currencyRewards || [])
      totals[reward.type] = (totals[reward.type] || 0) + reward.amount;
  const labels = {
    gold: "монет",
    pills: "таблеток",
    dollar: "долларов",
    exp: "опыта",
  };
  const rewards = Object.entries(totals)
    .filter(([, value]) => Number.isSafeInteger(value))
    .map(([type, value]) => `${format(value)} ${labels[type]}`);
  if (rewards.length) lines.push(`Получено: ${rewards.join(" · ")}`);
  const drops = new Map();
  for (const record of records)
    for (const item of record.drops || [])
      drops.set(item.name, (drops.get(item.name) || 0) + item.amount);
  if (drops.size)
    lines.push(
      `Добыча: ${[...drops]
        .slice(0, 6)
        .map(([name, amount]) => `${escape(name)} ×${format(amount)}`)
        .join(", ")}${drops.size > 6 ? ` и ещё ${drops.size - 6} видов` : ""}`,
    );
  const healing = records.reduce(
    (sum, record) =>
      sum + (record.healing?.heal_10 || 0) + (record.healing?.heal_full || 0),
    0,
  );
  if (healing) lines.push(`Использовано аптечек: ${format(healing)}`);
  return lines.join("\n");
}
