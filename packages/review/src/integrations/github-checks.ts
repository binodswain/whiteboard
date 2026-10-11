import {
  type GitHubAppCredentials,
  githubApi,
} from "@review/auth/repo-access.js";

const CHECK_NAME = "Whiteboard review";

export type CheckOutput = {
  title: string;
  summary: string;
};

export interface CheckRunsClient {
  /** Creates the check for an immutable head SHA; resolves with its id. */
  create(input: {
    repo: string;
    headSha: string;
    status: "queued" | "in_progress";
    output: CheckOutput;
    detailsUrl?: string;
  }): Promise<string>;
  update(input: {
    repo: string;
    checkRunId: string;
    status?: "in_progress";
    conclusion?: "neutral" | "failure";
    output: CheckOutput;
    detailsUrl?: string;
  }): Promise<void>;
}

/**
 * Check Runs published as the GitHub App. Every call mints an installation
 * token narrowed to `checks: write` on the one repository, so nothing else
 * the App can do rides along with a check update. Failures carry only the
 * HTTP status: response bodies are never echoed.
 */
export function createCheckRunsClient(input: {
  app: GitHubAppCredentials;
  apiUrl: string;
  fetchImpl?: typeof fetch;
}): CheckRunsClient {
  const api = githubApi(input.apiUrl, input.fetchImpl ?? fetch);

  const authorization = async (repo: string) =>
    `Bearer ${await input.app.installationToken(repo, { checks: "write" })}`;

  return {
    async create({ repo, headSha, status, output, detailsUrl }) {
      const response = await api.post(
        `/repos/${repo}/check-runs`,
        await authorization(repo),
        {
          name: CHECK_NAME,
          head_sha: headSha,
          status,
          output,
          ...(detailsUrl && { details_url: detailsUrl }),
        },
      );

      // SAFETY: a 201 body is the documented check run object.
      const id = (response.body as { id?: number | string } | undefined)?.id;

      if (response.status !== 201 || id === undefined)
        throw new Error(`Check run creation failed (${response.status}).`);

      return String(id);
    },
    async update({ repo, checkRunId, status, conclusion, output, detailsUrl }) {
      const response = await api.patch(
        `/repos/${repo}/check-runs/${encodeURIComponent(checkRunId)}`,
        await authorization(repo),
        {
          ...(status && { status }),
          ...(conclusion && {
            status: "completed",
            conclusion,
            completed_at: new Date().toISOString(),
          }),
          output,
          ...(detailsUrl && { details_url: detailsUrl }),
        },
      );

      if (response.status !== 200)
        throw new Error(`Check run update failed (${response.status}).`);
    },
  };
}
