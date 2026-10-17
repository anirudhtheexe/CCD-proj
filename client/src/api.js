export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function createApi(onUnauthorized) {
  return async function api(path, options = {}) {
    const { body, ...rest } = options;
    const headers = new Headers(rest.headers || {});
    let requestBody = body;
    if (body !== undefined && body !== null && typeof body !== "string") {
      headers.set("Content-Type", "application/json");
      requestBody = JSON.stringify(body);
    }
    let response;
    try {
      response = await fetch(path, { ...rest, headers, body: requestBody, credentials: "include" });
    } catch {
      throw new ApiError("Unable to reach the server. Please try again.");
    }
    const text = response.status === 204 ? "" : await response.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = null; }
    }
    if (!response.ok) {
      const error = new ApiError(data?.error || text || `Request failed (${response.status})`, response.status);
      if (response.status === 401) onUnauthorized?.();
      throw error;
    }
    return data;
  };
}

export async function getOwnedRooms(api) {
  const response = await api("/api/rooms");
  return Array.isArray(response?.rooms) ? response.rooms : [];
}
