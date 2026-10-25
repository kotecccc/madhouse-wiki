import {
  buildBusinessAssistantPlan,
  normalizeBusinessDetails,
  normalizeBusinessInventory,
} from "../../src/lib/business-assistant.js";

const positive = (n) => Number.isSafeInteger(n) && n > 0;
export const BUSINESS_NOTICES = {
  business_run_active: "Сначала остановите текущий сбор материалов.",
  business_run_limit_required: "Укажите общий лимит боёв или время сбора.",
  business_unknown: "Этот бизнес отсутствует в справочнике.",
  business_invalid_config: "Проверьте целевой и текущий уровни и лимит боёв.",
  business_refresh_failed:
    "Не удалось обновить игровые данные. Сохранённые значения могут быть устаревшими.",
  business_active_battle: "Сначала завершите активный бой с другим боссом.",
  business_action_pending: "Дождитесь завершения текущего игрового действия.",
  business_goal_exists: "Уже есть активная цель. Подтвердите её замену.",
  business_missing_unknown:
    "Недостающее количество пока неизвестно. Обновите запасы и укажите текущий уровень.",
  business_manual_level_changed:
    "Ручной текущий уровень отличается от данных игры. Очистите поле ручного уровня и сохраните план.",
  business_stock_changed:
    "Запасы или уровень изменились. Проверьте обновлённый расчёт и создайте цель заново.",
  business_nothing_missing: "Этот материал уже собран в нужном количестве.",
  business_boss_unknown:
    "У выбранного босса не подтверждён дроп этого материала.",
};
export const emptyBusinessHelper = () => ({
  configs: {},
  selectedBusinessId: null,
  resources: { details: {}, inventory: null, updatedAt: null },
  notice: null,
});
export function businessReference(catalogue, businessId) {
  const business = catalogue.businesses.find((item) => item.id === businessId);
  if (!business) throw new Error("business_unknown");
  return {
    business,
    upgrade: catalogue.businessUpgrades.find(
      (item) => item.businessId === business.id,
    ),
    bosses: catalogue.bosses,
  };
}
export function businessPlan(
  saved,
  catalogue,
  businessId,
  config = saved.configs[businessId],
) {
  const ref = businessReference(catalogue, businessId);
  return buildBusinessAssistantPlan({
    ...ref,
    config,
    resources: saved.resources,
  });
}
export function selectBusiness(saved, catalogue, businessId) {
  const { business } = businessReference(catalogue, businessId);
  if (!saved.configs[businessId]) {
    const level = saved.resources.details[businessId]?.level;
    const targetLevel = Number.isSafeInteger(level)
      ? Math.min(level + 1, business.maxLevel || level + 1)
      : 1;
    saved.configs[businessId] = {
      targetLevel: Math.max(1, targetLevel),
      currentLevelOverride: null,
      maxAttempts: null,
      durationHours: 2,
      bossChoices: {},
    };
  }
  saved.selectedBusinessId = businessId;
  saved.notice = null;
}
export function saveBusiness(saved, catalogue, args) {
  const { business } = businessReference(catalogue, args.businessId);
  const override = args.currentLevelOverride ?? null,
    cap = args.maxAttempts ?? null;
  if (
    !positive(args.targetLevel) ||
    (positive(business.maxLevel) && args.targetLevel > business.maxLevel) ||
    (override != null &&
      (!Number.isSafeInteger(override) ||
        override < 0 ||
        override > args.targetLevel)) ||
    (cap != null && !positive(cap)) ||
    (args.durationHours != null && ![1, 2, 4].includes(args.durationHours)) ||
    (args.bossChoices != null &&
      (typeof args.bossChoices !== "object" ||
        Array.isArray(args.bossChoices) ||
        Object.entries(args.bossChoices).some(
          ([key, value]) => !positive(Number(key)) || !positive(value),
        )))
  )
    throw new Error("business_invalid_config");
  saved.configs[business.id] = {
    targetLevel: args.targetLevel,
    currentLevelOverride: override,
    maxAttempts: cap,
    durationHours: args.durationHours === undefined ? 2 : args.durationHours,
    bossChoices: { ...args.bossChoices },
  };
  saved.selectedBusinessId = business.id;
  saved.notice = "План сохранён на сервере.";
}
export function businessProjection(saved, catalogue) {
  return {
    run: saved.run ?? null,
    selectedBusinessId: saved.selectedBusinessId,
    plans: Object.keys(saved.configs).flatMap((businessId) => {
      try {
        return [businessPlan(saved, catalogue, businessId)];
      } catch {
        return [];
      }
    }),
    notice: saved.notice,
    updatedAt: saved.resources.updatedAt,
  };
}
export async function refreshBusiness(
  saved,
  catalogue,
  businessId,
  { get, now },
) {
  const { business } = businessReference(catalogue, businessId);
  const apiId = Number(business.apiId);
  const tasks = [
    get("/api/me/bag"),
    positive(apiId) ? get(`/api/businesses/${apiId}`) : Promise.resolve(null),
  ];
  const [bag, detail] = await Promise.allSettled(tasks);
  let complete = true;
  if (bag.status === "fulfilled") {
    saved.resources.inventory = normalizeBusinessInventory(bag.value);
    if (!Array.isArray(bag.value?.activityItems)) complete = false;
  } else complete = false;
  if (detail.status === "fulfilled" && detail.value != null) {
    const normalized = normalizeBusinessDetails(detail.value, business);
    if (normalized) saved.resources.details[business.id] = normalized;
    else complete = false;
  } else if (positive(apiId)) complete = false;
  saved.resources.updatedAt = now();
  saved.notice = complete
    ? "Игровые данные обновлены."
    : BUSINESS_NOTICES.business_refresh_failed;
  return complete;
}
