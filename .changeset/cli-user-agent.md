---
'sigillo': patch
---

The CLI now sends `User-Agent: sigillo-cli/<version>` instead of Zig's default `zig/<version>`, so the server can tell it apart from other clients.
