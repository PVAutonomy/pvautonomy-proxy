/** Return a JSON error response with consistent shape. */
export function jsonError(
  status: number,
  message: string,
  details?: string,
): Response {
  return new Response(
    JSON.stringify({ error: message, ...(details ? { details } : {}), status }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

/** Return a JSON success response. */
export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
