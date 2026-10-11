import {
  type GitHubAppCredentials,
  githubApi,
} from "@review/auth/repo-access.js";
import { z } from "zod";

export interface MergeBaseResolver {
  /** The fork point GitHub diffs a PR against, not the base branch's tip. */
  (input: { repo: string; baseSha: string; headSha: string }): Promise<string>;
}

const compareSchema = z.object({
  merge_base_commit: z.object({ sha: z.string().regex(/^[a-f0-9]{40,64}$/i) }),
});

/**
 * Asks GitHub for `merge_base_commit` of base...head. A webhook's
 * `base.sha` is the base branch's tip, and diffing from it would show the
 * base branch's own newer commits as changes the PR reverts.
 */
export function createMergeBaseResolver(input: {
  app: GitHubAppCredentials;
  apiUrl: string;
  fetchImpl?: typeof fetch;
}): MergeBaseResolver {
  const api = githubApi(input.apiUrl, input.fetchImpl ?? fetch);

  return async ({ repo, baseSha, headSha }) => {
    const token = await input.app.installationToken(repo, {
      contents: "read",
    });

    const response = await api.get(
      `/repos/${repo}/compare/${baseSha}...${headSha}`,
      `Bearer ${token}`,
    );

    const parsed = compareSchema.safeParse(response.body);

    if (response.status !== 200 || !parsed.success)
      throw new Error(`Merge base lookup failed (${response.status}).`);

    return parsed.data.merge_base_commit.sha;
  };
}
