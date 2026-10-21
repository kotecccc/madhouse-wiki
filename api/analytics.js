import { createWikiAnalyticsApi } from "../scripts/analytics/wiki-analytics-api.mjs";
import { createWikiAnalyticsStore } from "../scripts/analytics/wiki-analytics-store.mjs";
import { createWikiApiVercelHandler } from "../scripts/telegram/wiki-api-vercel-handler.mjs";

export default createWikiApiVercelHandler(
  createWikiAnalyticsApi({
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    adminTelegramId: process.env.WIKI_ADMIN_TELEGRAM_ID,
    store: createWikiAnalyticsStore(),
  }),
);
