// Single error envelope for every non-2xx response.
//
//   {
//     "error": "<machine code>",
//     "message": "<human readable>",
//     "request_id": "req_xxx",
//     "docs": "https://…"
//   }

export type ErrorCode =
  | "payment_required"
  | "unauthorized"
  | "already_consumed"
  | "bad_request"
  | "not_found"
  | "rate_limited"
  | "upstream_unavailable"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  payment_required: 402,
  unauthorized: 401,
  already_consumed: 409,
  bad_request: 400,
  not_found: 404,
  rate_limited: 429,
  upstream_unavailable: 503,
  internal: 500,
};

const DOCS = "https://github.com/ouazmourad/lumen#errors";

export function errorResponse(
  code: ErrorCode,
  message: string,
  statusOverride?: number,
  request_id: string = "",
  extraHeaders: Record<string, string> = {},
): Response {
  const status = statusOverride ?? STATUS[code];
  return new Response(
    JSON.stringify({ error: code, message, request_id, docs: DOCS }),
    {
      status,
      headers: {
        "content-type": "application/json",
        "x-request-id": request_id,
        ...extraHeaders,
      },
    },
  );
}

export function newRequestId(): string {
  return "req_" + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
}
