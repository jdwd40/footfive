#!/usr/bin/env node
/**
 * FootFive app-health gate validator.
 *
 * Reads an /api/footfive/health JSON body from stdin and exits 0 only when it
 * is parseable JSON with status === "ok" and worldAvailable === true. Empty,
 * malformed, degraded, or missing-world bodies exit 1, so CI health gates fail
 * closed instead of passing on a degraded deploy.
 *
 * Runs on the CI runner (Node available); the VPS only needs curl — the remote
 * body is captured and piped into this script locally.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function validateAppHealth(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, reason: "empty health body" };
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, reason: "malformed JSON" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, reason: "health body is not a JSON object" };
  }
  if (body.status !== "ok") {
    return { ok: false, reason: `status=${JSON.stringify(body.status)} (expected "ok")` };
  }
  if (body.worldAvailable !== true) {
    return {
      ok: false,
      reason: `worldAvailable=${JSON.stringify(body.worldAvailable)} (expected true)`,
    };
  }
  return { ok: true, reason: "status=ok worldAvailable=true" };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const result = validateAppHealth(readFileSync(0, "utf8"));
  if (!result.ok) {
    console.error(`app health gate FAILED: ${result.reason}`);
    process.exit(1);
  }
  console.log(`app health gate passed: ${result.reason}`);
}
