// A disconnected observer can already have a callback queued; ignore it.
export function observeVisibility(
  element,
  onChange,
  options,
  Observer = globalThis.IntersectionObserver,
) {
  if (!element || typeof Observer !== "function") return () => {};
  let active = true;
  const observer = new Observer(([entry]) => {
    if (active && entry) onChange(entry.isIntersecting);
  }, options);
  observer.observe(element);
  return () => {
    active = false;
    observer.disconnect();
  };
}
