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
      WHITEBOARD_REPO_SOURCE: "github",
      WHITEBOARD_JOBS: "queue",
      WHITEBOARD_AUTH: "oauth",
    });

    expect(config).toMatchObject({
      db: "postgres",
      blobs: "s3",
      s3: { bucket: "reviews" },
    });
    expect(JSON.stringify(publicDeploymentConfig(config))).not.toMatch(
      /password|private|access/,
    );
  });

  it.each([
    [{ WHITEBOARD_MODE: "remote" }, "WHITEBOARD_DB"],
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
      WHITEBOARD_MODE: "remote",
      WHITEBOARD_DB: "sqlite",
      WHITEBOARD_BLOBS: "fs",
    },
    {
      WHITEBOARD_MODE: "remote",
      WHITEBOARD_DB: "postgres://db",
      WHITEBOARD_BLOBS: "s3://bucket",
      WHITEBOARD_S3_REGION: "r",
      WHITEBOARD_S3_KEY: "k",
    },
    { WHITEBOARD_MODE: "local", WHITEBOARD_BLOBS: "s3://bucket" },
    { WHITEBOARD_MODE: "local", WHITEBOARD_DB: "mysql://db" },
  ])("rejects invalid combinations", (env) => {
    expect(() => loadDeploymentConfig(env)).toThrow(/.+/);
  });
});
