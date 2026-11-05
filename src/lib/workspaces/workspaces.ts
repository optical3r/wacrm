/** A row of list_my_workspaces() (migration 061). */
export interface WorkspaceRow {
  account_id: string;
  name: string;
  role: "owner" | "admin" | "agent" | "viewer";
  status: "pending" | "active" | "blocked";
  plan: "starter" | "pro";
  organization_id: string | null;
  organization_name: string | null;
  is_active: boolean;
  is_organization_owner: boolean;
  organization_max_workspaces: number;
  organization_workspaces: number;
}

function activeRow(rows: WorkspaceRow[]): WorkspaceRow | undefined {
  return rows.find((r) => r.is_active) ?? rows[0];
}

/** The client's owner may add a workspace while under the limit. */
export function canCreateWorkspace(rows: WorkspaceRow[]): boolean {
  const a = activeRow(rows);
  return !!a && a.is_organization_owner && a.organization_workspaces < a.organization_max_workspaces;
}

/**
 * Shown to whoever is in more than one workspace, and to the client's
 * owner once the client may have more than one.
 */
export function shouldShowSwitcher(rows: WorkspaceRow[]): boolean {
  if (rows.length > 1) return true;
  const a = activeRow(rows);
  return !!a && a.is_organization_owner && a.organization_max_workspaces > 1;
}
