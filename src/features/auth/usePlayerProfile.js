import { useEffect, useState } from "react";
import { getSessionJson } from "../../../shared/session-api.js";
import { readSession, subscribeSession } from "../../../shared/auth-session.js";
import { normalizePlayerProfile } from "./profile.js";

export function usePlayerProfile() {
  const [state, setState] = useState({ status: "idle", profile: null });

  useEffect(() => {
    let controller;
    const load = () => {
      controller?.abort();
      controller = new AbortController();
      const { signal } = controller;
      if (readSession().status !== "ready") {
        setState({ status: "idle", profile: null });
        return;
      }
      // Never keep a previous account's profile visible while a new session loads.
      setState({ status: "loading", profile: null });
      getSessionJson("/api/me", { signal })
        .then((data) => {
          if (!signal.aborted)
            setState({
              status: "ready",
              profile: normalizePlayerProfile(data),
            });
        })
        .catch((error) => {
          if (!signal.aborted)
            setState({
              status: "error",
              profile: null,
              message:
                error?.message === "Требуется вход"
                  ? "Войдите в игровой аккаунт, чтобы загрузить профиль."
                  : "Не удалось загрузить профиль игрока.",
            });
        });
    };
    load();
    const unsubscribe = subscribeSession(load);
    return () => {
      controller?.abort();
      unsubscribe();
    };
  }, []);

  return state;
}
