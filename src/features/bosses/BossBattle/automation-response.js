export async function readAutomationResponse(response) {
  try {
    return await response.json();
  } catch {
    const error = new Error(
      "Сервис боя временно недоступен. Попробуйте позже.",
    );
    error.status = response.status;
    throw error;
  }
}
