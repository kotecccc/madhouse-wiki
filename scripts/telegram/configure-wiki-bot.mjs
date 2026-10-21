import { wikiBotSettings } from "./wiki-bot.mjs";

const token = process.env.TELEGRAM_BOT_TOKEN;
const webhookSecret = process.env.TELEGRAM_BOT_WEBHOOK_SECRET;
const siteUrl = process.env.WIKI_PUBLIC_ORIGIN || wikiBotSettings.wikiOrigin;
const webhookOrigin = process.env.TELEGRAM_BOT_WEBHOOK_ORIGIN;
const metadataOnly = process.argv.includes("--metadata-only");
let webhookUrl;

if (!token || (!metadataOnly && !webhookSecret)) {
  console.error(metadataOnly
    ? "Set TELEGRAM_BOT_TOKEN in the environment."
    : "Set TELEGRAM_BOT_TOKEN and TELEGRAM_BOT_WEBHOOK_SECRET in the environment.");
  process.exit(1);
}
if (!metadataOnly && !/^[A-Za-z0-9_-]{32,256}$/.test(webhookSecret)) {
  console.error(
    "TELEGRAM_BOT_WEBHOOK_SECRET must be 32–256 characters using letters, digits, _ or -.",
  );
  process.exit(1);
}
let normalizedSiteUrl;
try {
  const origin = new URL(siteUrl);
  if (origin.protocol !== "https:") throw new Error("https_required");
  normalizedSiteUrl = origin.origin;
} catch {
  console.error("WIKI_PUBLIC_ORIGIN must be an HTTPS URL.");
  process.exit(1);
}
if (!metadataOnly) {
  try {
    const origin = new URL(webhookOrigin);
    if (origin.protocol !== "https:") throw new Error("https_required");
    webhookUrl = new URL(wikiBotSettings.webhookPath, origin).toString();
  } catch {
    console.error("TELEGRAM_BOT_WEBHOOK_ORIGIN must be an HTTPS URL.");
    process.exit(1);
  }
}

async function callBotApi(method, payload = {}) {
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new Error(`Telegram Bot API ${method} request failed`);
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.ok !== true) {
    throw new Error(`Telegram Bot API ${method} request failed`);
  }
  return data.result;
}

function safeWebhookAddress(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "unavailable";
  }
}

try {
  const bot = await callBotApi("getMe");
  if (bot?.username?.toLocaleLowerCase("en-US") !== wikiBotSettings.username) {
    console.error(
      `The supplied token belongs to @${bot?.username || "unknown"}; expected @${wikiBotSettings.username}. No settings were changed.`,
    );
    process.exit(1);
  }
  if (bot.supports_inline_queries !== true) {
    throw new Error(
      "Inline mode is disabled; enable it with /setinline in @BotFather first",
    );
  }

  const description =
    "Справочник Madhouse: этажи, условия отделений, энергия работ и актуальные рейды. Inline-карточки можно отправлять в общие чаты. " +
    normalizedSiteUrl;
  const shortDescription =
    "Этажи, условия, энергия работ и актуальные рейды Madhouse.";

  await callBotApi("setMyName", { name: "Madhouse Wiki" });
  await callBotApi("setMyDescription", { description });
  await callBotApi("setMyShortDescription", {
    short_description: shortDescription,
  });
  await callBotApi("setMyCommands", {
    commands: [
      { command: "start", description: "Открыть Madhouse Wiki" },
      {
        command: "help",
        description: "Как пользоваться и делиться карточками",
      },
      { command: "floors", description: "Условия открытия этажей" },
      { command: "energy", description: "Энергия отделений" },
      { command: "raids", description: "Актуальное расписание рейдов" },
    ],
  });
  await callBotApi("setChatMenuButton", {
    menu_button: {
      type: "web_app",
      text: "Открыть Wiki",
      web_app: { url: normalizedSiteUrl },
    },
  });

  if (metadataOnly) {
    console.log(
      JSON.stringify({
        configured: true,
        username: bot.username,
        menuButton: "Открыть Wiki",
        commands: ["start", "help", "floors", "energy", "raids"],
        webhookConfigured: false,
      }),
    );
    process.exit(0);
  }

  await callBotApi("setWebhook", {
    url: webhookUrl,
    secret_token: webhookSecret,
    allowed_updates: ["message", "inline_query"],
    drop_pending_updates: false,
  });

  const webhook = await callBotApi("getWebhookInfo");
  if (safeWebhookAddress(webhook?.url) !== safeWebhookAddress(webhookUrl)) {
    throw new Error("Webhook read-back did not match the configured endpoint");
  }
  console.log(
    JSON.stringify({
      configured: true,
      username: bot.username,
      menuButton: "Открыть Wiki",
      webhook: safeWebhookAddress(webhook.url),
      commands: ["start", "help", "floors", "energy", "raids"],
    }),
  );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Telegram setup failed",
  );
  process.exitCode = 1;
}
