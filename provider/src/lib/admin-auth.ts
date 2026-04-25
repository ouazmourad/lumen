// HTTP Basic auth for admin / stats endpoints.
//
//   credentials: env vars LUMEN_ADMIN_USER + LUMEN_ADMIN_PASS
//   if either is unset, the endpoint is *closed* (returns 401).

import { errorResponse } from "./errors";

export function requireAdmin(req: Request, request_id: string): Response | null {
  const user = process.env.LUMEN_ADMIN_USER;
  const pass = process.env.LUMEN_ADMIN_PASS;
  if (!user || !pass) {
    return errorResponse("unauthorized", "admin disabled (set LUMEN_ADMIN_USER / LUMEN_ADMIN_PASS)", 401, request_id, {
      "www-authenticate": 'Basic realm="lumen-admin"',
    });
  }
  const h = req.headers.get("authorization") ?? "";
  if (!h.toLowerCase().startsWith("basic ")) {
    return errorResponse("unauthorized", "admin requires HTTP Basic", 401, request_id, {
      "www-authenticate": 'Basic realm="lumen-admin"',
    });
  }
  let decoded = "";
  try { decoded = Buffer.from(h.slice(6).trim(), "base64").toString(); } catch { /* fall through */ }
  const i = decoded.indexOf(":");
  if (i < 0) {
    return errorResponse("unauthorized", "malformed Basic credentials", 401, request_id);
  }
  const u = decoded.slice(0, i);
  const p = decoded.slice(i + 1);
  if (u !== user || p !== pass) {
    return errorResponse("unauthorized", "invalid admin credentials", 401, request_id);
  }
  return null;
}
