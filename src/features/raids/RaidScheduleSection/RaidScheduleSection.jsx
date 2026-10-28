import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { knowledgeBase } from "virtual:madhouse-catalogue";
import { ErrorToast } from "../../../components/ui/ErrorToast/ErrorToast.jsx";
import { Toast } from "../../../components/ui/Toast/Toast.jsx";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
import { Skeleton } from "../../../components/ui/Skeleton/Skeleton.jsx";
import { ContentSection } from "../../../components/ui/ContentSection/ContentSection.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { Pill } from "../../../components/ui/Pill/Pill.jsx";
import { formatBattleCountdown } from "../../bosses/BossBattle/boss-battle-presentation.js";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { Title } from "../../../components/ui/Title/Title.jsx";
import {
  getBossFloorCode,
  departmentById,
} from "../../../model/knowledge-base.js";
import { SegmentedControl } from "../../../components/ui/SegmentedControl/SegmentedControl.jsx";
import { RaidEventCard } from "../RaidEventCard/RaidEventCard.jsx";
import {
  bossInvitations,
  raidSubscriptions,
} from "../../bosses/BossBattle/boss-battle-session.js";
import { useBossCollection } from "../../bosses/collection/useBossCollection.js";
import { RaidPost } from "../RaidPost/RaidPost.jsx";
import { RaidArchive } from "../RaidArchive/RaidArchive.jsx";
import { defaultRaidSection } from "../raid-default-section.js";
import { combineRaids, raidFriendKey, raidFriendTarget } from "../raid-list.js";
import "./RaidScheduleSection.css";

const sections = [
  { value: "invitations", label: "Приглашения" },
  { value: "raids", label: "Рейды" },
  { value: "announcements", label: "Анонсы" },
];

function RaidSkeletons({ label }) {
  return (
    <div className="raid-post-list" role="status" aria-label={label}>
      {Array.from({ length: 6 }, (_, index) => (
        <Skeleton key={index} as="article" />
      ))}
    </div>
  );
}

function InvitationTimers({ items }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return items
    .filter(
      (item) =>
        item.available &&
        Number.isFinite(item.battleExpiresAt) &&
        item.battleExpiresAt > now,
    )
    .map((item) => (
      <Pill
        key={item.invitationId}
        variant="active"
        size="xs"
        title={`Бой: ${item.sender}`}
      >
        Идёт · {items.length > 1 ? `${item.sender} · ` : ""}
        {formatBattleCountdown(item.battleExpiresAt, now)}
      </Pill>
    ));
}

export function RaidScheduleSection({
  availability,
  state,
  onRetry,
  authenticated = false,
  active = false,
  queueFocus = null,
  onQueueFocusHandled,
}) {
  const [section, setSection] = useState(null);
  const manuallySelected = useRef(false);
  const previousAuthentication = useRef(authenticated);
  const [queueNotice, setQueueNotice] = useState(null);
  const subscriptionState = useSyncExternalStore(
    raidSubscriptions.subscribe,
    raidSubscriptions.getSnapshot,
    raidSubscriptions.getSnapshot,
  );
  const collection = useBossCollection(
    knowledgeBase.bosses,
    authenticated && active,
  );
  const invitations = useSyncExternalStore(
    bossInvitations.subscribe,
    bossInvitations.getSnapshot,
    bossInvitations.getSnapshot,
  );
  useEffect(() => {
    raidSubscriptions.watch(authenticated && active);
    if (authenticated && active) void bossInvitations.refresh();
    return () => raidSubscriptions.watch(false);
  }, [authenticated, active]);
  useEffect(() => {
    if (queueFocus) setSection("raids");
  }, [queueFocus]);
  const accept = async (id) => {
    if (await bossInvitations.accept(id))
      setQueueNotice("Приглашение добавлено в очередь.");
  };
  const groups = new Map();
  for (const item of invitations.items) {
    const group = groups.get(item.bossId) ?? [];
    group.push(item);
    groups.set(item.bossId, group);
  }
  const floorGroups = new Map();
  for (const [bossId, items] of groups) {
    const boss = knowledgeBase.bosses.find(
      (entry) => Number(entry.numericId ?? entry.apiId) === bossId,
    ) ?? {
      id: `invitation-${bossId}`,
      name: items[0].bossName,
      possibleDrops: [],
      dropItems: [],
    };
    const floor = getBossFloorCode(boss);
    const entries = floorGroups.get(floor) ?? [];
    entries.push({ bossId, boss, items });
    floorGroups.set(floor, entries);
  }
  const sortedFloors = [...floorGroups.entries()].sort(([a], [b]) =>
    a === "unknown"
      ? 1
      : b === "unknown"
        ? -1
        : b.localeCompare(a, "ru", { numeric: true }),
  );
  for (const [, entries] of sortedFloors)
    entries.sort(
      (a, b) =>
        String(departmentById[a.boss.departmentId]?.code ?? "").localeCompare(
          String(departmentById[b.boss.departmentId]?.code ?? ""),
          "ru",
          { numeric: true },
        ) || a.boss.name.localeCompare(b.boss.name, "ru"),
    );
  const latest = state.posts[0];
  const checkedTargets = useRef("");
  const targets = (latest?.raids ?? [])
    .map((raid) => raidFriendTarget(raid, null))
    .filter(Boolean);
  const targetsKey = JSON.stringify(
    [
      ...new Map(
        targets.map((target) => [raidFriendKey(target), target]),
      ).values(),
    ].slice(0, 100),
  );
  useEffect(() => {
    if (
      !authenticated ||
      !active ||
      section !== "announcements" ||
      !subscriptionState.loaded ||
      subscriptionState.pending ||
      targetsKey === "[]" ||
      checkedTargets.current === targetsKey
    )
      return;
    checkedTargets.current = targetsKey;
    void raidSubscriptions.checkFriends(JSON.parse(targetsKey));
  }, [
    authenticated,
    active,
    section,
    subscriptionState.loaded,
    subscriptionState.pending,
    targetsKey,
  ]);
  useEffect(() => {
    if (!authenticated || !active) checkedTargets.current = "";
  }, [authenticated, active]);
  const counts = {
    invitations:
      authenticated && invitations.loaded
        ? invitations.items.length
        : undefined,
    raids:
      authenticated && subscriptionState.loaded
        ? combineRaids(
            [],
            subscriptionState.detectedRaids,
            subscriptionState.subscription,
            knowledgeBase.bosses,
          ).length
        : undefined,
    announcements:
      state.status === "ready" ? (latest?.raids?.length ?? 0) : undefined,
  };
  const defaultSection = defaultRaidSection({
    authenticated,
    raidsLoaded: subscriptionState.loaded,
    invitationsLoaded: invitations.loaded,
    raidCount: counts.raids ?? 0,
    invitationCount: counts.invitations ?? 0,
  });
  useEffect(() => {
    if (previousAuthentication.current !== authenticated) {
      previousAuthentication.current = authenticated;
      if (!manuallySelected.current && !queueFocus) setSection(null);
    }
  }, [authenticated, queueFocus]);
  useEffect(() => {
    if (active && section === null && defaultSection && !queueFocus)
      setSection(defaultSection);
  }, [active, section, defaultSection, queueFocus]);
  const options = sections.map((item) => ({
    ...item,
    count: counts[item.value],
    ariaLabel:
      counts[item.value] == null
        ? item.label
        : `${item.label}: ${counts[item.value]}`,
  }));
  return (
    <ContentSection
      className="raid-schedule-section"
      id="raids"
      aria-labelledby="raids-title"
    >
      <h2 id="raids-title" className="sr-only">
        Рейды
      </h2>
      <SegmentedControl
        label="Раздел рейдов"
        size="sm"
        options={options}
        value={section ?? "raids"}
        onChange={(value) => {
          manuallySelected.current = true;
          setSection(value);
        }}
      />
      {queueNotice && (
        <Toast
          floating
          success
          title="В очереди"
          onDismiss={() => setQueueNotice(null)}
        >
          {queueNotice}
        </Toast>
      )}
      {section === null && (
        <RaidSkeletons label="Загрузка рейдов и приглашений" />
      )}
      {section === "invitations" && (
        <div className="raid-post-list">
          {!authenticated ? (
            <CardDescription>
              Войдите в аккаунт, чтобы увидеть приглашения.
            </CardDescription>
          ) : (
            <>
              <ErrorToast message={invitations.error} />
              {invitations.notice && (
                <CardDescription>{invitations.notice}</CardDescription>
              )}
              {invitations.unresolved && (
                <>
                  <ErrorToast message="Результат вступления пока не подтверждён." />
                  <Button
                    disabled={invitations.pending}
                    onClick={() => void bossInvitations.reconcile()}
                  >
                    Проверить вступление
                  </Button>
                </>
              )}
              {!invitations.loaded && (
                <RaidSkeletons label="Загрузка приглашений" />
              )}
              {invitations.loaded && groups.size === 0 && (
                <CardDescription>Входящих приглашений нет.</CardDescription>
              )}
              {sortedFloors.map(([floor, entries]) => (
                <section className="raid-invitation-floor" key={floor}>
                  <Title as="h3" level="h5">
                    {floor === "unknown" ? "Этаж не указан" : `Этаж ${floor}`}
                  </Title>
                  {entries.map(({ bossId, boss, items }) => (
                    <RaidEventCard
                      key={bossId}
                      bossOverride={boss}
                      floorAvailability={availability}
                      raid={{
                        boss: boss.name,
                        leader: items.map((item) => item.sender).join(", "),
                      }}
                      leaderLabel="Приглашают"
                      showStatus={false}
                      collectionIndicator={<InvitationTimers items={items} />}
                      goalAction={
                        <>
                          {items.map((item) => (
                            <Button
                              key={item.invitationId}
                              icon="combat"
                              disabled={
                                invitations.pending ||
                                invitations.queuedIds?.includes(
                                  item.invitationId,
                                ) ||
                                !item.available
                              }
                              onClick={() => void accept(item.invitationId)}
                            >
                              Напасть: {item.sender}
                              {!item.available ? " (недоступно)" : ""}
                            </Button>
                          ))}
                        </>
                      }
                    />
                  ))}
                </section>
              ))}
            </>
          )}
        </div>
      )}
      {section === "raids" && (
        <div className="raid-post-list">
          {!authenticated ? (
            <CardDescription>
              Войдите в аккаунт, чтобы увидеть обнаруженные рейды.
            </CardDescription>
          ) : (
            <>
              <ErrorToast message={subscriptionState.error} />
              {!subscriptionState.loaded && (
                <RaidSkeletons label="Загрузка рейдов" />
              )}
              {subscriptionState.loaded &&
                subscriptionState.detectedRaids.length === 0 &&
                !subscriptionState.subscription?.enabled &&
                !subscriptionState.subscription?.hasSuspendedGoal && (
                  <div className="raid-feed-state" role="status">
                    <Icon type="combat" size="hero" aria-hidden="true" />
                    <CardDescription>
                      Рейдов пока нет. Рейд появится здесь, когда ведущий
                      проведёт три боя с одним боссом за два часа и появится
                      активное приглашение.
                    </CardDescription>
                  </div>
                )}
              <RaidPost
                post={{ raids: [], raidDateLabel: "" }}
                groupByFloor
                floorAvailability={availability}
                authenticated
                active={active}
                focusTarget={queueFocus}
                onQueueFocusHandled={onQueueFocusHandled}
                detectedRaids={subscriptionState.detectedRaids}
                bossCollections={collection.bosses}
                invitations={invitations.items}
                subscriptionState={{
                  ...subscriptionState,
                  queuedInvitationIds: invitations.queuedIds,
                }}
                onAcceptInvitation={accept}
                onSubscribe={async (leader, boss, username, untilDrop) => {
                  if (
                    await raidSubscriptions.start(
                      leader,
                      boss,
                      username,
                      untilDrop,
                    )
                  )
                    setQueueNotice("Подписка добавлена в очередь.");
                }}
                onUnsubscribe={(id) => void raidSubscriptions.stop(id)}
              />
            </>
          )}
        </div>
      )}
      {section === "announcements" && (
        <div className="raid-post-list">
          {state.status === "error" && (
            <ErrorToast message="Расписание временно недоступно.">
              <Button variant="secondary" size="sm" onClick={onRetry}>
                Повторить
              </Button>
            </ErrorToast>
          )}
          {state.status === "ready" && !latest && (
            <CardDescription>
              Пока нет сохранённых анонсов. Новые рейды появятся после
              синхронизации канала.
            </CardDescription>
          )}
          {subscriptionState.friendError && authenticated && (
            <ErrorToast message={subscriptionState.friendError}>
              <Button
                size="sm"
                disabled={subscriptionState.pending}
                onClick={() =>
                  void raidSubscriptions.checkFriends(JSON.parse(targetsKey))
                }
              >
                Проверить друзей
              </Button>
            </ErrorToast>
          )}
          {latest && (
            <RaidPost
              post={latest}
              floorAvailability={availability}
              readOnly
              authenticated={authenticated}
              subscriptionState={subscriptionState}
              onRequestFriend={async (target) => {
                if (
                  await raidSubscriptions.requestFriend(
                    target.playerId ?? null,
                    target.username ?? "",
                  )
                )
                  setQueueNotice("Заявка добавлена в очередь.");
              }}
            />
          )}
          {state.nextCursor && (
            <RaidArchive
              key={state.nextCursor}
              cursor={state.nextCursor}
              floorAvailability={availability}
            />
          )}
        </div>
      )}
    </ContentSection>
  );
}
