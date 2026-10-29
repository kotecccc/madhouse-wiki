const KEY = "madhouse-wiki.connector-identity-proof.v1";

async function fingerprint(launch) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(launch),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function readIdentityProof(storage, launch) {
  try {
    const saved = JSON.parse(storage.getItem(KEY) || "null");
    if (
      saved?.launchHash === (await fingerprint(launch)) &&
      typeof saved.proof === "string" &&
      saved.proof.length > 0 &&
      saved.proof.length <= 8192
    )
      return saved.proof;
  } catch {
    // Storage can be unavailable in a Telegram WebView.
  }
  return null;
}

export async function saveIdentityProof(storage, launch, proof) {
  try {
    storage.setItem(
      KEY,
      JSON.stringify({ launchHash: await fingerprint(launch), proof }),
    );
  } catch {
    // The in-memory proof still works until the page is reloaded.
  }
}

export function clearIdentityProof(storage) {
  try {
    storage.removeItem(KEY);
  } catch {
    // Storage can be unavailable in a Telegram WebView.
  }
}
