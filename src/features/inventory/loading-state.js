export function inventoryLoading(paths, requestState) {
  return paths.some(
    (path) =>
      !requestState[path] ||
      ["pending", "loading"].includes(requestState[path]),
  );
}

export function inventoryHeaderLoading(active, loading) {
  return active && loading;
}
