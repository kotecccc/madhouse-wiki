import { pathToFileURL } from "node:url";

export async function notifyHealthyRelease({
  env = process.env,
  fetcher = fetch,
} = {}) {
  const sha = env.MADHOUSE_RELEASE_SHA;
  const token = env.TELEGRAM_BOT_TOKEN;
  const admin = env.WIKI_ADMIN_TELEGRAM_ID;
  if (
    !/^[a-f0-9]{40}$/.test(sha || "") ||
    !token ||
    !/^\d{1,16}$/.test(admin || "")
  )
    throw new Error("release_notification_not_configured");
  for (const [origin, service] of [
    ["http://127.0.0.1:9092", "wiki"],
    ["http://connector:9093", "connector"],
  ]) {
    const response = await fetcher(`${origin}/healthz`, {
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error("release_health_not_confirmed");
    const health = await response.json();
    if (health.service !== service || health.sourceCommit !== sha)
      throw new Error("release_health_not_confirmed");
  }
  // A lost reply must not trigger an automatic duplicate notification.
  const response = await fetcher(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: admin,
        text: `✅ Madhouse Wiki обновлена\nВерсия: ${sha.slice(0, 12)}\nWiki и Telegram-коннектор запущены, проверки доступности пройдены.\nhttps://madhouse-wiki.ru`,
        link_preview_options: { is_disabled: true },
      }),
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!response.ok) {
    let telegramReason = "";
    if (response.status === 403) {
      try {
        const body = await response.json();
        const description =
          typeof body?.description === "string" &&
          body.description.length <= 256
            ? body.description.toLowerCase()
            : "";
        if (/blocked (?:the )?bot|bot was blocked/.test(description))
          telegramReason = "_telegram_recipient_blocked";
        else if (
          /chat not found|can't initiate|cannot initiate|start a conversation/.test(
            description,
          )
        )
          telegramReason = "_telegram_recipient_unavailable";
        else if (
          /not enough rights|can't write|cannot write|write forbidden|not a member|was kicked/.test(
            description,
          )
        )
          telegramReason = "_telegram_write_forbidden";
      } catch {
        // Keep response bodies private; the status remains the safe fallback.
      }
    }
    throw new Error(
      `release_notification_http_${response.status}${telegramReason}`,
    );
  }
  if ((await response.json()).ok !== true)
    throw new Error("release_notification_rejected");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await notifyHealthyRelease();
    console.log("Release notification delivered to configured administrator");
  } catch (error) {
    // Do not print fetch errors, Bot API URLs, responses or environment values.
    const reason =
      /^release_(?:notification_http_\d{3}(?:_telegram_(?:recipient_blocked|recipient_unavailable|write_forbidden))?|notification_rejected|notification_not_configured|health_not_confirmed)$/.test(
        error?.message,
      )
        ? error.message
        : "release_notification_transport_or_response_error";
    console.error(
      `Release notification could not be delivered or health was not confirmed: ${reason}`,
    );
    process.exitCode = 1;
  }
}
