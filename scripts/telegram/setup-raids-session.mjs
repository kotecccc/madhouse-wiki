import QRCode from "qrcode";
import { createRaidSessionStore } from "./raid-session-store.mjs";
import { createRaidTelegramClient } from "./raid-mtproto-client.mjs";

const replace = process.argv.includes("--replace");
const store = createRaidSessionStore();
if (!replace && (await store.exists()))
  throw new Error("A raid Telegram session is already configured.");

function readHiddenPassword() {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== "function")
    throw new Error("Two-step verification requires a private interactive terminal.");
  input.setEncoding("utf8");
  input.setRawMode(true);
  input.resume();
  process.stdout.write("Telegram two-step verification password (hidden): ");

  return new Promise((resolve, reject) => {
    let password = "";
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(false);
      process.stdout.write("\n");
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Telegram session setup cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(password);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          password = [...password].slice(0, -1).join("");
          continue;
        }
        if (character >= " ") password += character;
      }
    };
    input.on("data", onData);
  });
}

const client = await createRaidTelegramClient();
let saved = false;
try {
  console.log(
    "Scan this QR code with the Telegram account that can read @raidsMadness.",
  );
  const user = await client.start({
    qrCodeHandler: async (url) => {
      console.clear();
      console.log(
        "Telegram → Settings → Devices → Link Desktop Device. Scan this code:",
      );
      console.log(
        await QRCode.toString(url, { type: "terminal", small: true }),
      );
    },
    password: readHiddenPassword,
    invalidCodeCallback: (type) => {
      if (type === "password")
        console.log("Telegram did not accept that password; try again.");
    },
  });
  if (user.isBot) throw new Error("A user Telegram account is required.");
  const channel = await client.getChat("@raidsMadness");
  if (
    channel.chatType !== "channel" ||
    channel.username?.toLocaleLowerCase("en-US") !== "raidsmadness"
  )
    throw new Error(
      "The Telegram account could not resolve the target channel.",
    );

  let canReadHistory = false;
  for await (const _message of client.iterHistory(channel.inputPeer, {
    limit: 1,
  })) {
    canReadHistory = true;
    break;
  }
  if (!canReadHistory)
    throw new Error(
      "The target channel history is not available to this account.",
    );

  await store.save(await client.exportSession(), { replace });
  saved = true;
  console.log("Encrypted Telegram session saved to private Vercel Blob.");
} finally {
  if (!saved) {
    try {
      await client.logOut();
    } catch {
      // Revoke any session created by an incomplete setup.
    }
  }
  await client.destroy();
}
