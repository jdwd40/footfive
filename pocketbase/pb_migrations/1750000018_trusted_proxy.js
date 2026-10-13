/// <reference path="../pb_data/types.d.ts" />
/**
 * Rate limits (1750000015) are keyed by client IP. Behind nginx every request comes
 * from 127.0.0.1, so without a trusted-proxy header all players share one bucket and
 * a busy round trips 429 for everyone. nginx sets `X-Real-IP $remote_addr`
 * (deploy/nginx.example.conf), which is a single, proxy-overwritten value: trust it.
 * useLeftmostIP only matters for X-Forwarded-For style lists; keep PB's default (false).
 * Idempotent: only adds the header when missing, keeps any operator-set headers.
 */
migrate(
  (app) => {
    var settings = app.settings();
    var headers = (settings.trustedProxy.headers || []).slice();
    if (headers.indexOf("X-Real-IP") === -1) headers.push("X-Real-IP");
    settings.trustedProxy.headers = headers;
    app.save(settings);
  },
  (app) => {
    var settings = app.settings();
    settings.trustedProxy.headers = (settings.trustedProxy.headers || []).filter(function (h) {
      return h !== "X-Real-IP";
    });
    app.save(settings);
  },
);
