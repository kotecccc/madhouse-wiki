const secret = process.env.CRON_SECRET;
if (!secret) throw new Error("analytics cleanup is not configured");

const response = await fetch("http://127.0.0.1:9092/api/analytics-cleanup", {
  headers: { Authorization: `Bearer ${secret}` },
  signal: AbortSignal.timeout(90_000),
});
await response.arrayBuffer();
if (!response.ok)
  throw new Error(`analytics cleanup failed with status ${response.status}`);
console.log("Wiki analytics cleanup completed");
