import { useMobileCardAction } from "../../../components/ui/BaseCard/useMobileCardAction.js";
import { LockIndicator } from "../../floors/LockIndicator/LockIndicator.jsx";
import { useContext, useEffect, useState, useSyncExternalStore } from "react";
import {
  getSessionJson,
  readStoredSessionJson,
  postSessionJson,
  peekSessionJson,
  subscribeSessionData,
} from "../../../../shared/session-api.js";
import {
  readSession,
  subscribeSession,
} from "../../../../shared/auth-session.js";
import {
  normalizeWorkStash,
  workStashFirstCollection,
  workStashPartsProgress,
} from "../../../../shared/work-stash.js";
import { Modal } from "../../../components/ui/Modal/Modal.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { ApprovableButton } from "../../../components/ui/ConfirmButton/ConfirmButton.jsx";
import { Pill } from "../../../components/ui/Pill/Pill.jsx";
import { workFarm } from "../../bosses/BossBattle/boss-battle-session.js";
import { WorkStashCard } from "./WorkStashCard.jsx";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import {
  CardEditScope,
  CardEditingContext,
} from "../../../components/ui/CardEditing/CardEditing.jsx";
import { CardActionMenu } from "../../../components/ui/CardActionMenu/CardActionMenu.jsx";
import { MenuItem } from "../../../components/ui/MenuItem/MenuItem.jsx";
import { Divider } from "../../../components/ui/Divider/Divider.jsx";
import { EditableValue } from "../../../components/ui/CardEditing/EditableValue.jsx";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
import { ImageCard } from "../../../components/ui/ImageCard/ImageCard.jsx";
import { fmt } from "../../../lib/format.js";
import { composeDisplayFields } from "../../../lib/card-display-fields.js";
import { getWorkCardVariantProps } from "./work-card-variants.js";
import { WorkCalculatorDialog } from "./WorkCalculatorDialog.jsx";
import { normalizeActiveStashBuffs } from "../../auth/profile.js";
import { effectTimeLeft } from "../../../lib/stash-buff-time.js";
import { workFarmCardState } from "./work-farm-card-state.js";
import { workMaxStartArgs } from "./work-max-start.js";
import { previewWorkTasks } from "../WorkFarm/work-farm-presentation.js";
import "./WorkCard.css";

export function WorkCard({
  work,
  department,
  preset,
  children,
  targeted = false,
  goalTargets = [],
  as = "div",
  locked = false,
  placeholder = false,
}) {
  const [open, setOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [menuError, setMenuError] = useState(null);
  const [menuPending, setMenuPending] = useState(false);
  const [stashData, setStashData] = useState(null);
  const sessionStatus = useSyncExternalStore(
    subscribeSession,
    () => readSession().status,
    () => "empty",
  );
  const farmState = useSyncExternalStore(
    workFarm.subscribe,
    workFarm.getSnapshot,
    workFarm.getSnapshot,
  );
  const farmCard = workFarmCardState({
    run: farmState.run,
    workId: Number(work?.workId ?? work?.numericId ?? work?.apiId),
    departmentCode: department?.code,
    preview:
      import.meta.env.DEV && typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("testWorkFarm")
        : null,
    dev: import.meta.env.DEV,
  });
  const [bagData, setBagData] = useState(() =>
    peekSessionJson("/api/me/bag", { allowStale: true }),
  );
  const [effectNow, setEffectNow] = useState(() => Date.now());
  useEffect(() => {
    let active = true;
    let generation = 0;
    const load = () => {
      const current = ++generation;
      setStashData(null);
      setBagData(peekSessionJson("/api/me/bag", { allowStale: true }));
      if (
        !work?.stashSet?.ingredients?.length ||
        (readSession().status !== "ready" && !readSession().wikiSessionReady)
      )
        return;
      const cached = peekSessionJson("/api/stash/sets", { allowStale: true });
      if (cached) setStashData(cached);
      void readStoredSessionJson("/api/stash/sets")
        .then((result) => {
          if (active && current === generation && result.presence === "present")
            setStashData(result.data);
        })
        .catch(() => {});
    };
    const unsubscribe = subscribeSession(load);
    const unsubscribeData = subscribeSessionData((event) => {
      if (event.cleared) {
        setStashData(null);
        setBagData(null);
      } else if (event.path === "/api/stash/sets") setStashData(event.data);
      else if (event.path === "/api/me/bag") setBagData(event.data);
    });
    load();
    return () => {
      active = false;
      unsubscribe();
      unsubscribeData();
    };
  }, [work?.stashSet]);
  const editing = useContext(CardEditingContext);
  const [menuAnchor, setMenuAnchor] = useState(null);
  const [menuClosing, setMenuClosing] = useState(false);
  const [menuEnergy, setMenuEnergy] = useState(null);
  const menuWorkId = Number(work?.workId ?? work?.numericId ?? work?.apiId);
  useEffect(() => {
    if (
      !menuAnchor ||
      !Number.isSafeInteger(menuWorkId) ||
      menuWorkId <= 0 ||
      sessionStatus !== "ready" ||
      locked
    )
      return undefined;
    let alive = true;
    setMenuEnergy(null);
    const update = async () => {
      const current = workFarm.getSnapshot();
      if (
        !current.loaded ||
        current.pending ||
        ["running", "paused"].includes(current.run?.status)
      )
        return;
      if (!(await workFarm.refresh(menuWorkId)) || !alive) return;
      const view = workFarm.getSnapshot().view;
      if (
        view?.workId !== menuWorkId ||
        !Number.isSafeInteger(view.energy?.current)
      )
        return;
      const preview = previewWorkTasks(view, {
        mode: "energy",
        energyBudget: view.energy.current,
      });
      if (alive) setMenuEnergy(preview?.energy ?? null);
    };
    void update();
    return () => {
      alive = false;
    };
  }, [menuAnchor, menuWorkId, sessionStatus, locked, farmState.loaded]);
  useEffect(() => {
    if (!menuAnchor) return undefined;
    setEffectNow(Date.now());
    const timer = setInterval(() => setEffectNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [menuAnchor]);
  const { mobile } = useMobileCardAction({ enabled: false });
  const finishMenu = () => {
    setMenuAnchor(null);
    setMenuClosing(false);
  };
  const closeMenu = () => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
      finishMenu();
    else setMenuClosing(true);
  };
  const variant = getWorkCardVariantProps(preset, mobile);
  if (!work && !placeholder) return null;
  const energy = placeholder ? null : department?.energyCycle?.full;
  const departmentWork = department?.work;
  const stash = departmentWork?.stash || department?.stashPreview?.title || "";
  const image = departmentWork?.image || department?.stashPreview?.image;
  const parts = work?.stashSet?.ingredients ?? [];
  const activeEffects = normalizeActiveStashBuffs(bagData).filter(
    (buff) => buff.expiresAtMs > effectNow,
  );
  const activeSet = activeEffects.find(
    (buff) => String(buff.setId) === String(work?.stashSet?.setId),
  );
  const confirmationKey = JSON.stringify(
    activeEffects.map((buff) => [buff.setId, buff.expiresAtUtc]).sort(),
  );
  const personalStash =
    stashData && work?.stashSet
      ? normalizeWorkStash(stashData, work.stashSet.setId)
      : null;
  const collection = workStashFirstCollection(personalStash, parts);
  const progress = workStashPartsProgress(personalStash, parts);
  const partsReady = progress && progress.owned === progress.total;
  const setTitle =
    (work?.stashSet?.title || work?.stashSet?.name || "Набор")
      .replace(/^Набор\s*[«"“]?/i, "")
      .replace(/[»"”]$/, "") || "Набор";
  const fields = [
    {
      id: "name",
      label: "Работёнка",
      value: work?.title || (placeholder ? "Работёнка" : ""),
    },
    { id: "block", label: "Блок", value: department?.code || "" },
    { id: "department", label: "Отделение", value: department?.name || "" },
    { id: "stash", label: "Тайник", value: stash },
    {
      id: "energy",
      label: "Энергия",
      value: energy == null ? "" : `Энергия ${fmt(energy)}`,
    },
  ];
  const showFarm = () => {
    if (!work || farmCard.test) return;
    setOpen(true);
  };
  const craftSet = async () => {
    if (menuPending || farmCard.test || activeSet) return;
    setMenuPending(true);
    setMenuError(null);
    try {
      const state = await getSessionJson("/api/automation/state", {
        fresh: true,
        revalidate: false,
      });
      await postSessionJson("/api/automation/commands", {
        id: crypto.randomUUID(),
        expectedVersion: state.version,
        command: "queue.enqueue",
        args: {
          type: "stash.craft",
          action: { setId: Number(work.stashSet.setId) },
        },
      });
      closeMenu();
    } catch {
      setMenuError("Не удалось добавить сборку. Проверьте очередь.");
    } finally {
      setMenuPending(false);
    }
  };
  const spendEnergy = async () => {
    if (menuPending || farmCard.test || locked || menuEnergy === 0) return;
    const args = workMaxStartArgs(
      Number(work.workId ?? work.numericId ?? work.apiId),
      workFarm.getSnapshot().view,
    );
    if (!args) {
      setMenuError("Не удалось определить работёнку.");
      return;
    }
    setMenuPending(true);
    setMenuError(null);
    try {
      if (!(await workFarm.start(args))) throw new Error("work_start_failed");
      closeMenu();
    } catch {
      setMenuError("Не удалось запустить работу. Проверьте очередь.");
    } finally {
      setMenuPending(false);
    }
  };
  const farmSet = async () => {
    if (menuPending || farmCard.test) return;
    setMenuPending(true);
    setMenuError(null);
    try {
      const workId = Number(work.workId ?? work.numericId ?? work.apiId);
      const view = workFarm.getSnapshot().view;
      if (!Number.isSafeInteger(workId) || workId <= 0)
        throw new Error("work_unavailable");
      const completed =
        view?.workId === workId && Number.isSafeInteger(view.completedCycles)
          ? view.completedCycles
          : 0;
      const started = await workFarm.start({
        workId,
        expectedCompletedCycles: completed,
        targetCycles: completed + 1,
        collectStash: true,
        mode: "energy",
        maxActions: 30000,
        durationHours: null,
        maxBoosters: 0,
        maxDollar: 0,
        allowPurchase: false,
      });
      if (!started) throw new Error("work_start_failed");
      closeMenu();
    } catch {
      setMenuError("Не удалось запустить фарм. Проверьте состояние работы.");
    } finally {
      setMenuPending(false);
    }
  };
  return (
    <CardEditScope
      scope={
        work
          ? `work:${work.id}`
          : `department:${department?.id}:work-placeholder`
      }
    >
      <BaseCard
        as={as}
        data-department-id={department?.id}
        data-entity-id={work?.id}
        motionBorder={farmCard.active ? 3 : undefined}
        motionColor={farmCard.active ? "gold" : undefined}
        state={
          menuAnchor
            ? "menu-active"
            : locked
              ? "locked"
              : targeted
                ? "target"
                : undefined
        }
        editKey="card"
        className="work-card"
        variant="floor-data"
        {...(work && !placeholder && !editing
          ? {
              role: "button",
              tabIndex: 0,
              "aria-haspopup": "dialog",
              "aria-expanded": Boolean(menuAnchor),
              "aria-label": `Действия: ${work.title || "Работёнка"}`,
              onClick: (event) => {
                const interactive = event.target.closest?.(
                  "button, a, input, select, textarea, summary, dialog, [role=button], [role=dialog]",
                );
                if (interactive && interactive !== event.currentTarget) return;
                if (menuAnchor) closeMenu();
                else {
                  setMenuAnchor(event.currentTarget);
                }
              },
              onKeyDown: (event) => {
                if (
                  event.target !== event.currentTarget ||
                  !["Enter", " "].includes(event.key)
                )
                  return;
                event.preventDefault();
                if (menuAnchor) closeMenu();
                else {
                  setMenuAnchor(event.currentTarget);
                }
              },
            }
          : {})}
      >
        <div className="work-card-heading">
          <ImageCard
            editKey="image"
            className="image-card--work"
            size="var(--work-image-card-size)"
            imageSize="var(--work-image-size)"
            src={image}
            label={stash || "Отделение"}
            title={stash || "Отделение"}
          >
            <Icon type="department" />
          </ImageCard>
          <div className="work-card-copy">
            <CardTitle
              as="h3"
              editKey="title"
              size={variant?.titleSize}
              composition={{ fields, defaultFields: ["block", "name"] }}
            >
              {[
                department?.code,
                work?.title || (placeholder ? "Работёнка" : ""),
              ]
                .filter(Boolean)
                .join(" • ")}
            </CardTitle>
            <CardDescription
              editKey="description"
              size={variant?.descriptionSize}
              composition={{
                fields,
                defaultFields: variant?.descriptionFields || [
                  "department",
                  "stash",
                ],
              }}
            >
              {composeDisplayFields(
                fields,
                variant?.descriptionFields || ["department", "stash"],
              ) || (placeholder ? "Данные работёнки пока недоступны" : "")}
            </CardDescription>
            {children}
          </div>
        </div>
        <div className="work-card-footer">
          {farmCard.test && (
            <Pill variant="warning" size="xs" dot={false}>
              Тест
            </Pill>
          )}
          <span className="work-card-energy">
            {locked ? (
              <LockIndicator variant="locked" size="small" />
            ) : (
              <>
                <EditableValue editKey="energy">
                  {energy == null ? "—" : fmt(energy)}
                </EditableValue>{" "}
                <Icon type="energy" size="small" />
              </>
            )}
          </span>
        </div>
        {menuAnchor && (
          <CardActionMenu
            anchor={menuAnchor}
            preferFit
            label={`Действия: ${work.title}`}
            onClose={closeMenu}
            closing={menuClosing}
            onClosed={finishMenu}
          >
            {parts.length > 0 && (
              <>
                <MenuItem
                  informational
                  interactive
                  onClick={() => {
                    closeMenu();
                    setDetailsOpen(true);
                  }}
                  image={
                    work.stashSet.previewImageUrl ||
                    work.stashSet.imageUrl ||
                    image
                  }
                  value={
                    activeSet ? (
                      <Pill
                        variant="completed"
                        size="xs"
                        dot={false}
                        title={`${activeSet.name}: ${effectTimeLeft(activeSet.expiresAtMs, effectNow)}`}
                      >
                        <Icon type="stash" size="small" />
                        {effectTimeLeft(
                          activeSet.expiresAtMs,
                          effectNow,
                        ).replace("Осталось ", "")}
                      </Pill>
                    ) : collection.status === "collected" ? (
                      <Pill variant="completed" size="xs" dot={false}>
                        Собран
                      </Pill>
                    ) : collection.status === "not_collected" ? (
                      <Pill variant="unknown" size="xs" dot={false}>
                        Не собран
                      </Pill>
                    ) : (
                      "—"
                    )
                  }
                >
                  {setTitle}
                </MenuItem>
                <Divider menu />
              </>
            )}
            {menuError && <MenuItem informational>{menuError}</MenuItem>}
            <MenuItem
              icon="energy"
              value={menuEnergy == null ? "—" : `≈ ${fmt(menuEnergy)}`}
              disabled={
                locked ||
                farmCard.test ||
                menuPending ||
                menuEnergy === 0 ||
                sessionStatus !== "ready" ||
                ["running", "paused"].includes(farmState.run?.status)
              }
              onClick={() => void spendEnergy()}
            >
              Потратить энергию
            </MenuItem>
            {parts.length > 0 && partsReady && activeEffects.length > 0 ? (
              <ApprovableButton
                variant="menu-item"
                icon="stash"
                menuValue={`${progress.owned}/${progress.total}`}
                liftOnHover={false}
                confirmationKey={confirmationKey}
                confirmationLabel="Уже есть эффект, точно?"
                disabled={
                  farmCard.test ||
                  menuPending ||
                  Boolean(activeSet) ||
                  personalStash?.canCraft !== true
                }
                onClick={() => void craftSet()}
              >
                Собрать набор
              </ApprovableButton>
            ) : (
              parts.length > 0 && (
                <MenuItem
                  icon={partsReady ? "stash" : "brain"}
                  value={progress ? `${progress.owned}/${progress.total}` : "—"}
                  disabled={
                    farmCard.test ||
                    menuPending ||
                    !progress ||
                    (partsReady &&
                      (Boolean(activeSet) || personalStash?.canCraft !== true))
                  }
                  onClick={() => void (partsReady ? craftSet() : farmSet())}
                >
                  {partsReady ? "Собрать набор" : "Фармить набор"}
                </MenuItem>
              )
            )}
            {parts.length === 0 && (
              <MenuItem
                icon="brain"
                disabled={farmCard.test}
                onClick={() => {
                  closeMenu();
                  showFarm();
                }}
              >
                Фарм
              </MenuItem>
            )}
          </CardActionMenu>
        )}
      </BaseCard>
      <WorkCalculatorDialog
        work={work}
        energy={energy}
        goalTargets={goalTargets}
        visible={open}
        onClose={() => setOpen(false)}
      />
      {detailsOpen && (
        <Modal
          title={work.title || "Работа"}
          onClose={() => setDetailsOpen(false)}
          footer={
            <Button onClick={() => setDetailsOpen(false)}>Закрыть</Button>
          }
        >
          <WorkStashCard work={work} stash={personalStash} />
        </Modal>
      )}
    </CardEditScope>
  );
}
