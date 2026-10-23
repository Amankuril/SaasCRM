export const ROLES = ['owner', 'admin', 'manager', 'agent', 'analyst'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Server-side source of truth for what each workspace role may do.
 * Add a permission here before checking it in a route.
 */
const PERMISSIONS = {
  'workspace:read': ['owner', 'admin', 'manager', 'agent', 'analyst'],
  'workspace:update': ['owner', 'admin'],
  'members:read': ['owner', 'admin', 'manager'],
  'members:manage': ['owner', 'admin'],
  'billing:manage': ['owner'],
  'provider:manage': ['owner'],
  'templates:manage': ['owner', 'admin'],
  'messages:send': ['owner', 'admin', 'manager', 'agent'],
  'audit:read': ['owner', 'admin'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}

export function permissionsFor(role: Role): Permission[] {
  return (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(role, p));
}

/** Only owners may grant or revoke the owner role. */
export function canAssignRole(actor: Role, target: Role): boolean {
  if (target === 'owner') return actor === 'owner';
  return can(actor, 'members:manage');
}
