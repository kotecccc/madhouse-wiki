import { readFile, stat, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const upstream = "https://cargohustle.online";
const LIVE_PROOF_GATE = "MADHOUSE_ENABLE_LIVE_GAME_AUTH_PROOF";

function requireLiveProofGate() {
  if (process.env[LIVE_PROOF_GATE] !== "1")
    throw new Error("live_game_auth_proof_not_enabled");
}

/** One deliberate login, then one authenticated read. No previous token or refresh path. */
export async function proveGameAuth(initData, fetchImpl = null) {
  const params = new URLSearchParams(initData);
  const authDate = Number(params.get("auth_date"));
  if (
    !initData ||
    !params.get("hash") ||
    !Number.isFinite(authDate) ||
    authDate <= 0
  ) {
    throw new Error("invalid_init_data_shape");
  }
  if (fetchImpl === null) {
    requireLiveProofGate();
    fetchImpl = globalThis.fetch;
  }
  if (typeof fetchImpl !== "function")
    throw new TypeError("game_auth_fetch_unavailable");
  const proof = {
    checkedAt: new Date().toISOString(),
    upstream,
    authRequestHadBearer: false,
    authAgeSeconds: Math.floor(Date.now() / 1000) - authDate,
    accessTokenPresent: false,
  };
  const auth = await fetchImpl(`${upstream}/api/auth/telegram`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initData }),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  proof.authStatus = auth.status;
  let body;
  try {
    body = await auth.json();
  } catch {
    proof.error = "auth_response_not_json";
    return proof;
  }
  if (!auth.ok) {
    proof.error =
      body?.error === "telegram_auth_failed"
        ? "telegram_auth_failed"
        : "auth_rejected";
    return proof;
  }
  const token = body?.accessToken;
  proof.accessTokenPresent = typeof token === "string" && token.length > 0;
  if (!proof.accessTokenPresent) {
    proof.error = "access_token_missing";
    return proof;
  }
  const me = await fetchImpl(`${upstream}/api/me`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  proof.meStatus = me.status;
  try {
    const profile = await me.json();
    proof.meIsObject =
      !!profile && typeof profile === "object" && !Array.isArray(profile);
  } catch {
    proof.meIsObject = false;
  }
  // Token and profile are deliberately not returned, logged, or saved.
  return proof;
}

async function main() {
  requireLiveProofGate();
  if (process.argv.length !== 3)
    throw new Error("usage_node_prove_game_auth_private_init_data_file");
  const input = await realpath(process.argv[2]);
  const repo = await realpath(
    fileURLToPath(new URL("../../", import.meta.url)),
  );
  const relative = path.relative(repo, input);
  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  ) {
    throw new Error("input_must_be_outside_repository");
  }
  const info = await stat(input);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 32_768) {
    throw new Error("input_must_be_private_file_mode_600_or_400_under_32kb");
  }
  const proof = await proveGameAuth((await readFile(input, "utf8")).trim());
  console.log(JSON.stringify(proof, null, 2));
  if (!(
    proof.authStatus === 200 &&
    proof.accessTokenPresent &&
    proof.meStatus === 200 &&
    proof.meIsObject
  )) {
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch(() => {
    // Even transport error messages can contain URLs or request data; print no raw exception.
    console.error(
      "Game auth proof failed. Check the private input, permissions, and connectivity.",
    );
    process.exitCode = 1;
  });
}
