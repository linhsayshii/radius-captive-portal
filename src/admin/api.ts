export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
  });
  const payload = await response.json().catch(() => null) as { error?: string } | T | null;

  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload
      ? payload.error || "Không thể hoàn tất yêu cầu."
      : "Không thể hoàn tất yêu cầu.";
    throw new ApiError(message, response.status);
  }

  return payload as T;
}
