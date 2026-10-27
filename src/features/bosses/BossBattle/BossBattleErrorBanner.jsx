import { ErrorToast } from "../../../components/ui/ErrorToast/ErrorToast.jsx";

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
    <ErrorToast message={status ? `${message} HTTP ${status}` : message} />
  );
}
