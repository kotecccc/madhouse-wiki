import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { readKnowledgeBase } from "../../scripts/catalogue/query.mjs";
import { createWikiBotApi } from "../../scripts/telegram/wiki-bot.mjs";
import { createWikiBotVercelHandler } from "../../scripts/telegram/wiki-bot-vercel-handler.mjs";
import { bridgeBootstrapSha } from "../../scripts/bridge/release-config.mjs";

const functionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const knowledgeBase = readKnowledgeBase(functionRoot);
export function createBotWebhook(bridgeDevices = null, bridgeReporter = null) {
  return createWikiBotVercelHandler(
    createWikiBotApi({
      token: process.env.TELEGRAM_BOT_TOKEN,
      webhookSecret: process.env.TELEGRAM_BOT_WEBHOOK_SECRET,
      knowledgeBase,
      wikiOrigin: process.env.WIKI_PUBLIC_ORIGIN,
      bridgeDevices,
      bridgeReporter,
      bridgeBootstrapSha256: bridgeBootstrapSha(
        JSON.parse(
          readFileSync(
            new URL(
              "../../scripts/bridge/release-config.json",
              import.meta.url,
            ),
            "utf8",
          ),
        ),
      ),
    }),
  );
}

export default createBotWebhook();
