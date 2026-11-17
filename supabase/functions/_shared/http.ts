// Small HTTP helpers shared by the /v1 handlers. Errors follow
// contract/api-v1.md: {"error": "<code>", "detail": "<text>"}.

export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, content-encoding, apikey, x-client-info",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
};

const STATUS: Record<string, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  gone: 410,
  too_large: 413,
  unprocessable: 422,
  rate_limited: 429,
};

export class ApiError extends Error {
  constructor(public code: keyof typeof STATUS | string, public detail = "", public extra: Record<string, unknown> = {}) {
    super(`${code}: ${detail}`);
  }
  get status(): number {
    return STATUS[this.code] ?? 400;
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

export function errorResponse(e: ApiError): Response {
  return json({ error: e.code, detail: e.detail, ...e.extra }, e.status);
}

/** The request body as JSON (an object), or a bad_request error. */
// deno-lint-ignore no-explicit-any
export async function body(req: Request, maxBytes = 65536): Promise<Record<string, any>> {
  const raw = new Uint8Array(await req.arrayBuffer());
  if (raw.length > maxBytes) throw new ApiError("too_large", `body over ${maxBytes} bytes`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw) || "{}");
  } catch {
    throw new ApiError("bad_request", "body is not JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError("bad_request", "body must be a JSON object");
  }
  // deno-lint-ignore no-explicit-any
  return parsed as Record<string, any>;
}

export function need(cond: unknown, detail: string, code = "bad_request"): asserts cond {
  if (!cond) throw new ApiError(code, detail);
}
