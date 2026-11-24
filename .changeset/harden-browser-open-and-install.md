---
'sigillo': patch
'sigillo-app': patch
---

Security hardening for login and install.

- `sigillo login` now opens the browser only for plain `http(s)` verification URLs with no shell metacharacters. On Windows the URL went through `cmd.exe /C start`, so a malicious `--api-url` server could run commands by putting `&` in it. The URL is still printed for manual opening.
- The `curl | bash` installer now extracts into a private `mktemp -d` directory instead of a fixed `sigillotmp_<pid>` folder in the current directory.
- The auth provider no longer auto-accepts consent for custom-scheme redirect URIs such as `myapp://sigillo.dev/cb`, which only looked like the first-party host.
