import { createWikiAnalyticsCleanupApi } from "../scripts/analytics/wiki-analytics-api.mjs";
import { createWikiAnalyticsStore } from "../scripts/analytics/wiki-analytics-store.mjs";
import { createWikiCleanupVercelHandler } from "../scripts/telegram/wiki-api-vercel-handler.mjs";

export default createWikiCleanupVercelHandler(
  createWikiAnalyticsCleanupApi({
    cronSecret: process.env.CRON_SECRET,
    store: createWikiAnalyticsStore(),
  }),
);
