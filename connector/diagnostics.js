const stages = new Set(["BOOT", "CLIENT", "RESTORE"]);
const categories = new Map([
  ["SecurityError", "SECURITY"],
  ["QuotaExceededError", "QUOTA"],
  ["InvalidStateError", "INVALID_STATE"],
  ["NotSupportedError", "NOT_SUPPORTED"],
  ["CompileError", "WASM_COMPILE"],
  ["LinkError", "WASM_LINK"],
  ["RuntimeError", "WASM_RUNTIME"],
  ["TypeError", "TYPE"],
  ["NetworkError", "NETWORK"],
  ["TimeoutError", "TIMEOUT"],
  ["MtTimeoutError", "MT_TIMEOUT"],
  ["MtSecurityError", "MT_SECURITY"],
  ["MtUnsupportedError", "MT_UNSUPPORTED"],
]);
const rpcCategories = new Set([
  "API_ID_INVALID",
  "API_ID_PUBLISHED_FLOOD",
  "AUTH_KEY_DUPLICATED",
  "CONNECTION_NOT_INITED",
  "SESSION_PASSWORD_NEEDED",
]);
const codes = new Set(
  [...stages].flatMap((stage) =>
    [...categories.values(), ...rpcCategories, "FLOOD_WAIT", "UNKNOWN"].map(
      (category) => `TG_${stage}_${category}`,
    ),
  ),
);

export function connectionFailure(error, stage, errorTypes = {}) {
  const typedName = [
    "MtTimeoutError",
    "MtSecurityError",
    "MtUnsupportedError",
  ].find(
    (name) =>
      typeof errorTypes[name] === "function" &&
      error instanceof errorTypes[name],
  );
  const category = rpcCategories.has(error?.text)
    ? error.text
    : typeof error?.text === "string" && /^FLOOD_WAIT_\d+$/.test(error.text)
      ? "FLOOD_WAIT"
      : categories.get(typedName || error?.name) || "UNKNOWN";
  const failure = new Error("telegram_unavailable");
  // Never retain cause, message, request, payload or arbitrary RPC text.
  failure.diagnosticCode = `TG_${stages.has(stage) ? stage : "BOOT"}_${category}`;
  return failure;
}

export function diagnosticSuffix(error) {
  return codes.has(error?.diagnosticCode) ? ` (${error.diagnosticCode})` : "";
}
