import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  loadDeploymentConfig,
  publicDeploymentConfig,
} from "./deployment-config.js";

describe("loadDeploymentConfig", () => {
  it("defaults to local drivers", () => {
    expect(loadDeploymentConfig({})).toEqual({
      mode: "local",
      db: "sqlite",
      blobs: "fs",
      repoSource: "local",
      jobs: "inline",
      auth: "local-token",
    });
  });

  it("resolves every local override", () => {
    expect(
      loadDeploymentConfig({
        WHITEBOARD_MODE: "local",
        WHITEBOARD_DB: "sqlite",
        WHITEBOARD_BLOBS: "fs",
        WHITEBOARD_REPO_SOURCE: "github",
        WHITEBOARD_JOBS: "queue",
        WHITEBOARD_AUTH: "oauth",
        WHITEBOARD_AUTH_SECRET: "session-secret",
        GITHUB_OAUTH_CLIENT_ID: "client-id",
        GITHUB_OAUTH_CLIENT_SECRET: "client-secret",
      }),
    ).toMatchObject({ repoSource: "github", jobs: "queue", auth: "oauth" });
  });

  it("resolves remote drivers and redacts credentials in public config", () => {
    const config = loadDeploymentConfig({
      WHITEBOARD_MODE: "remote",
      WHITEBOARD_DB: "postgres://user:password@db/reviews",
      WHITEBOARD_BLOBS: "s3://reviews",
      WHITEBOARD_S3_ENDPOINT: "https://s3.example",
      WHITEBOARD_S3_REGION: "auto",
      WHITEBOARD_S3_KEY: "access",
      WHITEBOARD_S3_SECRET: "private",
      WHITEBOARD_AUTH_SECRET: "session-secret",
      GITHUB_OAUTH_CLIENT_ID: "client-id",
      GITHUB_OAUTH_CLIENT_SECRET: "client-secret",
    });

    expect(config).toMatchObject({
      mode: "remote",
      db: "postgres",
      blobs: "s3",
      s3: { bucket: "reviews" },
      repoSource: "github",
      jobs: "queue",
      auth: "oauth",
    });
    expect(JSON.stringify(publicDeploymentConfig(config))).not.toMatch(
      /password|private|access/,
    );
  });

  it("resolves a libsql URL and token for remote mode", () => {
    const config = loadDeploymentConfig({
      WHITEBOARD_MODE: "remote",
      WHITEBOARD_DB: "libsql://reviews-org.turso.io",
      WHITEBOARD_DB_TOKEN: "auth-token",
      WHITEBOARD_BLOBS: "s3://reviews",
      WHITEBOARD_S3_REGION: "auto",
      WHITEBOARD_S3_KEY: "access",
      WHITEBOARD_S3_SECRET: "private",
      WHITEBOARD_AUTH_SECRET: "session-secret",
      GITHUB_OAUTH_CLIENT_ID: "client-id",
      GITHUB_OAUTH_CLIENT_SECRET: "client-secret",
    });

    expect(config).toMatchObject({
      mode: "remote",
      db: "libsql",
      libsql: { url: "libsql://reviews-org.turso.io", authToken: "auth-token" },
    });
    expect(JSON.stringify(publicDeploymentConfig(config))).not.toMatch(
      /auth-token/,
    );
  });

  it("honors driver overrides in remote mode", () => {
    expect(
      loadDeploymentConfig({
        WHITEBOARD_MODE: "remote",
        WHITEBOARD_DB: "sqlite",
        WHITEBOARD_BLOBS: "fs",
        WHITEBOARD_REPO_SOURCE: "local",
        WHITEBOARD_JOBS: "inline",
        WHITEBOARD_AUTH: "local-token",
      }),
    ).toEqual({
      mode: "remote",
      db: "sqlite",
      blobs: "fs",
      repoSource: "local",
      jobs: "inline",
      auth: "local-token",
    });
  });

  it.each([
    [{ WHITEBOARD_MODE: "remote" }, "WHITEBOARD_DB"],
    [
      { WHITEBOARD_MODE: "remote", WHITEBOARD_DB: "postgres://db" },
      "WHITEBOARD_BLOBS",
    ],
    [
      {
        WHITEBOARD_MODE: "remote",
        WHITEBOARD_DB: "postgres://db",
        WHITEBOARD_BLOBS: "s3://bucket",
      },
      "WHITEBOARD_S3_REGION",
    ],
  ] as const)("names missing remote settings", (env, setting) => {
    expect(() => loadDeploymentConfig(env)).toThrow(setting);
  });

  it.each([
    {
      WHITEBOARD_MODE: "local",
      WHITEBOARD_BLOBS: "s3://bucket",
    },
    { WHITEBOARD_MODE: "local", WHITEBOARD_DB: "mysql://db" },
  ])("rejects invalid combinations", (env) => {
    expect(() => loadDeploymentConfig(env)).toThrow(/.+/);
  });

  describe("PR reviews", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

    const base = {
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString(),
      WHITEBOARD_GITHUB_WEBHOOK_SECRET: "hook-secret",
      WHITEBOARD_PR_REVIEW_REPOS: "Octo/Repo, octo/other",
      WHITEBOARD_JOBS: "queue",
    };

    it("stays off without a webhook secret, whatever else is set", () => {
      expect(
        loadDeploymentConfig({
          ...base,
          WHITEBOARD_GITHUB_WEBHOOK_SECRET: undefined,
        }).prReviews,
      ).toBeUndefined();
    });

    it("opts in the listed repositories and skips drafts by default", () => {
      expect(loadDeploymentConfig(base).prReviews).toEqual({
        webhookSecret: "hook-secret",
        repos: ["octo/repo", "octo/other"],
        drafts: false,
      });
      expect(
        loadDeploymentConfig({ ...base, WHITEBOARD_PR_REVIEW_DRAFTS: "true" })
          .prReviews?.drafts,
      ).toBe(true);
    });

    it.each([
      [{ GITHUB_APP_ID: undefined, GITHUB_APP_PRIVATE_KEY: undefined }],
      [{ WHITEBOARD_PR_REVIEW_REPOS: undefined }],
      [{ WHITEBOARD_PR_REVIEW_REPOS: "not-a-slug" }],
      [{ WHITEBOARD_JOBS: "inline" }],
    ])("refuses a webhook it could not serve safely", (override) => {
      expect(() => loadDeploymentConfig({ ...base, ...override })).toThrow(
        /.+/,
      );
    });
  });
});
