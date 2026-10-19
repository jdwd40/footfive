/**
 * Request bodies and client-safe errors for protected routes (review B18/D1).
 *
 * readBody: the one way a route reads its JSON object body.
 * fail: the one way a route's catch turns an error into its HTTP response.
 */
var logger;
try {
  logger = require(__hooks + "/lib/logger.js");
} catch (e) {
  logger = require("./logger.js");
}

/**
 * The request body as an object; an empty or missing body is {}. A body
 * PocketBase cannot parse, and JSON null, arrays or other non-objects, are
 * rejected rather than becoming {} and running a route's defaults.
 * Inherited limit: PocketBase keeps the first JSON value and ignores anything
 * after it, so `{"a":1} trailing` still reads as {"a":1}.
 */
function readBody(e) {
  var body;
  try {
    body = e.requestInfo().body;
  } catch (_) {
    throw new BadRequestError("Invalid request body");
  }
  if (body === undefined) return {};
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new BadRequestError("Invalid request body");
  }
  return body;
}

/** Deliberate API errors carry a numeric HTTP status and a public message. */
function isApiError(err) {
  return !!err && typeof err.status === "number" && typeof err.message === "string";
}

/** Bounded diagnostic kind; never the error's own text. */
function errorKind(err) {
  if (err && err.name === "GoError") {
    return String(err.message).indexOf("no rows in result set") >= 0 ? "go_no_rows" : "go";
  }
  if (err instanceof Error) return "js";
  return "other";
}

/**
 * The error a route's catch should throw. A deliberate API error keeps its
 * message but takes the route's status (opts.status 400, the default, or 404),
 * as the old catches did. Anything else is internal: it is logged as a fixed
 * event with the static route and kind only, and the client gets the route's
 * fixed opts.fallback — or opts.notFound, when the route has proved that only
 * its own target lookup can fail with no rows.
 */
function fail(err, opts) {
  var message;
  if (isApiError(err)) {
    message = err.message;
  } else {
    var kind = errorKind(err);
    try {
      logger.error("route_error", { route: opts.route, kind: kind });
    } catch (_) {}
    message = kind === "go_no_rows" && opts.notFound ? opts.notFound : opts.fallback;
  }
  return opts.status === 404 ? new NotFoundError(message) : new BadRequestError(message);
}

if (typeof module !== "undefined") {
  module.exports = {
    readBody: readBody,
    fail: fail,
    isApiError: isApiError,
    errorKind: errorKind,
  };
}
