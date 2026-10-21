import { createFeedbackApi } from "../scripts/telegram/feedback-api.mjs";
import { createWikiApiVercelHandler } from "../scripts/telegram/wiki-api-vercel-handler.mjs";

export default createWikiApiVercelHandler(
  createFeedbackApi({
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    adminTelegramId: process.env.WIKI_ADMIN_TELEGRAM_ID,
    wikiOrigin: process.env.WIKI_PUBLIC_ORIGIN,
  }),
);
