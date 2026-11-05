import { describe, expect, it } from "vitest";
import { canCreateWorkspace, shouldShowSwitcher, type WorkspaceRow } from "./workspaces";

const row = (over: Partial<WorkspaceRow> = {}): WorkspaceRow => ({
  account_id: "a1",
  name: "Suporte",
  role: "owner",
  status: "active",
  plan: "starter",
  organization_id: "o1",
  organization_name: "Optical",
  is_active: true,
  is_organization_owner: true,
  organization_max_workspaces: 1,
  organization_workspaces: 1,
  ...over,
});

describe("workspace switcher rules", () => {
  it("hides for a single workspace with no room for more", () => {
    expect(shouldShowSwitcher([row()])).toBe(false);
    expect(canCreateWorkspace([row()])).toBe(false);
  });

  it("shows for the owner once the client may have more", () => {
    const rows = [row({ organization_max_workspaces: 3 })];
    expect(shouldShowSwitcher(rows)).toBe(true);
    expect(canCreateWorkspace(rows)).toBe(true);
  });

  it("shows for anyone in two workspaces, but only the owner creates", () => {
    const rows = [
      row({ is_organization_owner: false, role: "agent" }),
      row({ account_id: "a2", name: "Vendas", is_active: false, is_organization_owner: false, role: "agent" }),
    ];
    expect(shouldShowSwitcher(rows)).toBe(true);
    expect(canCreateWorkspace(rows)).toBe(false);
  });

  it("stops creating at the limit", () => {
    const rows = [row({ organization_max_workspaces: 2, organization_workspaces: 2 })];
    expect(canCreateWorkspace(rows)).toBe(false);
  });
});
