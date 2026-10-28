import test from "node:test";
import assert from "node:assert/strict";
import { notifyHealthyRelease } from "../scripts/deploy/release-notification.mjs";
const sha = "a".repeat(40);
const env = {
  MADHOUSE_RELEASE_SHA: sha,
  TELEGRAM_BOT_TOKEN: "fake-test-token",
  WIKI_ADMIN_TELEGRAM_ID: "123",
};

test("release notification confirms both source SHAs before one private admin message", async () => {
  const calls = [];
  await notifyHealthyRelease({
    env,
    fetcher: async (url, init) => {
      calls.push({ url, init });
      if (calls.length < 3)
        return Response.json({
          service: calls.length === 1 ? "wiki" : "connector",
          sourceCommit: sha,
        });
      return Response.json({ ok: true });
    },
  });
  assert.equal(calls.length, 3);
  assert.ok(calls[0].url.endsWith("/healthz"));
  assert.ok(calls[1].url.endsWith("/healthz"));
  const message = JSON.parse(calls[2].init.body);
  assert.equal(message.chat_id, "123");
  assert.ok(message.text.includes(sha.slice(0, 12)));
  assert.ok(!message.text.includes(env.TELEGRAM_BOT_TOKEN));
});

test("wrong release or unhealthy connector never sends a success message", async () => {
  for (const mismatch of [true, false]) {
    let calls = 0;
    await assert.rejects(
      notifyHealthyRelease({
        env,
        fetcher: async () => {
          calls++;
          if (calls === 1)
            return Response.json({ service: "wiki", sourceCommit: sha });
          return mismatch
            ? Response.json({
                service: "connector",
                sourceCommit: "b".repeat(40),
              })
            : new Response("", { status: 503 });
        },
      }),
      /release_health_not_confirmed/,
    );
    assert.equal(calls, 2);
  }
});

test("missing admin fails before requests and lost Telegram response is never replayed", async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    throw Error("must not call");
  };
  await assert.rejects(
    notifyHealthyRelease({
      env: { ...env, WIKI_ADMIN_TELEGRAM_ID: "" },
      fetcher,
    }),
    /not_configured/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    notifyHealthyRelease({
      env,
      fetcher: async () => {
        calls++;
        if (calls < 3)
          return Response.json({
            service: calls === 1 ? "wiki" : "connector",
            sourceCommit: sha,
          });
        throw Error("lost reply");
      },
    }),
    /lost reply/,
  );
  assert.equal(calls, 3);
});

test("Telegram rejection exposes only the HTTP status and is never retried", async () => {
  let calls = 0;
  await assert.rejects(
    notifyHealthyRelease({
      env,
      fetcher: async () => {
        calls++;
        if (calls < 3)
          return Response.json({
            service: calls === 1 ? "wiki" : "connector",
            sourceCommit: sha,
          });
        return Response.json(
          { description: "private response" },
          { status: 403 },
        );
      },
    }),
    { message: "release_notification_http_403" },
  );
  assert.equal(calls, 3);
});

test("known Telegram 403 causes are reduced to safe diagnostic categories", async () => {
  for (const [description, category] of [
    ["Forbidden: bot was blocked by the user", "recipient_blocked"],
    [
      "Forbidden: bot can't initiate conversation with a user",
      "recipient_unavailable",
    ],
    [
      "Forbidden: bot is not a member and has no write rights",
      "write_forbidden",
    ],
  ]) {
    let calls = 0;
    await assert.rejects(
      notifyHealthyRelease({
        env,
        fetcher: async () => {
          calls++;
          if (calls < 3)
            return Response.json({
              service: calls === 1 ? "wiki" : "connector",
              sourceCommit: sha,
            });
          return Response.json({ description }, { status: 403 });
        },
      }),
      (error) => {
        assert.equal(
          error.message,
          `release_notification_http_403_telegram_${category}`,
        );
        assert.ok(!error.message.includes(description));
        assert.ok(!error.message.includes(env.TELEGRAM_BOT_TOKEN));
        return true;
      },
    );
    assert.equal(calls, 3);
  }
});
