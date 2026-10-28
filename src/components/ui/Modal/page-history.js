const key = "madhousePageStack";
let nextId = 0;

export function pushPage(history, path, location) {
  if (path && location?.pathname === path) {
    const stack = history.state?.[key];
    if (Array.isArray(stack) && stack.length) {
      const existingId = stack.at(-1);
      nextId = Math.max(nextId, existingId);
      return existingId;
    }
    history.replaceState(history.state, "", `/${location.search}`);
  }
  const id = ++nextId;
  const state =
    history.state && typeof history.state === "object" ? history.state : {};
  const stack = Array.isArray(state[key]) ? state[key] : [];
  history.pushState(
    { ...state, [key]: [...stack, id] },
    "",
    path ? `${path}${location?.search ?? ""}` : undefined,
  );
  return id;
}

export function hasPage(state, id) {
  return Array.isArray(state?.[key]) && state[key].includes(id);
}

export function removePage(history, id) {
  if (!hasPage(history.state, id)) return;
  history.replaceState(
    {
      ...history.state,
      [key]: history.state[key].filter((item) => item !== id),
    },
    "",
  );
}
