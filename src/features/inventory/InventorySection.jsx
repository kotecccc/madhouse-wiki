import { useEffect, useRef, useState } from "react";
import { knowledgeBase } from "virtual:madhouse-catalogue";
import {
  getSessionJson,
  peekSessionJson,
  peekSessionUpdatedAt,
  subscribeSessionData,
} from "../../../shared/session-api.js";
import {
  inventoryCategories,
  inventoryCategoryOptions,
  inventoryItems,
  inventoryPaths,
  filterInventory,
} from "./inventory.js";
import { SegmentedControl } from "../../components/ui/SegmentedControl/SegmentedControl.jsx";
import { BaseCard } from "../../components/ui/BaseCard/BaseCard.jsx";
import { Button } from "../../components/ui/Button/Button.jsx";
import { Input } from "../../components/ui/Input/Input.jsx";
import { SelectField } from "../../components/ui/SelectField/SelectField.jsx";
import { CardDescription } from "../../components/ui/CardDescription/CardDescription.jsx";
import { StatusMessage } from "../../components/ui/StatusMessage/StatusMessage.jsx";
import { ItemCard } from "../items/ItemCard/ItemCard.jsx";
import "./InventorySection.css";

const references = knowledgeBase.inventoryItems || [];
const inventoryRequestPaths = new Set(
  inventoryCategories.flatMap(({ id }) => inventoryPaths(id, references)),
);
const statuses = {
  owned: "В гардеробе",
  buyable: "Открыто для покупки",
  locked: "Закрыто",
  unknown: "Статус неизвестен",
};
const options = (values) =>
  values.map(([value, label]) => ({ id: value, value, label }));
const initialFilters = {
  search: "",
  status: "all",
  slot: "all",
  currency: "all",
  sort: "name",
};
const PAGE_SIZE = 36;
const SHOW_FILTERS = false;

export function InventorySection({ active }) {
  const [category, setCategory] = useState("clothing_item");
  const [filters, setFilters] = useState(initialFilters);
  const [responses, setResponses] = useState(() =>
    Object.fromEntries(
      [...inventoryRequestPaths].flatMap((path) => {
        const cached = peekSessionJson(path, { allowStale: true });
        return cached ? [[path, cached]] : [];
      }),
    ),
  );
  const [updatedAt, setUpdatedAt] = useState({});
  const [requestState, setRequestState] = useState({});
  const refreshRequested = useRef(false);
  const [revision, setRevision] = useState(0);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const paths = inventoryPaths(category, references);
  const pathKey = paths.join("|");
  useEffect(
    () =>
      subscribeSessionData((event) => {
        if (event.cleared) {
          setResponses({});
          setUpdatedAt({});
          setRequestState({});
        } else if (inventoryRequestPaths.has(event.path) && event.data) {
          setResponses((current) => ({ ...current, [event.path]: event.data }));
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
    let cancelled = false;
    const fresh = refreshRequested.current;
    refreshRequested.current = false;
    // Session API deduplicates requests and paces them across every account view.
    // revalidate:false prevents timer/focus refreshes of inventory sections.
    async function load() {
      for (const path of pathKey.split("|").filter(Boolean)) {
        if (cancelled) return;
        const cached = peekSessionJson(path, { allowStale: true });
        setUpdatedAt((current) => ({
          ...current,
          [path]: peekSessionUpdatedAt(path),
        }));
        if (cached) setResponses((current) => ({ ...current, [path]: cached }));
        setRequestState((current) => ({ ...current, [path]: "loading" }));
        try {
          const data = await getSessionJson(path, { revalidate: false, fresh });
          if (!cancelled) {
            setResponses((current) => ({ ...current, [path]: data }));
            setRequestState((current) => ({ ...current, [path]: "ready" }));
          }
        } catch {
          if (!cancelled)
            setRequestState((current) => ({ ...current, [path]: "error" }));
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [active, pathKey, revision]);
  const items = inventoryItems(category, responses, references);
  const filtered = filterInventory(items, filters);
  const loading = paths.some((path) => requestState[path] === "loading");
  const failed = paths.filter((path) => requestState[path] === "error").length;
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
  return (
    <section className="inventory-section" aria-label="Инвентарь">
      <div className="inventory-toolbar">
        <div className="inventory-category-scroll">
          <SegmentedControl
            label="Категория предметов"
            size="sm"
            className="inventory-category-control"
            options={inventoryCategoryOptions(responses, references)}
            value={category}
            onChange={(id) => {
              setCategory(id);
              setRevision(0);
              setFilters(initialFilters);
              setLimit(PAGE_SIZE);
            }}
          />
        </div>
        <Button
          variant="secondary"
          icon="refresh"
          iconOnly
          aria-label="Обновить категорию"
          title="Обновить категорию"
          disabled={loading}
          onClick={() => {
            refreshRequested.current = true;
            setRevision((value) => value + 1);
          }}
        />
      </div>
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
      {failed > 0 && (
        <StatusMessage
          compact
          title="Часть данных недоступна"
          description="Показаны сохранённые данные и успешно загруженные разделы. Попробуйте обновить категорию позже."
        />
      )}
      {!loading && !filtered.length && (
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
      <div className="inventory-grid" aria-busy={loading}>
        {filtered.slice(0, limit).map((item) => (
          <ItemCard
            key={`${item.type}:${item.id}`}
            item={item}
            as="article"
            showAllStats
          >
            <CardDescription>
              {statuses[item.status]}
              {item.equipped ? " · Экипировано" : ""}
            </CardDescription>
          </ItemCard>
        ))}
      </div>
      {filtered.length > limit && (
        <Button onClick={() => setLimit((value) => value + PAGE_SIZE)}>
          Показать ещё ({filtered.length - limit})
        </Button>
      )}
    </section>
  );
}
