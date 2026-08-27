const BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3000";

/**
 * The two-hop wrapper shape: the path literal is at the CALLER, the single
 * fetch() is here. `wrapsFetch` today looks only in the caller's own body, so
 * every function below records nothing.
 */
async function apiFetch<T>(path: string, options?: { method?: string; body?: unknown }): Promise<T> {
  const method = options?.method ?? "GET";
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    ...(options?.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  if (!res.ok) throw new Error(`api_error ${res.status}`);
  return (await res.json()) as T;
}

export async function listItems(): Promise<{ items: { id: string; name: string }[] }> {
  return apiFetch<{ items: { id: string; name: string }[] }>("/api/items");
}

export async function login(input: { email: string; password: string }): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>("/api/auth/login", { method: "POST", body: input });
}
