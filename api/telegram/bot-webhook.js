import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readKnowledgeBase } from "../../scripts/catalogue/query.mjs";
import { createWikiBotApi } from "../../scripts/telegram/wiki-bot.mjs";
import { createWikiBotVercelHandler } from "../../scripts/telegram/wiki-bot-vercel-handler.mjs";

const functionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const knowledgeBase = readKnowledgeBase(functionRoot);
const api = createWikiBotApi({
  token: process.env.TELEGRAM_BOT_TOKEN,
  webhookSecret: process.env.TELEGRAM_BOT_WEBHOOK_SECRET,
  knowledgeBase,
  wikiOrigin: process.env.WIKI_PUBLIC_ORIGIN,
});

export default createWikiBotVercelHandler(api);
