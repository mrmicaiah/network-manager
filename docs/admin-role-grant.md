# Granting Admin Roles via D1 CLI

The RBAC system is seeded with three roles: `user`, `admin`, and `superadmin`. Regular users don't need a role assignment — they access their own data through the standard auth flow. Admin and superadmin roles must be explicitly granted.

## Prerequisites

- Wrangler CLI installed and authenticated
- Migrations `0010_rbac_tables.sql` and `0011_rbac_seed_data.sql` applied

## Find the User's ID

Look up a user by phone number or email:

```bash
wrangler d1 execute network-manager-db --remote \
  --command "SELECT id, name, email, phone FROM users WHERE phone = '+1XXXXXXXXXX';"
```

Or by email:

```bash
wrangler d1 execute network-manager-db --remote \
  --command "SELECT id, name, email, phone FROM users WHERE email = 'user@example.com';"
```

## Grant Admin Role

```bash
wrangler d1 execute network-manager-db --remote \
  --command "INSERT INTO user_roles (user_id, role_id, granted_at, granted_by) VALUES ('<USER_ID>', 'role-admin-0000000-0000-0000-0002', datetime('now'), NULL);"
```

## Grant Superadmin Role

```bash
wrangler d1 execute network-manager-db --remote \
  --command "INSERT INTO user_roles (user_id, role_id, granted_at, granted_by) VALUES ('<USER_ID>', 'role-superadmin-000-0000-0000-0003', datetime('now'), NULL);"
```

## Verify Role Assignment

```bash
wrangler d1 execute network-manager-db --remote \
  --command "SELECT u.name, u.email, r.name as role FROM user_roles ur JOIN users u ON ur.user_id = u.id JOIN roles r ON ur.role_id = r.id WHERE ur.user_id = '<USER_ID>';"
```

## Revoke a Role

```bash
wrangler d1 execute network-manager-db --remote \
  --command "DELETE FROM user_roles WHERE user_id = '<USER_ID>' AND role_id = 'role-admin-0000000-0000-0000-0002';"
```

## Quick Reference: Role IDs

| Role | ID |
|------|----|
| user | `role-user-00000000-0000-0000-0001` |
| admin | `role-admin-0000000-0000-0000-0002` |
| superadmin | `role-superadmin-000-0000-0000-0003` |

## Notes

- `granted_by` is NULL for CLI-granted roles (no acting user). When the admin dashboard grants roles, this will be set to the granting admin's user ID.
- A user can have multiple roles. Permissions are additive (union of all role permissions).
- The `user` role has no entries in `role_permissions` — regular users don't go through RBAC. Only `admin` and `superadmin` roles have permission mappings.
