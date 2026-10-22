// A thin fetch wrapper for /api. The register never calls this directly; the
// sync engine and the back office do (docs/decisions/0001).

/** The server answered with an error. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The server couldn't be reached (offline, DNS, timeout, proxy down). */
export class NetworkError extends Error {
  constructor(message = "can't reach the server") {
    super(message);
    this.name = 'NetworkError';
  }
}

export interface Credentials {
  /** Device token from enrollment. */
  token?: string;
  /** Back-office session token. */
  session?: string;
}

export interface RequestOptions {
  body?: unknown;
  auth?: Credentials;
  timeoutMs?: number;
}

export async function api<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.auth?.token) headers.Authorization = `Bearer ${opts.auth.token}`;
  if (opts.auth?.session) headers['X-Session'] = opts.auth.session;

  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
  } catch (e) {
    throw new NetworkError(e instanceof Error && e.name === 'TimeoutError' ? 'the server took too long to answer' : undefined);
  }

  const text = res.status === 204 ? '' : await res.text();
  let data: unknown;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined; // e.g. an HTML error page from a proxy
    }
  }
  if (!res.ok) {
    const body = (data ?? {}) as { code?: string; message?: string; details?: unknown };
    // A gateway error means the server itself is unreachable.
    if (!body.code && [502, 503, 504].includes(res.status)) throw new NetworkError();
    throw new ApiError(res.status, body.code ?? `http_${res.status}`, body.message ?? res.statusText, body.details);
  }
  return data as T;
}

/** A message for people, whatever was thrown. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError || e instanceof NetworkError) return e.message.charAt(0).toUpperCase() + e.message.slice(1);
  if (e instanceof Error) return e.message;
  return String(e);
}
