---
'sigillo-app': minor
---

The project **Settings** page can now rename and delete the current project, not only the organization.

- **Project name** card: edit the name and press **Save**.
- **Danger Zone** has a new **Delete project** row. The confirm dialog lists the environments that will be deleted, together with their secrets, event history and API tokens.

Deleting a project follows the same rules as `DELETE /api/v0/projects/:id`: members need access to the project, and a project with admin-only environments can only be deleted by an admin.
