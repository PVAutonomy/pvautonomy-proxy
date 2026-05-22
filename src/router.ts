import type { Env } from "./types.js";
import { jsonError } from "./errors.js";
import { authenticateRequest } from "./auth/api-key.js";
import { handleBuildCreate } from "./handlers/build-create.js";
import { handleBuildStatus } from "./handlers/build-status.js";
import { handleBuildArtifact } from "./handlers/build-artifact.js";
import { handleHealth } from "./handlers/health.js";

/** Simple path-based router. */
export async function route(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method;
  const path = url.pathname;

  // CORS preflight
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  let response: Response;

  // GET /health — public
  if (method === "GET" && path === "/health") {
    response = await handleHealth(env);
    return addCors(response);
  }

  // All other endpoints require auth
  const auth = await authenticateRequest(request, env);
  if ("error" in auth) {
    return addCors(jsonError(auth.status, auth.error));
  }

  // POST /build
  if (method === "POST" && path === "/build") {
    response = await handleBuildCreate(request, env, auth.customer);
    return addCors(response);
  }

  // GET /build/:id/artifact/:name
  const artifactMatch = path.match(
    /^\/build\/([0-9a-f-]{36})\/artifact\/([A-Za-z0-9._-]+)$/,
  );
  if (method === "GET" && artifactMatch) {
    response = await handleBuildArtifact(env, artifactMatch[1], artifactMatch[2]);
    return addCors(response);
  }

  // GET /build/:id
  const buildMatch = path.match(/^\/build\/([0-9a-f-]{36})$/);
  if (method === "GET" && buildMatch) {
    response = await handleBuildStatus(env, buildMatch[1]);
    return addCors(response);
  }

  return addCors(jsonError(404, `Not found: ${method} ${path}`));
}

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function addCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
