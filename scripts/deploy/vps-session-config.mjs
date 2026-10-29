// Both roles need the same two independent keys and private storage service.
export function validateVpsSessionConfig(env) {
  for (const name of ["ACCOUNT_SESSION_KEY", "WIKI_SESSION_KEY"]) {
    if (!/^[a-f0-9]{64}$/i.test(env[name] || ""))
      throw new Error(`${name} must be a 32-byte hex secret`);
  }
  if (
    env.ACCOUNT_SESSION_KEY.toLowerCase() === env.WIKI_SESSION_KEY.toLowerCase()
  )
    throw new Error(
      "ACCOUNT_SESSION_KEY and WIKI_SESSION_KEY must be distinct",
    );
  if (!/^[a-f0-9]{64}$/i.test(env.MADHOUSE_GAME_EXECUTOR_KEY || ""))
    throw new Error("MADHOUSE_GAME_EXECUTOR_KEY must be a 32-byte hex secret");
  for (const name of [
    "ACCOUNT_SESSION_KEY",
    "WIKI_SESSION_KEY",
    "MADHOUSE_STORAGE_TOKEN",
    "MADHOUSE_BRIDGE_IPC_KEY",
    "WIKI_INITDATA_KEY",
  ]) {
    if (
      env[name] &&
      /^[a-f0-9]{64}$/i.test(env[name]) &&
      env.MADHOUSE_GAME_EXECUTOR_KEY.toLowerCase() === env[name].toLowerCase()
    )
      throw new Error(`MADHOUSE_GAME_EXECUTOR_KEY must differ from ${name}`);
  }
  if (
    env.MADHOUSE_SERVICE === "connector" &&
    env.MADHOUSE_GAME_EXECUTOR_ORIGIN !== "http://wiki:9095"
  )
    throw new Error(
      "MADHOUSE_GAME_EXECUTOR_ORIGIN must be http://wiki:9095 for connector",
    );
  if (!env.MADHOUSE_STORAGE_TOKEN || env.MADHOUSE_STORAGE_TOKEN.length < 32)
    throw new Error("MADHOUSE_STORAGE_TOKEN must be configured");
  let url;
  try {
    url = new URL(env.MADHOUSE_STORAGE_ORIGIN);
  } catch {
    throw new Error("MADHOUSE_STORAGE_ORIGIN must be a valid HTTPS URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("MADHOUSE_STORAGE_ORIGIN must be a valid HTTPS URL");
}
