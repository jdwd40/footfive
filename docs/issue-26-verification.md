# Production assets and catch-up feedback (#26)

Verified against the current implementation on 19 October 2026. The original findings are already addressed; this change adds regression coverage and preserves runtime behavior.

Team labels use kit swatches and abbreviation pills. There is no remaining badge-image component or root-relative badge-image URL in the client. The existing SVG assets are retained. A read-only request to `https://jdwd40.com/footfive/assets/badges/doge_city.svg` returned HTTP 200 and `image/svg+xml`; a browser check under the production `/footfive/` base loaded the same relative asset successfully at mobile and desktop sizes. The regression checks the response body as well as its status, so an HTML fallback cannot masquerade as an SVG.

The existing Catch up button calls `POST /api/footfive/admin/world/catch-up` through the API client. Its action wrapper displays a failed request, leaves the success message absent, and allows a subsequent successful request to clear the error and show the existing confirmation. LivePage has no public catch-up action. Browser regressions exercise the real page and API client with synthetic authentication and mocked responses; they do not mutate a production world or substitute for server authorization tests.

The same browser spec runs under the CI root base and a local `/footfive/` base. No badge images are reintroduced, and the original pitch presentation is preserved. Engine, timing, rate-limit, polling, auth and admin runtime code are unchanged. Obsolete public catch-up callers in manual test scripts belong to the separate test-script repair in #31.
