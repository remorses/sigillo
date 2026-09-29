---
'sigillo-app': minor
---

New **Sessions** page (user menu → Sessions) that lists every browser and CLI login signed in as you, with its device, IP address and sign-in time. End one you don't recognize, or all but the current one.

An ended session stops working on its next request. The session cookie cache is off for that, so each request checks the session in D1. New sessions record the client IP from `cf-connecting-ip`. CLI logins show as **Sigillo CLI** with their version; ones from older CLIs show as `zig/0.15.2`.
