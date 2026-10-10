---
'sigillo': patch
---

Clarify in `sigillo run --help` and the Sigillo agent skill that output redaction also applies to pipes. Passing a secret through `sigillo run` output can send literal asterisks to the receiving tool instead of the real value.

Use a direct secret pipe when a tool needs the value on stdin:

```bash
sigillo secrets get ICLOUD_PASS -c dev --raw | some-tool --stdin
```

For tools that read secrets from environment variables, use `sigillo run -- tool` instead.
