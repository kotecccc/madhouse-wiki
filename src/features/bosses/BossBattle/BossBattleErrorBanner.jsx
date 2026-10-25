import "./BossBattleErrorBanner.css";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";

function errorMessage(status, error) {
  if (status === 401) return "Сессия игры истекла. Войдите заново.";
  if (status === 403) return "Сервер отказал в доступе к бою.";
  if (status === 429)
    return "Слишком много запросов. Подождите и обновите бой.";
  if (status === 500 || status === 503)
    return "Сервис боя временно недоступен. Попробуйте обновить состояние боя позже.";
  if (error) return error;
  return "Не удалось проверить состояние боя. Обновите состояние.";
}

export function BossBattleErrorBanner({ state }) {
  if (
    !state?.error &&
    !state?.errorStatus &&
    (!state?.needsRefresh || state?.pending)
  )
    return null;
  const status = state.errorStatus;
  const message = errorMessage(status, state.error);
  return (
    <BaseCard
      className="boss-battle-error-banner"
      role="alert"
      aria-live="assertive"
    >
      <CardTitle as="h3">Не удалось выполнить запрос боя</CardTitle>
      {status ? (
        <CardDescription>
          {message} HTTP {status}
        </CardDescription>
      ) : (
        <CardDescription title={message}>{message}</CardDescription>
      )}
    </BaseCard>
  );
}
