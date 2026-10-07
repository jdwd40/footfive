/// <reference path="../pb_data/types.d.ts" />
/**
 * Issue #14 (review B10): enable PocketBase's native rate limiter.
 * Ships enabled:false in 0.28.4; rules below throttle credential stuffing on both
 * the native auth endpoint and the custom username-login route, plus PB's default
 * catch-all API budget.
 */
migrate(
  (app) => {
    var settings = app.settings();
    settings.rateLimits.enabled = true;
    settings.rateLimits.rules = [
      { label: "*:auth", audience: "", duration: 60, maxRequests: 120 },
      { label: "/api/footfive/auth/login", audience: "", duration: 60, maxRequests: 120 },
      { label: "/api/", audience: "", duration: 10, maxRequests: 300 },
    ];
    app.save(settings);
  },
  (app) => {
    var settings = app.settings();
    settings.rateLimits.enabled = false;
    settings.rateLimits.rules = [
      { label: "*:auth", audience: "", duration: 3, maxRequests: 2 },
      { label: "*:create", audience: "", duration: 5, maxRequests: 20 },
      { label: "/api/batch", audience: "", duration: 1, maxRequests: 3 },
      { label: "/api/", audience: "", duration: 10, maxRequests: 300 },
    ];
    app.save(settings);
  },
);
