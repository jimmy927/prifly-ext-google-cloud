/**
 * The projects the account can see, from Cloud Resource Manager v3
 * `projects:search` — shared by the `gcloud_projects` tool, the board's
 * "show this project" rows and the panel's project list.
 */

import type { ExtensionConnectionsApi } from "@prifly/extension-api";
import { allPages, gfetch, type Result } from "./google";

export type Project = {
  /** The id every other API takes: `shop-prod`. */
  id: string;
  /** The display name: "Shop (prod)". */
  name: string;
  /** `ACTIVE`, `DELETE_REQUESTED`, ... */
  state: string;
  /** `organizations/123`, `folders/456`, or "". */
  parent: string;
};

type SearchPage = {
  projects?: { projectId?: string; displayName?: string; state?: string; parent?: string }[];
  nextPageToken?: string;
};

const SEARCH = "https://cloudresourcemanager.googleapis.com/v3/projects:search";

export async function listProjects(
  connections: ExtensionConnectionsApi,
  connection: string,
): Promise<Result<Project[]>> {
  const answer = await allPages(
    (token) => {
      const url = new URL(SEARCH);
      url.searchParams.set("pageSize", "500");
      if (token !== undefined) url.searchParams.set("pageToken", token);
      return gfetch<SearchPage>(connections, connection, url.toString());
    },
    (page: SearchPage) => page.projects,
  );
  if (!("ok" in answer)) return answer;
  return {
    ok: answer.ok
      .filter((each) => typeof each.projectId === "string" && each.projectId !== "")
      .map((each) => ({
        id: each.projectId ?? "",
        name: each.displayName ?? each.projectId ?? "",
        state: each.state ?? "",
        parent: each.parent ?? "",
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}
