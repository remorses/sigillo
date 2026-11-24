---
'sigillo-app': patch
'sigillo-provider': patch
---

Align the app and sign-in provider on Spiceflow `1.26.0-rsc.22`, matching the current Holocron docs runtime. Keep Holocron Vite `0.39.2` and its CLI `0.23.0`, the latest published releases.

Remove the obsolete `safe-mdx` React DOM peer correction: version `2.1.0` already declares the peer upstream. Deduplicate dependencies to fix the provider's inferred JWT type errors without changing Better Auth versions.
