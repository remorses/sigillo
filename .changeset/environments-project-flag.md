---
'sigillo': patch
---

`sigillo environments get`, `rename` and `delete` now accept `-p, --project`. Before, they only worked from a directory linked with `sigillo setup`, even when you passed a full env ID.

```bash
sigillo environments delete dev -p 01M4GY7B0C5A91MV9C2VMZQ00E
sigillo environments rename dev -p <PROJECT_ID> --name Development
```
