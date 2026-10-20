---
'sigillo-app': minor
'sigillo': minor
---

Environments can now have a description. Click the **Description** cell on the project Environments page to view the full text and edit it.

The CLI shows the description when listing and inspecting envs:

```bash
sigillo environments
# project_id: "01J..."
# environments:
#   - id: "01J..."
#     name: "Prod"
#     slug: "prod"
#     description: "Production on Cloudflare. Admins only."
```

`sigillo environments get`, `sigillo projects get`, the `sigillo setup` env picker, and the "available envs" hint also show it. The REST API accepts an optional `description` on `POST` and `PATCH /api/v0/projects/:projectId/environments`. Send `""` to clear it.
