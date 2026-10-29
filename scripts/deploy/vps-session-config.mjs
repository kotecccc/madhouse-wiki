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
