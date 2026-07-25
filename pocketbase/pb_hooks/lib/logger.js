/**
 * Structured operational logs for FootFive (PocketBase JSVM).
 * Never log passwords, tokens, or full sensitive bodies.
 */
function nowIso() {
  return new Date().toISOString();
}

function scrub(obj) {
  if (!obj || typeof obj !== "object") return obj;
  var out = {};
  var keys = Object.keys(obj);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var kl = k.toLowerCase();
    if (
      kl.indexOf("password") >= 0 ||
      kl.indexOf("token") >= 0 ||
      kl === "authorization" ||
      kl.indexOf("secret") >= 0
    ) {
      out[k] = "[redacted]";
    } else {
      out[k] = obj[k];
    }
  }
  return out;
}

/**
 * @param {string} level info|warn|error
 * @param {string} event
 * @param {object} [fields]
 */
function log(level, event, fields) {
  var entry = {
    ts: nowIso(),
    level: level || "info",
    event: event,
    app: "footfive",
  };
  if (fields) {
    var clean = scrub(fields);
    var ks = Object.keys(clean);
    for (var i = 0; i < ks.length; i++) {
      entry[ks[i]] = clean[ks[i]];
    }
  }
  try {
    console.log("[footfive-json] " + JSON.stringify(entry));
  } catch (_) {
    console.log("[footfive] " + level + " " + event);
  }
}

function info(event, fields) {
  log("info", event, fields);
}
function warn(event, fields) {
  log("warn", event, fields);
}
function error(event, fields) {
  log("error", event, fields);
}

if (typeof module !== "undefined") {
  module.exports = {
    log: log,
    info: info,
    warn: warn,
    error: error,
    scrub: scrub,
  };
}
