---
'sigillo-app': patch
---

Update the Strada SDK to 0.10.0 to send spans, logs, and metrics in one batch request and debounce Cloudflare background flushes. This reduces telemetry ingest requests without changing app configuration.
