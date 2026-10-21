// Capture launch credentials before Wiki anchor navigation replaces the hash.
// This is a routing hint only; the server verifies the complete signed initData.
const contexts = new WeakMap();
export function telegramContext(
  browser = typeof window === "undefined" ? undefined : window,
) {
  if (!browser) return { userId: undefined, initData: "", isTelegram: false };
  let previous = contexts.get(browser) || {
    userId: undefined,
    initData: "",
    isTelegram: false,
  };
  try {
    const sdk = browser.Telegram?.WebApp;
    const hash = new URLSearchParams(browser.location?.hash?.slice(1));
    const raw = hash.get("tgWebAppData") || sdk?.initData;
    if (raw) {
      const user = JSON.parse(new URLSearchParams(raw).get("user"));
      previous = {
        initData: raw,
        isTelegram: true,
        userId:
          Number.isSafeInteger(user?.id) && user.id > 0
            ? String(user.id)
            : undefined,
      };
      contexts.set(browser, previous);
    }
    const sdkId = sdk?.initDataUnsafe?.user?.id;
    if (
      Number.isSafeInteger(sdkId) &&
      sdkId > 0 &&
      String(sdkId) !== previous.userId
    ) {
      previous = {
        userId: raw ? undefined : String(sdkId),
        initData: "",
        isTelegram: true,
      };
      contexts.set(browser, previous);
    }
  } catch {
    previous = { userId: undefined, initData: "", isTelegram: true };
    contexts.set(browser, previous);
  }
  return previous;
}
telegramContext();

export function accountStorageKey(key) {
  const id = telegramContext().userId;
  return id ? key + ":" + id : key;
}
