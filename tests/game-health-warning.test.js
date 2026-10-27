import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

test("game health warning keeps error details unmounted until requested", async () => {
  const server = await createServer({
    configFile: false,
    plugins: [react()],
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  try {
    const { reportGameHealth } = await server.ssrLoadModule(
      "/shared/session-api.js",
    );
    const {
      GameHealthWarningBanner,
      GameHealthWarningIndicator,
      GameHealthDetails,
      healthRefreshLabel,
      formatLastSuccess,
    } = await server.ssrLoadModule(
      "/src/components/layout/BottomDock/GameHealthWarning.jsx",
    );
    assert.equal(healthRefreshLabel(59, true), "Обновить 0:59");
    assert.equal(healthRefreshLabel(0, true), "Проверяем…");
    assert.equal(healthRefreshLabel(0, false), "Обновить");
    for (const status of ["unavailable", "credentials_invalid"]) {
      reportGameHealth({ status: "unknown" });
      if (status === "unavailable") {
        const now = Date.now();
        const failure = (checkedAt) =>
          reportGameHealth({
            status,
            failedFeatures: ["bosses", "inventory"],
            featureCheckedAt: { bosses: checkedAt },
          });
        failure(now - 30000);
        assert.equal(
          renderToStaticMarkup(createElement(GameHealthWarningBanner)),
          "",
        );
        failure(now - 30000); // The cached observation is not a new check.
        failure(now - 15000);
        assert.equal(
          renderToStaticMarkup(createElement(GameHealthWarningIndicator)),
          "",
        );
        failure(now);
      } else reportGameHealth({ status });
      const html = renderToStaticMarkup(createElement(GameHealthWarningBanner));
      assert.match(html, /Закрыть уведомление/);
      assert.match(html, /base-card--warning/);
      assert.match(html, /button--inherit-color/);
      assert.match(html, /ui-toast-region/);
      if (status === "unavailable") {
        assert.match(html, /Могут быть недоступны функции игры: Боссы/);
        assert.doesNotMatch(html, /Инвентарь|Игровые данные/);
      } else assert.match(html, /Требуется повторный вход/);
      const indicator = renderToStaticMarkup(
        createElement(GameHealthWarningIndicator),
      );
      assert.match(indicator, /game-health-warning-indicator--banner-visible/);
      assert.match(indicator, /aria-haspopup="dialog"/);
      assert.doesNotMatch(indicator, /ui-icon--pulse|ui-icon--spin|<dialog\b/);
      assert.doesNotMatch(
        html,
        /<dialog\b|Последнее успешное обновление|Успешных обновлений/,
      );
    }
    for (const status of ["available", "unknown"]) {
      reportGameHealth({ status });
      assert.equal(
        renderToStaticMarkup(createElement(GameHealthWarningBanner)),
        "",
      );
    }
    const { Toast } = await server.ssrLoadModule(
      "/src/components/ui/Toast/Toast.jsx",
    );
    const toast = renderToStaticMarkup(
      createElement(Toast, { children: "Недоступно" }),
    );
    assert.match(toast, /role="status" aria-live="polite"/);
    assert.match(toast, /Недоступно/);
    assert.match(toast, /Закрыть уведомление/);
    const details = (status) =>
      renderToStaticMarkup(
        createElement(GameHealthDetails, {
          health: { status, lastSuccessAt: null },
        }),
      );
    const unavailable = details("unavailable");
    assert.match(
      unavailable,
      /Цели сохраняются, автоматизация проверяет связь/,
    );
    assert.doesNotMatch(
      unavailable,
      /Wiki продолжает работать|О сохранённых данных|Последнее успешное обновление/,
    );
    const invalid = details("credentials_invalid");
    assert.match(invalid, /Требуется повторный вход/);
    assert.doesNotMatch(invalid, /Игровой сервер не отвечает/);
    const failures = renderToStaticMarkup(
      createElement(GameHealthDetails, {
        health: {
          status: "unavailable",
          failedFeatures: ["profile", "inventory", "profile", "secret-path"],
          successfulFeatures: ["clothing", "profile"],
          featureCheckedAt: {
            profile: new Date(2026, 9, 25, 17, 53).getTime(),
            inventory: new Date(2026, 9, 25, 17, 51).getTime(),
          },
        },
      }),
    );
    assert.match(failures, /Состояние сервисов/);
    assert.match(failures, /base-card ui-status-list-card/);
    assert.match(failures, /Профиль/);
    assert.match(failures, /Инвентарь/);
    assert.match(failures, />Гардероб<\/span>/);
    assert.match(failures, /ui-status-list-status">Работает/);
    assert.match(failures, />Оружие<\/span>/);
    assert.match(failures, /ui-status-list-status">Не проверено/);
    assert.match(failures, />Профиль<\/span>/);
    assert.doesNotMatch(failures, /ui-status-list--dated/);
    assert.doesNotMatch(failures, /ui-status-list-meta/);
    assert.match(failures, /ui-status-list-status">Ошибка/);
    assert.doesNotMatch(failures, /25\.10\.2026|<time\b/);
    assert.match(failures, /ui-status-list-dot--success/);
    assert.match(failures, /ui-status-list-dot--error/);
    assert.match(failures, /ui-status-list-dot--unknown/);
    assert.doesNotMatch(failures, /Игровые функции на паузе/);
    assert.doesNotMatch(failures, /secret-path/);
    assert.equal((failures.match(/Профиль/g) || []).length, 1);
    const noFailures = renderToStaticMarkup(
      createElement(GameHealthDetails, {
        health: { status: "unavailable", failedFeatures: [] },
      }),
    );
    assert.doesNotMatch(noFailures, /Ошибки при обращении к игре/);
    const invalidWithFailures = renderToStaticMarkup(
      createElement(GameHealthDetails, {
        health: { status: "credentials_invalid", failedFeatures: ["profile"] },
      }),
    );
    assert.doesNotMatch(
      invalidWithFailures,
      /Ошибки при обращении к игре|Профиль/,
    );
    assert.equal(
      formatLastSuccess(new Date(2026, 9, 25, 14, 51).getTime()),
      "14:51 25.10.2026",
    );
    assert.equal(formatLastSuccess(null), "—");
    const { Skeleton } = await server.ssrLoadModule(
      "/src/components/ui/Skeleton/Skeleton.jsx",
    );
    const profileSkeleton = renderToStaticMarkup(
      createElement(Skeleton, { variant: "profile" }),
    );
    assert.match(profileSkeleton, /ui-skeleton-profile-avatar/);
    assert.match(profileSkeleton, /ui-skeleton-profile-name/);
    assert.match(profileSkeleton, /ui-skeleton-profile-detail/);
    assert.match(profileSkeleton, /aria-hidden="true"/);
    assert.doesNotMatch(profileSkeleton, /<button|Обновляем профиль/);
  } finally {
    await server.close();
  }
});
