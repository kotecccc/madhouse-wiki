import { renderDisplayFields } from "../../../components/ui/CardEditing/DisplayFields.jsx";
import {
  BossBattleButton,
  openBossBattle,
} from "../BossBattle/BossBattleDialog.jsx";
import {
  readSession,
  subscribeSession,
} from "../../../../shared/auth-session.js";
import { useMobileCardAction } from "../../../components/ui/BaseCard/useMobileCardAction.js";
import { BossStatus } from "./BossStatus.jsx";
import { BossBattleStatus } from "./BossBattleStatus.jsx";
import {
  activeBattleForBoss,
  bossHealthPercent,
} from "./boss-card-battle-status.js";
import {
  bossBattle,
  bossBattleAuto,
} from "../BossBattle/boss-battle-session.js";
import {
  bossTargetAction,
  battleCountLabel,
} from "../DepartmentBossCard/boss-target-action.js";
import { Toast } from "../../../components/ui/Toast/Toast.jsx";
import { departmentById } from "../../../model/knowledge-base.js";
import { bossDisplayFields } from "../../../lib/card-display-fields.js";
import { EditableLayout } from "../../../components/ui/CardEditing/EditableLayout.jsx";
import {
  Children,
  Fragment,
  isValidElement,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { CardEditingContext } from "../../../components/ui/CardEditing/CardEditing.jsx";
import { CardActionMenu } from "../../../components/ui/CardActionMenu/CardActionMenu.jsx";
import { MenuItem } from "../../../components/ui/MenuItem/MenuItem.jsx";
import { useBossRewardReference } from "../useBossRewardReference.js";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { ItemCard } from "../../items/ItemCard/ItemCard.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { Modal } from "../../../components/ui/Modal/Modal.jsx";
import { fmt } from "../../../lib/format.js";
import { sortBossDrops } from "../../../lib/boss-drop-order.js";
import { BossDropItems } from "../BossDropItems/BossDropItems.jsx";
import { BossPortrait } from "../BossPortrait/BossPortrait.jsx";
import { trackProductEvent } from "../../analytics/analytics-client.js";
import { editableTargetProps } from "../../../components/ui/EditableTarget/EditableTarget.js";
import "./BossCardView.css";

const spacingSizes = new Set([
  "4",
  "8",
  "12",
  "16",
  "24",
  "32",
  "40",
  "48",
  "64",
]);
const spacingValue = (size) =>
  spacingSizes.has(String(size)) ? `var(--space-${size})` : undefined;

export function bossMenuRows(nodes, closeMenu) {
  return Children.toArray(nodes).flatMap((child) => {
    if (!isValidElement(child)) return [];
    if (child.type === Fragment)
      return bossMenuRows(child.props.children, closeMenu);
    if (child.type !== Button) return [child];
    const {
      onClick,
      disabled,
      icon,
      title,
      children,
      "aria-label": ariaLabel,
    } = child.props;
    return [
      <MenuItem
        key={child.key}
        icon={icon}
        disabled={disabled}
        onClick={(event) => {
          closeMenu();
          onClick?.(event);
        }}
      >
        {ariaLabel || title || children}
      </MenuItem>,
    ];
  });
}

export function BossCardView({
  boss,
  as = "article",
  variant,
  cardState,
  motionBorder,
  motionColor,
  titleAs = "strong",
  title = boss.name,
  className = "",
  showInfo = true,
  showBattleAction = false,
  mobileBattleAction = false,
  primaryBattleAction = false,
  showStats = false,
  showDropList = true,
  action,
  actionText = "Весь дроп",
  actionSize,
  children,
  goalAction,
  openingRequirements,
  hasPortrait = true,
  imageLoading = "lazy",
  titleSize,
  infoSize,
  infoText,
  dropTextSize,
  dropItemSize,
  dropsCompact = false,
  dropItemOverrides = {},
  portraitProps = {},
  onSelectPart,
  cardPadding,
  contentGap,
  columnGap,
  displayFields,
  titleFields,
  descriptionFields,
  descriptionBreakBefore = [],
  titleDefaultFields = ["name"],
  statusSize = "sm",
  statusCompact = false,
  availabilitySize = "sm",
  showStatus = false,
  showAvailability = false,
  showBattleStatus = false,
  collectionIndicator,
  menuDropCount,
  currencyRewardUnavailable = false,
  status = "unknown",
  raid,
  disableMenu = false,
}) {
  const cardRef = useRef(null);
  const editing = useContext(CardEditingContext);
  const [menuAnchor, setMenuAnchor] = useState(null);
  const hold = useRef(null);
  const suppressClick = useRef(false);
  function cancelHold() {
    if (hold.current) clearTimeout(hold.current.timer);
    hold.current = null;
  }
  useEffect(() => () => cancelHold(), []);
  const [menuClosing, setMenuClosing] = useState(false);
  const [targetPending, setTargetPending] = useState(false);
  const [targetNotice, setTargetNotice] = useState(null);
  const customMenuAction = isValidElement(action) && action.type === Button;
  const menuEnabled =
    !disableMenu &&
    !onSelectPart &&
    !editing &&
    (!action || customMenuAction) &&
    (showBattleAction ||
      Boolean(raid) ||
      action === undefined ||
      customMenuAction);
  function finishMenu() {
    setMenuAnchor(null);
    setMenuClosing(false);
  }
  function closeMenu() {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
      finishMenu();
    else setMenuClosing(true);
  }
  const referenceBoss = useBossRewardReference(boss, cardRef);
  const targetAction = bossTargetAction(boss, openingRequirements);
  async function startTarget(mode) {
    if (!targetAction || targetPending) return;
    setTargetPending(true);
    const accepted = await (mode === "raid"
      ? bossBattleAuto.startRaid(targetAction.settings, {
          progressionTarget: true,
        })
      : bossBattleAuto.start(targetAction.settings, {
          progressionTarget: true,
        }));
    setTargetPending(false);
    closeMenu();
    setTargetNotice(
      accepted
        ? "Задача добавлена в очередь."
        : "Не удалось добавить задачу в очередь.",
    );
    setTargetNoticeSuccess(accepted);
  }
  const [targetNoticeSuccess, setTargetNoticeSuccess] = useState(false);
  const sessionReady = useSyncExternalStore(
    subscribeSession,
    () => readSession().status === "ready",
    () => false,
  );
  const directBattle = primaryBattleAction && showBattleAction && sessionReady;
  const activeBattle = useSyncExternalStore(
    bossBattle.subscribe,
    () =>
      activeBattleForBoss(
        bossBattle.getSnapshot(),
        Number(boss.numericId ?? boss.apiId),
      ),
    () => null,
  );
  const { mobile, cardProps: mobileActionProps } = useMobileCardAction({
    enabled:
      mobileBattleAction &&
      showBattleAction &&
      !onSelectPart &&
      sessionReady &&
      !menuEnabled,
    label: `Бой: ${boss.name}`,
    onActivate: () => {
      if (readSession().status === "ready")
        openBossBattle(referenceBoss, openingRequirements);
    },
  });
  const [showDrops, setShowDrops] = useState(false);
  const [portraitHeight, setPortraitHeight] = useState(92);
  const cardVariant = variant || "boss";
  const drops = sortBossDrops(boss.possibleDrops || []);
  const infoParts = [
    boss.requiredLevel != null && boss.rewardUntilLevel != null
      ? `Уровень ${fmt(boss.requiredLevel)}–${fmt(boss.rewardUntilLevel)}`
      : boss.requiredLevel != null
        ? `Уровень от ${fmt(boss.requiredLevel)}`
        : "Уровень не указан",
    showStats && boss.maxHp != null ? `HP ${fmt(boss.maxHp)}` : null,
    showStats && boss.damageMin != null && boss.damageMax != null
      ? `DMG ${fmt(boss.damageMin)}–${fmt(boss.damageMax)}`
      : null,
  ].filter(Boolean);
  const availableFields = (
    displayFields ||
    bossDisplayFields(referenceBoss, departmentById[boss.departmentId] || {})
  ).map((field) =>
    field.id === "drop" && currencyRewardUnavailable
      ? { ...field, unavailable: true }
      : field,
  );
  const renderedTitle = Array.isArray(titleFields)
    ? renderDisplayFields(availableFields, titleFields)
    : title;
  const renderedInfo = Array.isArray(descriptionFields)
    ? renderDisplayFields(
        availableFields,
        descriptionFields,
        descriptionBreakBefore,
      )
    : (infoText ?? infoParts.join(" • "));
  const partProps = (part) =>
    onSelectPart
      ? {
          ...editableTargetProps(true),
          role: "button",
          "aria-haspopup": "dialog",
          title: "Настроить элемент",
          tabIndex: 0,
          onClick: (event) => {
            event.stopPropagation();
            onSelectPart(part, event.currentTarget, event);
          },
          onFocus: (event) => event.stopPropagation(),
          onKeyDown: (event) => {
            if (["Enter", " "].includes(event.key)) {
              event.preventDefault();
              event.stopPropagation();
              onSelectPart(part, event.currentTarget, event);
            }
          },
        }
      : {};
  const cardClass = [
    "boss-card-view",
    `boss-card-view--${cardVariant}`,
    mobileBattleAction &&
      mobile &&
      !onSelectPart &&
      "boss-card-view--mobile-battle-action",
    !hasPortrait && "boss-card-view--no-portrait",
    (showStatus || showAvailability || showBattleStatus) &&
      "boss-card-view--indicators",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  const outerGap = spacingValue(columnGap);
  const mainGap = spacingValue(contentGap);
  const dropAction = action ?? (
    <Button
      editKey="action"
      variant="card-action"
      icon="loot"
      aria-label={`${actionText}: ${boss.name}`}
      title={actionText}
      {...editableTargetProps(Boolean(onSelectPart), "boss-all-drops-button")}
      size={actionSize}
      aria-haspopup="dialog"
      onFocus={onSelectPart ? (event) => event.stopPropagation() : undefined}
      onClick={(event) => {
        if (onSelectPart) {
          event.stopPropagation();
          onSelectPart("action", event.currentTarget, event);
          return;
        }
        trackProductEvent("boss_details_open", {
          section: "bosses",
          feature: "boss_drops",
          subject: boss.id,
        });
        setShowDrops(true);
      }}
    >
      {actionText}
    </Button>
  );
  return (
    <BaseCard
      ref={cardRef}
      editKey="card"
      as={as}
      variant={cardVariant}
      data-department-id={boss.departmentId}
      data-entity-id={boss.id}
      state={menuAnchor ? "menu-active" : cardState}
      motionBorder={motionBorder}
      motionColor={motionColor}
      padding={cardPadding}
      className={cardClass}
      tabIndex={onSelectPart ? 0 : undefined}
      aria-label={
        onSelectPart ? "Карточка босса: нажмите для настройки" : undefined
      }
      onClick={
        onSelectPart
          ? (event) => onSelectPart("card", event.currentTarget, event)
          : undefined
      }
      onKeyDown={
        onSelectPart
          ? (event) => {
              if (
                event.target === event.currentTarget &&
                ["Enter", " "].includes(event.key)
              ) {
                event.preventDefault();
                onSelectPart("card", event.currentTarget, event);
              }
            }
          : undefined
      }
      {...editableTargetProps(Boolean(onSelectPart), cardClass)}
      {...mobileActionProps}
      {...(menuEnabled
        ? {
            role: "button",
            tabIndex: 0,
            "aria-haspopup": "dialog",
            "aria-expanded": Boolean(menuAnchor),
            "aria-label": directBattle
              ? `Босс: ${boss.name}. Shift+F10 — действия`
              : `Действия: ${boss.name}`,
            "aria-keyshortcuts": directBattle ? "Shift+F10" : undefined,
            onPointerDown: (event) => {
              if (!directBattle || !event.isPrimary || event.button !== 0)
                return;
              const interactive = event.target.closest?.(
                "button, a, input, select, textarea, summary, dialog, [role=button], [role=dialog]",
              );
              if (interactive && interactive !== event.currentTarget) return;
              cancelHold();
              suppressClick.current = false;
              const anchor = event.currentTarget;
              const { clientX, clientY, pointerId } = event;
              const timer = setTimeout(() => {
                hold.current = null;
                suppressClick.current = true;
                setMenuClosing(false);
                setMenuAnchor(anchor);
              }, 600);
              hold.current = { timer, clientX, clientY, pointerId };
            },
            onPointerMove: (event) => {
              const start = hold.current;
              if (
                start &&
                start.pointerId === event.pointerId &&
                Math.hypot(
                  event.clientX - start.clientX,
                  event.clientY - start.clientY,
                ) > 10
              )
                cancelHold();
            },
            onPointerUp: cancelHold,
            onPointerCancel: () => {
              cancelHold();
              suppressClick.current = false;
            },
            onContextMenu: (event) => {
              if (!directBattle) return;
              event.preventDefault();
              cancelHold();
              setMenuClosing(false);
              setMenuAnchor(event.currentTarget);
            },
            onClick: (event) => {
              const interactive = event.target.closest?.(
                "button, a, input, select, textarea, summary, dialog, [role=button], [role=dialog]",
              );
              if (interactive && interactive !== event.currentTarget) return;
              if (suppressClick.current) {
                suppressClick.current = false;
                return;
              }
              if (directBattle && !menuAnchor) {
                openBossBattle(referenceBoss, openingRequirements);
                return;
              }
              if (menuAnchor) closeMenu();
              else setMenuAnchor(event.currentTarget);
            },
            onKeyDown: (event) => {
              if (
                directBattle &&
                event.target === event.currentTarget &&
                (event.key === "ContextMenu" ||
                  (event.key === "F10" && event.shiftKey))
              ) {
                event.preventDefault();
                setMenuClosing(false);
                setMenuAnchor(event.currentTarget);
                return;
              }
              if (
                event.target !== event.currentTarget ||
                !["Enter", " "].includes(event.key)
              )
                return;
              event.preventDefault();
              if (directBattle && !menuAnchor) {
                openBossBattle(referenceBoss, openingRequirements);
                return;
              }
              if (menuAnchor) closeMenu();
              else setMenuAnchor(event.currentTarget);
            },
          }
        : {})}
      style={{
        "--boss-portrait-height": `${portraitHeight}px`,
        ...(outerGap ? { gap: outerGap } : {}),
      }}
    >
      {hasPortrait && (
        <BossPortrait
          editKey="portrait"
          {...portraitProps}
          src={boss.image}
          alt={boss.name || ""}
          onHeight={setPortraitHeight}
          loading={imageLoading}
          {...partProps("portrait")}
        />
      )}
      <EditableLayout
        editKey="content-layout"
        className="boss-card-main"
        style={mainGap ? { gap: mainGap } : undefined}
      >
        <div className="boss-card-heading">
          <div className="boss-card-heading-title">
            <CardTitle
              editKey="title"
              composition={{
                fields: availableFields,
                defaultFields: titleDefaultFields,
              }}
              as={titleAs}
              size={titleSize}
              {...partProps("title")}
            >
              {renderedTitle || (onSelectPart ? "\u00a0" : "")}
            </CardTitle>
          </div>
          {(showStatus || showAvailability) && (
            <div className="boss-card-indicators">
              {showAvailability && (
                <BossStatus
                  availability="locked"
                  size={availabilitySize}
                  onSelect={
                    onSelectPart
                      ? (event) =>
                          onSelectPart(
                            "availability",
                            event.currentTarget,
                            event,
                          )
                      : undefined
                  }
                />
              )}
              {showStatus && (
                <BossStatus
                  size={statusSize}
                  compact={statusCompact}
                  raid={raid}
                  status={
                    ["scheduled", "active", "completed"].includes(status)
                      ? status
                      : "scheduled"
                  }
                  onSelect={
                    onSelectPart
                      ? (event) =>
                          onSelectPart("status", event.currentTarget, event)
                      : undefined
                  }
                />
              )}
            </div>
          )}
          {(showBattleStatus || collectionIndicator) && (
            <div className="boss-card-indicator-group">
              {showBattleStatus && (
                <BossBattleStatus
                  bossId={Number(boss.numericId ?? boss.apiId)}
                />
              )}
              {collectionIndicator}
            </div>
          )}
        </div>
        {showInfo && (
          <CardDescription
            editKey="info"
            composition={{
              fields: availableFields,
              defaultFields: [
                "accessLevel",
                ...(showStats ? ["hp", "damage"] : []),
              ],
            }}
            size={infoSize}
            {...partProps("info")}
          >
            {renderedInfo || (onSelectPart ? "\u00a0" : "")}
          </CardDescription>
        )}
        {children}
        {showDropList &&
          (boss.dropItems?.length ? (
            <BossDropItems
              items={boss.dropItems}
              loading={imageLoading}
              textSize={dropTextSize}
              itemSize={dropItemSize}
              compact={dropsCompact}
              itemOverrides={dropItemOverrides}
              onSelectItem={
                onSelectPart
                  ? (index, anchor, event) =>
                      onSelectPart(`drop:${index}`, anchor, event)
                  : undefined
              }
            />
          ) : (
            <CardDescription editKey="drops-empty" {...partProps("drops")}>
              Добыча не указана
            </CardDescription>
          ))}
      </EditableLayout>
      {menuEnabled && menuAnchor && (
        <CardActionMenu
          anchor={menuAnchor}
          label={`Действия: ${boss.name}`}
          onClose={closeMenu}
          closing={menuClosing}
          onClosed={finishMenu}
        >
          {showBattleAction && sessionReady && (
            <MenuItem
              icon={activeBattle ? "eye" : "combat"}
              value={
                bossHealthPercent(activeBattle) == null
                  ? undefined
                  : `HP ${bossHealthPercent(activeBattle)}%`
              }
              onClick={() => {
                closeMenu();
                openBossBattle(referenceBoss, openingRequirements);
              }}
            >
              {activeBattle ? "Смотреть бой" : "Бой"}
            </MenuItem>
          )}
          {showBattleAction && sessionReady && targetAction && (
            <>
              <MenuItem informational icon="target">
                Задача
              </MenuItem>
              <MenuItem
                icon="combat"
                disabled={targetPending}
                onClick={() => void startTarget("auto")}
              >
                Автобой {battleCountLabel(targetAction.remaining)}
              </MenuItem>
              <MenuItem
                icon="play"
                disabled={targetPending}
                onClick={() => void startTarget("raid")}
              >
                Рейд {battleCountLabel(targetAction.remaining)}
              </MenuItem>
            </>
          )}
          {!customMenuAction && (action !== false || raid) && (
            <MenuItem
              icon="loot"
              value={menuDropCount}
              onClick={() => {
                closeMenu();
                trackProductEvent("boss_details_open", {
                  section: raid ? "raids" : "bosses",
                  feature: "boss_drops",
                  subject: boss.id,
                });
                setShowDrops(true);
              }}
            >
              {actionText}
            </MenuItem>
          )}
          {customMenuAction && bossMenuRows(action, closeMenu)}
          {bossMenuRows(goalAction, closeMenu)}
        </CardActionMenu>
      )}
      {!menuEnabled &&
        (mobileBattleAction &&
        mobile &&
        !onSelectPart ? null : (showBattleAction || goalAction) &&
          !onSelectPart ? (
          <div className="boss-card-actions">
            {showBattleAction && (
              <BossBattleButton
                boss={referenceBoss}
                size={actionSize}
                openingRequirements={openingRequirements}
              />
            )}
            {dropAction}
            {goalAction}
          </div>
        ) : (
          dropAction
        ))}
      {targetNotice && (
        <Toast
          floating
          success={targetNoticeSuccess}
          urgent={!targetNoticeSuccess}
          title={targetNoticeSuccess ? "В очереди" : "Ошибка"}
          onDismiss={() => setTargetNotice(null)}
        >
          {targetNotice}
        </Toast>
      )}
      {showDrops && (
        <Modal
          title={`Дроп: ${boss.name}`}
          titleId={`boss-drops-title-${boss.id}`}
          width="560px"
          className="boss-drops-dialog"
          contentVariant="inset"
          onClose={() => setShowDrops(false)}
        >
          <>
            {drops.length ? (
              <ul className="boss-drops-list">
                {drops.map((drop, index) => (
                  <ItemCard
                    key={`${drop.type}-${drop.entityId ?? index}`}
                    item={drop}
                  />
                ))}
              </ul>
            ) : (
              <CardDescription>Сведения о дропе не указаны.</CardDescription>
            )}
          </>
        </Modal>
      )}
    </BaseCard>
  );
}
