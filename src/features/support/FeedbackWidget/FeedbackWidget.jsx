import { useRef, useState } from "react";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { FieldLabel } from "../../../components/ui/FieldLabel/FieldLabel.jsx";
import { Modal } from "../../../components/ui/Modal/Modal.jsx";
import { telegramContext } from "../../../../shared/telegram-context.js";
import { trackProductEvent } from "../../analytics/analytics-client.js";
import "./FeedbackWidget.css";

const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function errorText(code) {
  return (
    {
      telegram_session_required:
        "Чтобы отправить обращение, откройте Wiki внутри Telegram.",
      unsupported_image: "Выберите изображение JPEG, PNG или WebP.",
      invalid_image: "Не удалось проверить формат изображения.",
      image_too_large: "Скриншот должен быть не больше 2 МБ.",
      message_required: "Добавьте текст или скриншот.",
      message_too_long: "Сократите текст обращения для выбранного скриншота.",
      feedback_rate_limited: "Можно отправить не больше трёх обращений в час.",
      feedback_delivery_failed:
        "Telegram не доставил обращение. Попробуйте позже.",
      feedback_unavailable: "Отправка обращений временно недоступна.",
    }[code] || "Не удалось отправить обращение. Попробуйте позже."
  );
}

function encodeFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("file_read_failed"));
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result : "";
      const separator = value.indexOf(",");
      if (separator < 0) reject(new Error("file_read_failed"));
      else resolve(value.slice(separator + 1));
    };
    reader.readAsDataURL(file);
  });
}

export function FeedbackWidget({ screen = "floors", onOpenPrivacy }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [file, setFile] = useState(null);
  const [status, setStatus] = useState({ state: "idle", message: "" });
  const fileInput = useRef(null);
  const telegram = telegramContext();

  function openDialog() {
    setStatus({ state: "idle", message: "" });
    setOpen(true);
    trackProductEvent("feedback_open", {
      section: "feedback",
      feature: "feedback_form",
    });
  }

  function selectFile(nextFile) {
    if (!nextFile) {
      setFile(null);
      return;
    }
    if (!ACCEPTED_TYPES.has(nextFile.type)) {
      setFile(null);
      setStatus({ state: "error", message: errorText("unsupported_image") });
      if (fileInput.current) fileInput.current.value = "";
      return;
    }
    if (!nextFile.size || nextFile.size > MAX_SCREENSHOT_BYTES) {
      setFile(null);
      setStatus({
        state: "error",
        message: errorText(nextFile.size ? "image_too_large" : "invalid_image"),
      });
      if (fileInput.current) fileInput.current.value = "";
      return;
    }
    setFile(nextFile);
    setStatus({
      state: "idle",
      message: message.length > 650 ? errorText("message_too_long") : "",
    });
  }

  async function submit(event) {
    event.preventDefault();
    if (!telegram.initData) {
      setStatus({
        state: "error",
        message: errorText("telegram_session_required"),
      });
      return;
    }
    if (!message.trim() && !file) {
      setStatus({ state: "error", message: errorText("message_required") });
      return;
    }
    setStatus({ state: "loading", message: "Отправляем…" });
    try {
      const screenshot = file
        ? { base64: await encodeFile(file), mimeType: file.type }
        : null;
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          initData: telegram.initData,
          message,
          screenshot,
          screen,
        }),
        cache: "no-store",
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "feedback_failed");
      setMessage("");
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
      trackProductEvent("feedback_submit", {
        section: "feedback",
        feature: "feedback_form",
      });
      setStatus({
        state: "sent",
        message: `Обращение ${result.feedbackId} отправлено администратору.`,
      });
    } catch (error) {
      setStatus({ state: "error", message: errorText(error.message) });
    }
  }

  return (
    <>
      <Button
        variant="primary"
        className="feedback-floating-button"
        icon="bug"
        iconSize="medium"
        onClick={openDialog}
        aria-label="Сообщить об ошибке"
      >
        Сообщить об ошибке
      </Button>
      <Modal
        title="Обратная связь"
        titleId="feedback-title"
        description="Расскажите об ошибке или предложении. Скриншот поможет быстрее разобраться."
        visible={open}
        onClose={() => setOpen(false)}
        className="feedback-modal"
        width="min(560px, calc(100vw - 24px))"
      >
        <form className="feedback-form" onSubmit={submit}>
          <FieldLabel
            htmlFor="feedback-message"
            className="feedback-field-label"
          >
            Сообщение
          </FieldLabel>
          <textarea
            id="feedback-message"
            className="feedback-message"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            maxLength={file ? 650 : 1600}
            rows={6}
            placeholder="Что произошло или что стоит улучшить?"
            disabled={status.state === "loading" || status.state === "sent"}
          />
          <div className="feedback-file-row">
            <FieldLabel
              htmlFor="feedback-screenshot"
              className="feedback-field-label"
            >
              Скриншот (необязательно)
            </FieldLabel>
            <input
              ref={fileInput}
              id="feedback-screenshot"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(event) => selectFile(event.target.files?.[0])}
              disabled={status.state === "loading" || status.state === "sent"}
            />
            <small>JPEG, PNG или WebP · до 2 МБ</small>
            {file && (
              <div className="feedback-selected-file">
                <span>{file.name}</span>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setFile(null);
                    if (fileInput.current) fileInput.current.value = "";
                  }}
                >
                  Удалить файл
                </Button>
              </div>
            )}
          </div>
          <p className="feedback-privacy-note">
            Текст и скриншот сразу отправятся администратору в личный чат
            Telegram вместе с Telegram ID, именем и username из проверенной
            сессии. Wiki не сохраняет обращение у себя.{" "}
            <button
              type="button"
              className="feedback-privacy-link"
              onClick={onOpenPrivacy}
            >
              Настройки приватности
            </button>
          </p>
          {status.message && (
            <p
              className={`feedback-status feedback-status--${status.state}`}
              role="status"
            >
              {status.message}
            </p>
          )}
          <div className="feedback-actions">
            {status.state === "sent" ? (
              <Button variant="primary" onClick={() => setOpen(false)}>
                Готово
              </Button>
            ) : (
              <Button
                variant="primary"
                type="submit"
                disabled={!telegram.initData || status.state === "loading"}
              >
                {status.state === "loading" ? "Отправляем…" : "Отправить"}
              </Button>
            )}
          </div>
        </form>
      </Modal>
    </>
  );
}
