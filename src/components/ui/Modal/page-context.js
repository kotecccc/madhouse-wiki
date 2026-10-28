import { createContext } from "react";

export const PageHostContext = createContext(null);

let pages = [];
const listeners = new Set();
const notify = () => listeners.forEach((listener) => listener());

export function subscribePages(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getPages() {
  return pages;
}

export async function refreshTopPage() {
  const page = pages.at(-1);
  if (!page?.canRefresh?.()) return false;
  await page.refresh();
  return true;
}

export function registerPage(id, close, options = {}) {
  pages = [
    ...pages.filter((page) => page.id !== id),
    { id, close, ...options },
  ];
  notify();
  return () => {
    pages = pages.filter((page) => page.id !== id);
    notify();
  };
}

export function closeAllPages() {
  for (const page of [...pages].reverse()) page.close();
}
