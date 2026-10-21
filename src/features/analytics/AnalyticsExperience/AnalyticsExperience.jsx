import { useState } from "react";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { Modal } from "../../../components/ui/Modal/Modal.jsx";
import { telegramContext } from "../../../../shared/telegram-context.js";
import {
  analyticsRequestContext,
  clearQueuedAnalytics,
  forgetAnalyticsIdentity,
  getAnalyticsConsent,
  setAnalyticsConsent,
  trackProductEvent,
} from "../analytics-client.js";
import "./AnalyticsExperience.css";

function errorText(code) {
  return (
    {
      analytics_unavailable: "Статистика временно недоступна.",
      analytics_report_unavailable: "Не удалось загрузить отчёт.",
      analytics_delete_unavailable:
        "Не удалось удалить данные. Попробуйте позже.",
      telegram_session_invalid:
        "Сессия Telegram устарела. Перезапустите Mini App.",
      telegram_session_required:
        "Откройте панель администратора в Mini App Telegram.",
      forbidden: "Отчёт доступен только администратору.",
    }[code] || "Запрос не выполнен. Попробуйте позже."
  );
}

function csvCell(value) {
  const safe = String(value ?? "")
    .replace(/^[=+@-]/u, "'$&")
    .replace(/\r?\n/gu, " ");
  return `"${safe.replaceAll('"', '""')}"`;
}

function downloadReport(report) {
  const rows = [
    ["Дата", "Открытия", "Уникальные посетители"],
    ...report.daily.map((item) => [item.day, item.visits, item.uniqueVisitors]),
    [],
    ["Раздел", "Действия"],
    ...report.bySection.map((item) => [item.name, item.count]),
    [],
    ["Функция", "Действия"],
    ...report.byFeature.map((item) => [item.name, item.count]),
    [],
    ["Объект", "Действия"],
    ...report.bySubject.map((item) => [item.name, item.count]),
    [],
    ["Событие", "Количество"],
    ...report.byEvent.map((item) => [item.name, item.count]),
    [],
    ["Псевдоним", "Действия", "Первое событие", "Последнее событие"],
    ...report.visitors.map((item) => [
      item.visitor,
      item.events,
      item.firstSeen,
      item.lastSeen,
    ]),
  ];
  const content = `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
  const url = URL.createObjectURL(
    new Blob([content], { type: "text/csv;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "madhouse-wiki-analytics.csv";
  anchor.click();
  URL.revokeObjectURL(url);
}

export function AnalyticsExperience({ settingsOpen, onClose }) {
  const [consent, setConsent] = useState(() => getAnalyticsConsent());
  const [reportState, setReportState] = useState({
    status: "idle",
    report: null,
    message: "",
  });
  const [deleteState, setDeleteState] = useState({
    status: "idle",
    message: "",
  });
  const telegram = telegramContext();

  function chooseConsent(value) {
    setAnalyticsConsent(value);
    setConsent(value);
    setDeleteState({ status: "idle", message: "" });
    if (value === "accepted") trackProductEvent("app_open");
    else clearQueuedAnalytics();
  }

  async function loadReport() {
    const context = analyticsRequestContext();
    if (!context?.initData) {
      setReportState({
        status: "error",
        report: null,
        message: "Откройте панель администратора в Mini App Telegram.",
      });
      return;
    }
    setReportState({ status: "loading", report: null, message: "" });
    try {
      const response = await fetch("/api/analytics", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "report", ...context }),
        cache: "no-store",
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "report_failed");
      setReportState({ status: "ready", report: result, message: "" });
    } catch (error) {
      setReportState({
        status: "error",
        report: null,
        message: errorText(error.message),
      });
    }
  }

  async function deleteMyData() {
    const context = analyticsRequestContext();
    if (!context) {
      setDeleteState({
        status: "error",
        message: "Для удаления нужны настройки приватности на этом устройстве.",
      });
      return;
    }
    setDeleteState({ status: "loading", message: "Удаляем…" });
    try {
      const response = await fetch("/api/analytics", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "delete-self", ...context }),
        cache: "no-store",
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "delete_failed");
      clearQueuedAnalytics();
      forgetAnalyticsIdentity();
      setAnalyticsConsent("rejected");
      setConsent("rejected");
      setDeleteState({
        status: "ready",
        message: `Удалено событий: ${result.deletedEvents}. Сбор отключён.`,
      });
    } catch (error) {
      setDeleteState({ status: "error", message: errorText(error.message) });
    }
  }

  const showConsent = consent == null;
  const hasVisitorIdentity = Boolean(analyticsRequestContext());

  return (
    <>
      {showConsent && (
        <BaseCard
          as="aside"
          variant="token-help"
          className="analytics-consent"
          aria-labelledby="analytics-consent-title"
        >
          <strong id="analytics-consent-title">
            Разрешить анонимную статистику?
          </strong>
          <p>
            Она помогает понять, какие разделы Wiki полезны. Будут записываться
            только типы действий, разделы и псевдонимный идентификатор. Без
            текста, скриншотов, имени, Telegram ID, прогресса или токенов. Срок
            хранения — 90 дней. Подробности — в настройках приватности.
          </p>
          <div className="analytics-consent-actions">
            <Button
              variant="secondary"
              onClick={() => chooseConsent("rejected")}
            >
              Не разрешать
            </Button>
            <Button variant="primary" onClick={() => chooseConsent("accepted")}>
              Разрешить
            </Button>
          </div>
        </BaseCard>
      )}
      <Modal
        title="Приватность и статистика"
        titleId="analytics-settings-title"
        description="Управляйте необязательной статистикой использования Wiki."
        visible={settingsOpen}
        onClose={onClose}
        className="analytics-settings-modal"
        width="min(720px, calc(100vw - 24px))"
      >
        <section className="analytics-privacy-copy">
          <h3>Что собирается</h3>
          <p>
            Только выбранные типы действий (например, открытие этажа), раздел и
            безопасный код объекта. Если вы согласились, случайный браузерный ID
            или HMAC-псевдоним от Telegram ID используется для подсчёта
            уникальных посетителей и удаления ваших записей.
          </p>
          <p>
            Содержание обращений, изображения, имя, username, сырой Telegram ID,
            токены, initData и данные игрового аккаунта в аналитику не попадают.
            Wiki не сохраняет IP-адреса или user-agent в собственном хранилище
            аналитики. Данные событий лежат в приватном Vercel Blob до 90 дней,
            затем ежедневно очищаются.
          </p>
          <p>
            При отправке обратной связи её текст и выбранный скриншот вместе с
            Telegram ID, именем и username из проверенной Telegram-сессии сразу
            отправляются администратору в личный чат Telegram. Wiki не хранит
            эти обращения в каталоге или аналитике.
          </p>
        </section>
        <div className="analytics-consent-actions analytics-settings-actions">
          <Button variant="secondary" onClick={() => chooseConsent("rejected")}>
            Отключить сбор
          </Button>
          <Button variant="primary" onClick={() => chooseConsent("accepted")}>
            Разрешить сбор
          </Button>
        </div>
        <div className="analytics-delete-row">
          <p>Удаление очистит ранее записанные события для этого псевдонима.</p>
          <Button
            variant="secondary"
            disabled={deleteState.status === "loading" || !hasVisitorIdentity}
            onClick={deleteMyData}
          >
            {deleteState.status === "loading"
              ? "Удаляем…"
              : "Отключить и удалить мои данные"}
          </Button>
          {deleteState.message && (
            <p
              className={`analytics-operation-message is-${deleteState.status}`}
              role="status"
            >
              {deleteState.message}
            </p>
          )}
        </div>
        {telegram.initData && (
          <section
            className="analytics-admin-report"
            aria-labelledby="analytics-admin-title"
          >
            <h3 id="analytics-admin-title">Статистика администратора</h3>
            <p>
              Доступ проверяется сервером по подписи Telegram. Пользовательские
              ID и профили в отчёт не включаются.
            </p>
            <Button
              variant="secondary"
              disabled={reportState.status === "loading"}
              onClick={loadReport}
            >
              {reportState.status === "loading"
                ? "Загружаем…"
                : "Загрузить отчёт за 30 дней"}
            </Button>
            {reportState.message && (
              <p className="analytics-operation-message" role="status">
                {reportState.message}
              </p>
            )}
            {reportState.report && (
              <AnalyticsReport report={reportState.report} />
            )}
          </section>
        )}
      </Modal>
    </>
  );
}

function AnalyticsReport({ report }) {
  const summary = [
    ["Событий", report.events],
    ["Открытий Wiki", report.visits],
    ["Уникальных посетителей", report.uniqueVisitors],
  ];
  return (
    <div className="analytics-report">
      <p>
        Период: {new Date(report.range.from).toLocaleDateString("ru-RU")} —{" "}
        {new Date(report.range.to).toLocaleDateString("ru-RU")}
        {report.truncated ? ". Показан доступный фрагмент отчёта." : ""}
      </p>
      <dl className="analytics-report-summary">
        {summary.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <Button variant="secondary" onClick={() => downloadReport(report)}>
        Скачать CSV
      </Button>
      <h4>Действия по разделам</h4>
      <ReportList rows={report.bySection} empty="Нет событий." />
      <h4>Использование функций</h4>
      <ReportList rows={report.byFeature} empty="Нет событий." />
      <h4>Использование объектов</h4>
      <ReportList rows={report.bySubject} empty="Нет событий." />
      <h4>По дням</h4>
      <div className="analytics-table-scroll">
        <table>
          <thead>
            <tr>
              <th>Дата</th>
              <th>Открытия</th>
              <th>Посетители</th>
            </tr>
          </thead>
          <tbody>
            {report.daily.map((item) => (
              <tr key={item.day}>
                <td>{item.day}</td>
                <td>{item.visits}</td>
                <td>{item.uniqueVisitors}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h4>Посетители по псевдониму</h4>
      <div className="analytics-table-scroll">
        <table>
          <thead>
            <tr>
              <th>Псевдоним</th>
              <th>События</th>
              <th>Первый визит</th>
              <th>Последний визит</th>
            </tr>
          </thead>
          <tbody>
            {report.visitors.map((item) => (
              <tr key={item.visitor}>
                <td>{item.visitor}</td>
                <td>{item.events}</td>
                <td>{new Date(item.firstSeen).toLocaleDateString("ru-RU")}</td>
                <td>{new Date(item.lastSeen).toLocaleDateString("ru-RU")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ReportList({ rows, empty }) {
  if (!rows.length) return <p>{empty}</p>;
  return (
    <ul className="analytics-report-list">
      {rows.map((row) => (
        <li key={row.name}>
          <span>{row.name}</span>
          <strong>{row.count}</strong>
        </li>
      ))}
    </ul>
  );
}
