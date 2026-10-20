import { getSessionJson } from "../../../../shared/session-api.js";
import { useEffect, useRef, useState } from "react";
import {
  readSession,
  saveToken,
  clearToken,
  subscribeSession,
  formatExpiry,
} from "../../../../shared/auth-session.js";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { Modal } from "../../../components/ui/Modal/Modal.jsx";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
import "./LoginControl.css";
import { profileAvatarUrl } from "../profile.js";

export function LoginControl() {
  const [session, setSession] = useState(() => readSession());
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [profile, setProfile] = useState(null);
  const controlRef = useRef(null);
  const refreshProfileRef = useRef(() => {});
  const authenticated = session.status === "ready";
  useEffect(() => {
    if (!open || !authenticated) return;
    const outside = (event) => {
      if (!controlRef.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        controlRef.current?.querySelector("button")?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open, authenticated]);
  useEffect(() => {
    let controller;
    const load = async () => {
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      if (readSession().status !== "ready") {
        setProfile(null);
        return;
      }
      try {
        const data = await getSessionJson("/api/me", { signal });
        const text = (value) =>
          typeof value === "string" ? value.trim().slice(0, 80) : "";
        if (!signal.aborted)
          setProfile({
            name:
              text(data.nickname) ||
              text(data.firstName) ||
              text(data.username) ||
              "Игрок",
            username: text(data.username).replace(/^@/, ""),
            avatarUrl: profileAvatarUrl(data),
            stats: [
              [
                "Безумие",
                data.characterStats?.madness?.total,
                data.characterStats?.maxHealth,
                "HP",
              ],
              [
                "Агрессия",
                data.characterStats?.aggression?.total,
                data.characterStats?.baseDamage,
                "урон",
              ],
              [
                "Ярость",
                data.characterStats?.rage?.total,
                data.characterStats?.critChancePercent,
                "% шанс крита",
              ],
            ].filter(([, value]) => Number.isFinite(value)),
            wallet: [
              ["Монеты", data.wallet?.gold, "coin"],
              ["Пилюли", data.wallet?.pills, "pill"],
              ["Доллары", data.wallet?.dollar, "banknote"],
            ].filter(([, value]) => Number.isFinite(value)),
          });
      } catch {
        // A failed or cancelled profile request must not expose credentials.
      }
    };
    load();
    refreshProfileRef.current = load;
    const unsubscribe = subscribeSession(() => {
      setProfile(null);
      load();
    });
    return () => {
      controller?.abort();
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    let previousStatus = readSession().status;
    const update = () => {
      const next = readSession();
      if (previousStatus !== next.status) setOpen(false);
      previousStatus = next.status;
      setSession(next);
    };
    const unsubscribe = subscribeSession(update);
    const timer = setInterval(update, 1000);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, []);
  const close = () => {
    setOpen(false);
    setToken("");
    setError("");
  };
  const label = formatExpiry(session);
  const activeProfile = authenticated
    ? profile || { name: "Профиль", username: "" }
    : null;
  const logout = () => {
    try {
      clearToken();
      setSession(readSession());
      close();
    } catch (error) {
      setError(error.message);
    }
  };
  return (
    <>
      <div className="login-control" ref={controlRef}>
        <Button
          variant={activeProfile ? "secondary" : "primary"}
          className={activeProfile ? "profile-control" : undefined}
          aria-label={
            activeProfile ? `Профиль: ${activeProfile.name}` : undefined
          }
          aria-expanded={authenticated ? open : undefined}
          aria-controls={authenticated && open ? "profile-session" : undefined}
          onClick={() => {
            if (authenticated && !open) refreshProfileRef.current();
            setOpen((value) => !value);
          }}
        >
          {activeProfile ? (
            <>
              <span className="profile-avatar" aria-hidden="true">
                {activeProfile.avatarUrl ? (
                  <img
                    src={activeProfile.avatarUrl}
                    alt=""
                    referrerPolicy="no-referrer"
                    onError={() =>
                      setProfile((current) =>
                        current?.avatarUrl === activeProfile.avatarUrl
                          ? { ...current, avatarUrl: null }
                          : current,
                      )
                    }
                  />
                ) : (
                  activeProfile.name
                    .replace(/^\[[^\]]+\]\s*/, "")
                    .split(/\s+/)
                    .slice(0, 2)
                    .map((part) => Array.from(part)[0])
                    .join("")
                    .toUpperCase()
                )}
              </span>
              <span className="profile-copy">
                <span className="profile-name">{activeProfile.name}</span>
                <span className="profile-status">
                  {activeProfile.username
                    ? `@${activeProfile.username}`
                    : "Профиль игрока"}
                </span>
              </span>
              <span className="profile-chevron" aria-hidden="true">
                <Icon type="chevron" />
              </span>
            </>
          ) : (
            "Войти"
          )}
        </Button>
        {open && authenticated && (
          <BaseCard
            variant="popover"
            className="profile-session"
            id="profile-session"
            role="region"
            aria-label="Сеанс пользователя"
          >
            {profile && (
              <>
                <dl className="profile-attributes">
                  {(profile.stats || []).map(([name, value, derived, unit]) => (
                    <div key={name}>
                      <dt>{name}</dt>
                      <dd>
                        {value.toLocaleString("ru-RU")}
                        {Number.isFinite(derived) && (
                          <small>
                            {" "}
                            ({derived.toLocaleString("ru-RU")} {unit})
                          </small>
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
                <dl className="profile-stats">
                  {(profile.wallet || []).map(([name, value, icon]) => (
                    <div key={name}>
                      <dt>
                        <Icon type={icon} />
                        {name}
                      </dt>
                      <dd>{value.toLocaleString("ru-RU")}</dd>
                    </div>
                  ))}
                </dl>
              </>
            )}
            <p className="profile-session-expiry">
              {label.split(" · ").map((line) => (
                <span key={line}>{line}</span>
              ))}
            </p>
            {error && <p role="alert">{error}</p>}
            <Button variant="secondary" onClick={logout}>
              Выйти
            </Button>
          </BaseCard>
        )}
      </div>
      {open && !authenticated && (
        <Modal title="Вход" titleId="login-title" width={400} onClose={close}>
          <form
            className="login-form"
            onSubmit={(event) => {
              event.preventDefault();
              try {
                saveToken(token);
                setSession(readSession());
                close();
              } catch (error) {
                setError(error.message);
              }
            }}
          >
            {session.status !== "empty" && <p>{label}</p>}
            <input
              className="login-token-field"
              id="login-jwt"
              type="password"
              autoFocus
              value={token}
              onChange={(event) => {
                setToken(event.target.value);
                setError("");
              }}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              required
              placeholder="Вставьте JWT"
              aria-label="Токен для входа"
            />
            {error && <p role="alert">{error}</p>}
            <div className="login-actions">
              <Button variant="primary" type="submit">
                Войти
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
