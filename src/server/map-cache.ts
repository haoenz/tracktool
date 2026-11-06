import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

/** Only call after resource/version validation and session authorization. */
export function sendCachedMapResource(
  request: FastifyRequest,
  reply: FastifyReply,
  bytes: Buffer,
  immutable = false,
) {
  const etag = `W/"${createHash("sha256").update(bytes).digest("hex")}"`;
  reply.header(
    "Cache-Control",
    immutable
      ? "private, max-age=31536000, immutable"
      : "private, max-age=86400",
  );
  // Include the session even for unauthenticated map resources, and preserve
  // compression's Vary header so cached API tiles cannot cross sessions.
  const vary = String(reply.getHeader("Vary") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  reply.header("Vary", [...new Set([...vary, "X-Tracktool-Token"])].join(", "));
  reply.header("ETag", etag);
  const matches = request.headers["if-none-match"]?.split(",").some((value) => {
    const candidate = value.trim();
    return candidate === "*" || candidate.replace(/^W\//, "") === etag.slice(2);
  });
  return matches ? reply.code(304).send() : reply.send(bytes);
}
