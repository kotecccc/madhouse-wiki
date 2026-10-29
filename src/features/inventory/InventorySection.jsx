import { inventoryNeedsCheck, sendInventoryCommand } from "./equipment.js";
import { InventoryVirtualCard } from "./InventoryVirtualCard.jsx";
import { InventoryLoadMore } from "./InventoryLoadMore.jsx";
import { inventoryHeaderLoading } from "./loading-state.js";
import { Skeleton } from "../../components/ui/Skeleton/Skeleton.jsx";
import { Modal } from "../../components/ui/Modal/Modal.jsx";
import { Pill } from "../../components/ui/Pill/Pill.jsx";
import { InventoryItemCard } from "./InventoryItemCard.jsx";
import { useEffect, useRef, useState } from "react";
import { knowledgeBase } from "virtual:madhouse-catalogue";
import {
  getSessionJson,
  readStoredSessionJson,
  postSessionJson,
  peekSessionUpdatedAt,
  subscribeSessionData,
  readGameHealth,
} from "../../../shared/session-api.js";
import { featureForGamePath } from "../../../shared/game-health-features.js";
import {
  inventoryCategories,
  inventoryGroups,
  inventoryCategoryOptions,
  inventoryItems,
  inventoryPaths,
  filterInventory,
} from "./inventory.js";
import { runInventoryReadAttempts } from "./read-retry.js";
import { SegmentedControl } from "../../components/ui/SegmentedControl/SegmentedControl.jsx";
import { BaseCard } from "../../components/ui/BaseCard/BaseCard.jsx";
import { Button } from "../../components/ui/Button/Button.jsx";
import { Input } from "../../components/ui/Input/Input.jsx";
import { SelectField } from "../../components/ui/SelectField/SelectField.jsx";
import { CardTitle } from "../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../components/ui/CardDescription/CardDescription.jsx";
import { StatusMessage } from "../../components/ui/StatusMessage/StatusMessage.jsx";
import "./InventorySection.css";

const references = knowledgeBase.inventoryItems || [];
const inventoryRequestPaths = new Set(
  inventoryCategories.flatMap(({ id }) => inventoryPaths(id, references)),
);
const options = (values) =>
  values.map(([value, label]) => ({ id: value, value, label }));
const initialFilters = {
  search: "",
  status: "all",
  slot: "all",
  currency: "all",
  sort: "potential",
};
const PAGE_SIZE = 10;
const SHOW_FILTERS = false;
const SHOW_SUMMARY = false;

export function InventorySection({
  active,
  responses,
  dirtyPaths = [],
  incompletePaths = [],
  playerLevel,
  target,
  refreshGeneration = 0,
  onNotice,
  onLoadingChange,
}) {
  const equipmentPending = useRef(false);
  const [equipmentState, setEquipmentState] = useState({
    busy: false,
    needsCheck: false,
    notice: null,
  });
  async function equip(
    item,
    action = item?.equipped ? "unequip" : "equip",
    refreshOnly = false,
  ) {
    if (equipmentPending.current) return;
    equipmentPending.current = true;
    setEquipmentState({ busy: true, needsCheck: false, notice: null });
    try {
      await sendInventoryCommand({
        get: getSessionJson,
        post: postSessionJson,
        item,
        action,
        type: item?.type ?? category,
        zoneId:
          item?.zoneId ??
          references.find((entry) => entry.type === category && entry.zoneId)
            ?.zoneId,
        refreshOnly,
      });
      setEquipmentState({
        busy: false,
        needsCheck: false,
        notice: refreshOnly
          ? "Экипировка проверена."
          : "Действие добавлено в очередь.",
      });
      if (!refreshOnly)
        onNotice?.({ message: "Действие добавлено в очередь.", success: true });
    } catch (error) {
      const needsCheck = await inventoryNeedsCheck(getSessionJson);
      setEquipmentState({ busy: false, needsCheck, notice: null });
      onNotice?.({
        message: `${needsCheck ? "Не удалось подтвердить действие. Попробуйте снова." : "Не удалось выполнить действие. Если работает автоматизация, сначала остановите её."}${error.inventoryReason ? ` Причина: ${error.inventoryReason}.` : error.status ? ` Код ответа: ${error.status}.` : ""}${error.inventoryStage ? ` Этап: ${error.inventoryStage}.` : ""}`,
        success: false,
      });
    } finally {
      equipmentPending.current = false;
    }
  }
  const [category, setCategory] = useState("clothing_item");
  const [filters, setFilters] = useState(initialFilters);
  const [targetId, setTargetId] = useState(null);
  useEffect(() => {
    if (
      !target ||
      target.id == null ||
      !inventoryCategories.some(({ id }) => id === target.type)
    )
      return;
    setCategory(target.type);
    setFilters(initialFilters);
    setTargetId(String(target.id));
  }, [target]);
  const [updatedAt, setUpdatedAt] = useState({});
  const [requestState, setRequestState] = useState({});
  const loadController = useRef(null);
  const dirtyRef = useRef(dirtyPaths);
  useEffect(() => {
    dirtyRef.current = dirtyPaths;
  }, [dirtyPaths]);
  const refreshRequested = useRef(false);
  const [revision, setRevision] = useState(0);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [nextOpen, setNextOpen] = useState(false);
  const nextItems =
    Number.isSafeInteger(playerLevel) && playerLevel > 0
      ? (knowledgeBase.wardrobeItems || []).filter(
          (item) => item.requiredLevel === playerLevel + 1,
        )
      : [];
  const lastRefreshGeneration = useRef(refreshGeneration);
  useEffect(() => {
    if (!active || lastRefreshGeneration.current === refreshGeneration) return;
    lastRefreshGeneration.current = refreshGeneration;
    refreshRequested.current = true;
    setRevision((value) => value + 1);
  }, [active, refreshGeneration]);
  const paths = inventoryPaths(category, references);
  const pathKey = paths.join("|");
  const previousDirty = useRef(new Set());
  useEffect(() => {
    const previous = previousDirty.current;
    previousDirty.current = new Set(dirtyPaths);
    if (
      active &&
      dirtyPaths.some(
        (path) => pathKey.split("|").includes(path) && !previous.has(path),
      )
    )
      setRevision((value) => value + 1);
  }, [active, dirtyPaths, pathKey]);
  useEffect(
    () =>
      subscribeSessionData((event) => {
        if (event.cleared) {
          loadController.current?.abort();
          setRevision((value) => value + 1);
          setUpdatedAt({});
          setRequestState({});
        } else if (inventoryRequestPaths.has(event.path) && event.data) {
          setUpdatedAt((current) => ({
            ...current,
            [event.path]: event.updatedAt ?? null,
          }));
        }
      }),
    [],
  );
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    loadController.current = controller;
    const fresh = refreshRequested.current;
    refreshRequested.current = false;
    setRequestState((current) => ({
      ...current,
      ...Object.fromEntries(
        pathKey
          .split("|")
          .filter(Boolean)
          .map((path) => [path, "pending"]),
      ),
    }));
    // Session API deduplicates requests and paces them across every account view.
    // revalidate:false prevents timer/focus refreshes of inventory sections.
    function load() {
      for (const path of pathKey.split("|").filter(Boolean)) {
        setUpdatedAt((current) => ({
          ...current,
          [path]: peekSessionUpdatedAt(path),
        }));
        setRequestState((current) => ({ ...current, [path]: "loading" }));
        if (!fresh) {
          void readStoredSessionJson(path, { signal: controller.signal })
            .then((result) => {
              if (!controller.signal.aborted)
                setRequestState((current) => ({
                  ...current,
                  [path]: result.presence === "present" ? "ready" : "missing",
                }));
            })
            .catch(() => {
              if (!controller.signal.aborted)
                setRequestState((current) => ({ ...current, [path]: "error" }));
            });
          continue;
        }
        void runInventoryReadAttempts({
          signal: controller.signal,
          read: (attempt, signal) =>
            getSessionJson(path, {
              signal,
              revalidate: false,
              fresh: attempt > 1 || fresh || dirtyRef.current.includes(path),
              serverRefresh:
                attempt > 1 || fresh || dirtyRef.current.includes(path)
                  ? "live"
                  : false,
            }),
          isFailedResponse: () =>
            readGameHealth().failedFeatures.includes(featureForGamePath(path)),
          onData: () => {
            if (controller.signal.aborted) return;
            setUpdatedAt((current) => ({
              ...current,
              [path]: peekSessionUpdatedAt(path),
            }));
          },
        }).then(({ status }) => {
          if (controller.signal.aborted || status === "cancelled") return;
          setRequestState((current) => ({
            ...current,
            [path]: status === "ready" ? "ready" : "error",
          }));
        });
      }
    }
    load();
    return () => {
      controller.abort();
      if (loadController.current === controller) loadController.current = null;
    };
  }, [active, pathKey, revision]);
  const items = inventoryItems(category, responses, references);
  const filtered = filterInventory(items, filters).filter(
    (item) => targetId === null || String(item.id) === targetId,
  );
  const loading =
    paths.some((path) => ["pending", "loading"].includes(requestState[path])) ||
    (active && paths.length > 0 && paths.some((path) => !requestState[path]));
  useEffect(() => {
    onLoadingChange?.(inventoryHeaderLoading(active, loading));
  }, [active, loading, onLoadingChange]);
  const failed = paths.filter((path) =>
    ["error", "missing"].includes(requestState[path]),
  ).length;
  const missing = paths.some((path) => requestState[path] === "missing");
  const loaded = paths.filter((path) => responses[path]).length;
  const categoryUpdatedAt =
    paths.length &&
    paths.every(
      (path) => Number.isFinite(updatedAt[path]) && updatedAt[path] > 0,
    )
      ? Math.min(...paths.map((path) => updatedAt[path]))
      : null;
  const slotValues = [
    ...new Set(
      items
        .map((item) =>
          category === "ornament" ? item.zoneId : item.categoryId,
        )
        .filter((value) => value != null),
    ),
  ].sort((a, b) => Number(a) - Number(b));
  function changeFilter(key, value) {
    setFilters((current) => ({ ...current, [key]: value }));
    setLimit(PAGE_SIZE);
  }
  const processedTattooZones = paths.filter((path) =>
    ["ready", "error"].includes(requestState[path]),
  ).length;

  return (
    <section className="inventory-section" aria-label="Инвентарь">
      {paths.some((path) => incompletePaths.includes(path)) && (
        <CardDescription>
          Полнота сохранённых данных не подтверждена.
        </CardDescription>
      )}
      {nextItems.length > 0 && (
        <Button icon="loot" onClick={() => setNextOpen(true)}>
          Уровень {playerLevel + 1} · {nextItems.length}
        </Button>
      )}
      {nextOpen && nextItems.length > 0 && (
        <Modal
          onClose={() => setNextOpen(false)}
          title={`Предметы уровня ${playerLevel + 1}`}
        >
          <div className="inventory-next-dialog">
            <CardTitle as="h2">Уровень {playerLevel + 1}</CardTitle>
            <div className="inventory-grid">
              {nextItems.map((item) => (
                <InventoryItemCard
                  key={`${item.type}:${item.id}`}
                  item={{ ...item, status: "locked" }}
                />
              ))}
            </div>
            <Button onClick={() => setNextOpen(false)}>Закрыть</Button>
          </div>
        </Modal>
      )}
      <div className="inventory-toolbar">
        <div className="inventory-category-scroll">
          <SegmentedControl
            label="Категория предметов"
            size="sm"
            compactIcons
            className="inventory-category-control"
            options={inventoryCategoryOptions(responses, references)}
            value={category}
            onChange={(id) => {
              setCategory(id);
              setTargetId(null);
              setRevision(0);
              setFilters(initialFilters);
              setLimit(PAGE_SIZE);
            }}
          />
        </div>
      </div>
      {targetId !== null && (
        <Button onClick={() => setTargetId(null)}>Показать все предметы</Button>
      )}
      {SHOW_FILTERS && (
        <BaseCard className="inventory-filters">
          <Input
            type="search"
            aria-label="Поиск по названию"
            placeholder="Найти предмет"
            value={filters.search}
            onChange={(event) => changeFilter("search", event.target.value)}
          />
          <SelectField
            id="inventory-status"
            label="Наличие"
            value={filters.status}
            onChange={(event) => changeFilter("status", event.target.value)}
            options={options([
              ["all", "Все предметы"],
              ["owned", "Мои"],
              ["buyable", "Можно купить"],
              ["equipped", "Экипировано"],
              ["locked", "Закрыто"],
              ["unknown", "Статус неизвестен"],
            ])}
          />
          <SelectField
            id="inventory-currency"
            label="Валюта"
            value={filters.currency}
            onChange={(event) => changeFilter("currency", event.target.value)}
            options={options([
              ["all", "Любая валюта"],
              ["gold", "Монеты"],
              ["dollar", "Доллары"],
              ["pills", "Пилюли"],
              ["stars", "Звёзды"],
            ])}
          />
          <SelectField
            id="inventory-sort"
            label="Сортировка"
            value={filters.sort}
            onChange={(event) => changeFilter("sort", event.target.value)}
            options={options([
              ["potential", "По потенциалу на максимуме"],
              ["name", "По названию"],
              ["price", "Цена ↑ внутри валюты"],
            ])}
          />
          {["clothing_item", "ornament"].includes(category) && (
            <SelectField
              id="inventory-slot"
              label={category === "ornament" ? "Зона" : "Слот"}
              value={filters.slot}
              onChange={(event) => changeFilter("slot", event.target.value)}
              options={options([
                ["all", "Все"],
                ...slotValues.map((value) => [
                  String(value),
                  category === "ornament"
                    ? `Зона ${value}`
                    : items.find(
                        (item) => String(item.categoryId) === String(value),
                      )?.slotLabel || `Слот ${value}`,
                ]),
              ])}
            />
          )}
          <Button
            onClick={() => {
              setFilters(initialFilters);
              setLimit(PAGE_SIZE);
            }}
          >
            Сбросить фильтры
          </Button>
        </BaseCard>
      )}
      {SHOW_SUMMARY && (
        <div role="status" aria-live="polite" className="inventory-summary">
          <CardDescription>
            {loading
              ? `Загрузка ${loaded}/${paths.length}`
              : `Всего ${items.length} · Мои ${items.filter((item) => item.status === "owned").length} · Купить ${items.filter((item) => item.status === "buyable").length}`}
          </CardDescription>
          <CardDescription title="Дата обновления самых старых данных категории">
            {categoryUpdatedAt ? (
              <time dateTime={new Date(categoryUpdatedAt).toISOString()}>
                {new Intl.DateTimeFormat("ru", {
                  day: "2-digit",
                  month: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                }).format(categoryUpdatedAt)}
              </time>
            ) : (
              "Дата неизвестна"
            )}
          </CardDescription>
        </div>
      )}
      {category === "ornament" && loading && (
        <span className="sr-only" role="status" aria-live="polite">
          Загрузка татуировок: обработано {processedTattooZones} из{" "}
          {paths.length} зон.
        </span>
      )}
      {loading && (category === "ornament" || !loaded) && (
        <div
          className="inventory-grid"
          role="status"
          aria-label="Загрузка инвентаря"
        >
          {Array.from({ length: 10 }, (_, id) => (
            <Skeleton key={id} as="article" />
          ))}
        </div>
      )}
      {!loading && missing && (
        <StatusMessage
          compact
          icon="loot"
          title="Данные ещё не получены"
          description="Обновите категорию после подключения игры."
        />
      )}
      {!loading && !failed && !filtered.length && (
        <StatusMessage
          compact
          icon="loot"
          title={
            paths.length
              ? "Нет подходящих предметов"
              : "Нет подтверждённых разделов"
          }
          description={
            paths.length
              ? "Обновите категорию."
              : "Идентификаторы зон ещё не получены в справочник."
          }
        />
      )}
      {!(category === "ornament" && loading) && (
        <div className="inventory-groups" aria-busy={loading}>
          {inventoryGroups.map((group) => {
            const groupItems = filtered
              .slice(0, limit)
              .filter((item) => item.status === group.status);
            if (!groupItems.length) return null;
            return (
              <section
                className="inventory-group"
                key={group.status}
                aria-label={group.label}
              >
                <div className="inventory-group-heading">
                  <CardTitle as="h3">{group.label}</CardTitle>
                  <Pill
                    size="2xs"
                    dot={false}
                    aria-label={`Всего в группе: ${filtered.filter((item) => item.status === group.status).length}`}
                  >
                    {
                      filtered.filter((item) => item.status === group.status)
                        .length
                    }
                  </Pill>
                </div>
                <div className="inventory-grid">
                  {groupItems.map((item) => (
                    <InventoryVirtualCard
                      key={`${item.type}:${item.id}`}
                      item={item}
                      onAction={equip}
                      equipmentBusy={equipmentState.busy}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
      {!(category === "ornament" && loading) && filtered.length > limit && (
        <InventoryLoadMore
          active={active}
          remaining={filtered.length - limit}
          onLoad={() =>
            setLimit((value) => Math.min(value + PAGE_SIZE, filtered.length))
          }
        />
      )}
    </section>
  );
}
