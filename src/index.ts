import type { Env } from "./types.js";
import { route } from "./router.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (err) {
      console.error("Unhandled error:", (err as Error).message);
      return new Response(
        JSON.stringify({ error: "Internal server error", status: 500 }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
  },
} satisfies ExportedHandler<Env>;
