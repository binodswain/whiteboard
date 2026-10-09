import { createPrivateKey } from "node:crypto";

import { z } from "zod";

const optionalEnv = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().optional(),
);

const envSchema = z.object({
  WHITEBOARD_MODE: z.enum(["local", "remote"]).default("local"),
  WHITEBOARD_DB: optionalEnv,
  WHITEBOARD_BLOBS: optionalEnv,
  WHITEBOARD_S3_ENDPOINT: optionalEnv,
  WHITEBOARD_S3_REGION: optionalEnv,
  WHITEBOARD_S3_KEY: optionalEnv,
  WHITEBOARD_S3_SECRET: optionalEnv,
  WHITEBOARD_REPO_SOURCE: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(["local", "github"]).optional(),
  ),
  WHITEBOARD_JOBS: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(["inline", "queue"]).optional(),
  ),
  WHITEBOARD_AUTH: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(["local-token", "oauth"]).optional(),
  ),
  WHITEBOARD_AUTH_SECRET: optionalEnv,
  GITHUB_OAUTH_CLIENT_ID: optionalEnv,
  GITHUB_OAUTH_CLIENT_SECRET: optionalEnv,
  WHITEBOARD_AUTH_PROXY_HEADER: optionalEnv,
  WHITEBOARD_AUTH_PROXY_SECRET: optionalEnv,
  WHITEBOARD_AUTH_PROXY_SECRET_HEADER: optionalEnv,
  GITHUB_APP_ID: optionalEnv,
  GITHUB_APP_PRIVATE_KEY: optionalEnv,
  GITHUB_APP_INSTALLATION_ID: optionalEnv,
  GITHUB_WEB_URL: optionalEnv,
  GITHUB_API_URL: optionalEnv,
});

export interface DeploymentConfig {
  mode: "local" | "remote";
  db: "sqlite" | "postgres";
  blobs: "fs" | "s3";
  repoSource: "local" | "github";
  jobs: "inline" | "queue";
  auth: "local-token" | "oauth";
  postgresUrl?: string;
  s3?: {
    bucket: string;
    endpoint?: string;
    region: string;
    key: string;
    secret: string;
  };
  /** Signs remote sessions and OAuth state; required when auth is `oauth`. */
  authSecret?: string;
  /** GitHub OAuth App credentials for viewer sign-in. */
  oauth?: { clientId: string; clientSecret: string };
  /** Trusts an upstream identity proxy (IAP, Cloudflare Access): `header`
   * carries the login and `secretHeader` proves the request really passed
   * the proxy. */
  proxy?: { header: string; secret: string; secretHeader: string };
  /** A GitHub App used to fetch hosted repositories and to check a proxy
   * user's collaborator permission. */
  githubApp?: { appId: string; privateKey: string; installationId?: string };
  /** GitHub endpoints — GitHub Enterprise overrides both. */
  github?: { webUrl: string; apiUrl: string };
}

/** The private key env carries a PEM, often with escaped newlines or as
 * base64; normalize it once here so the key parses wherever it is used. */
function normalizePrivateKey(value: string): string {
  const decoded =
    value.indexOf("PRIVATE KEY") === -1
      ? Buffer.from(value, "base64").toString("utf8")
      : value;

  return decoded.replace(/\\n/g, "\n");
}

export function loadDeploymentConfig(
  env: NodeJS.ProcessEnv = process.env,
): DeploymentConfig {
  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    throw new Error(
      `Invalid deployment config: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
    );
  }

  const values = parsed.data;

  const dbValue =
    values.WHITEBOARD_DB ??
    (values.WHITEBOARD_MODE === "local" ? "sqlite" : undefined);

  const blobValue =
    values.WHITEBOARD_BLOBS ??
    (values.WHITEBOARD_MODE === "local" ? "fs" : undefined);

  const requireSetting = (value: string | undefined, setting: string) => {
    if (!value) throw new Error(`Remote deployment requires ${setting}`);

    return value;
  };

  let db: DeploymentConfig["db"] = "sqlite";
  let postgresUrl: string | undefined;

  if (dbValue === "sqlite") db = "sqlite";
  else if (
    dbValue?.startsWith("postgres://") ||
    dbValue?.startsWith("postgresql://")
  ) {
    db = "postgres";
    postgresUrl = dbValue;
  } else if (dbValue)
    throw new Error("WHITEBOARD_DB must be sqlite or a postgres:// URL");
  else requireSetting(dbValue, "WHITEBOARD_DB");

  let blobs: DeploymentConfig["blobs"] = "fs";
  let s3: DeploymentConfig["s3"];

  if (blobValue === "fs") blobs = "fs";
  else if (blobValue?.startsWith("s3://")) {
    blobs = "s3";
    const bucket = blobValue.slice("s3://".length).split("/")[0];

    if (!bucket) throw new Error("WHITEBOARD_BLOBS must name an s3://bucket");
    s3 = {
      bucket,
      endpoint: values.WHITEBOARD_S3_ENDPOINT,
      region: requireSetting(
        values.WHITEBOARD_S3_REGION,
        "WHITEBOARD_S3_REGION",
      ),
      key: requireSetting(values.WHITEBOARD_S3_KEY, "WHITEBOARD_S3_KEY"),
      secret: requireSetting(
        values.WHITEBOARD_S3_SECRET,
        "WHITEBOARD_S3_SECRET",
      ),
    };
  } else if (blobValue)
    throw new Error("WHITEBOARD_BLOBS must be fs or s3://bucket");
  else requireSetting(blobValue, "WHITEBOARD_BLOBS");

  const config: DeploymentConfig = {
    mode: values.WHITEBOARD_MODE,
    db,
    blobs,
    repoSource:
      values.WHITEBOARD_REPO_SOURCE ??
      (values.WHITEBOARD_MODE === "local" ? "local" : "github"),
    jobs:
      values.WHITEBOARD_JOBS ??
      (values.WHITEBOARD_MODE === "local" ? "inline" : "queue"),
    auth:
      values.WHITEBOARD_AUTH ??
      (values.WHITEBOARD_MODE === "local" ? "local-token" : "oauth"),
  };

  if (postgresUrl) config.postgresUrl = postgresUrl;

  if (s3) config.s3 = s3;

  // Endpoint overrides exist only when configured; the defaults live at the
  // call sites so a plain config carries no GitHub keys.
  if (values.GITHUB_WEB_URL || values.GITHUB_API_URL) {
    const webUrl = (values.GITHUB_WEB_URL ?? "https://github.com").replace(
      /\/$/,
      "",
    );

    config.github = {
      webUrl,
      apiUrl:
        values.GITHUB_API_URL ??
        (webUrl === "https://github.com"
          ? "https://api.github.com"
          : `${webUrl}/api/v3`),
    };
  }

  if (values.GITHUB_APP_ID || values.GITHUB_APP_PRIVATE_KEY) {
    const privateKey = normalizePrivateKey(
      requireSetting(values.GITHUB_APP_PRIVATE_KEY, "GITHUB_APP_PRIVATE_KEY"),
    );

    // A malformed key is a deployment error; fail before anything listens.
    try {
      createPrivateKey(privateKey);
    } catch {
      throw new Error("GITHUB_APP_PRIVATE_KEY is not a parseable PEM key");
    }

    config.githubApp = {
      appId: requireSetting(values.GITHUB_APP_ID, "GITHUB_APP_ID"),
      privateKey,
      installationId: values.GITHUB_APP_INSTALLATION_ID,
    };
  }

  if (
    values.WHITEBOARD_AUTH_PROXY_HEADER ||
    values.WHITEBOARD_AUTH_PROXY_SECRET
  )
    config.proxy = {
      header: requireSetting(
        values.WHITEBOARD_AUTH_PROXY_HEADER,
        "WHITEBOARD_AUTH_PROXY_HEADER",
      ),
      secret: requireSetting(
        values.WHITEBOARD_AUTH_PROXY_SECRET,
        "WHITEBOARD_AUTH_PROXY_SECRET",
      ),
      secretHeader:
        values.WHITEBOARD_AUTH_PROXY_SECRET_HEADER ??
        "x-whiteboard-proxy-secret",
    };

  if (values.GITHUB_OAUTH_CLIENT_ID || values.GITHUB_OAUTH_CLIENT_SECRET)
    config.oauth = {
      clientId: requireSetting(
        values.GITHUB_OAUTH_CLIENT_ID,
        "GITHUB_OAUTH_CLIENT_ID",
      ),
      clientSecret: requireSetting(
        values.GITHUB_OAUTH_CLIENT_SECRET,
        "GITHUB_OAUTH_CLIENT_SECRET",
      ),
    };

  if (config.auth === "oauth") {
    requireSetting(values.WHITEBOARD_AUTH_SECRET, "WHITEBOARD_AUTH_SECRET");
    config.authSecret = values.WHITEBOARD_AUTH_SECRET;

    if (!config.oauth && !config.proxy)
      throw new Error(
        "Remote auth requires GITHUB_OAUTH_CLIENT_ID/SECRET or " +
          "WHITEBOARD_AUTH_PROXY_HEADER/SECRET",
      );
  }

  return config;
}

export function publicDeploymentConfig(config: DeploymentConfig) {
  return {
    mode: config.mode,
    db: config.db,
    blobs: config.blobs,
    repoSource: config.repoSource,
    jobs: config.jobs,
    auth: config.auth,
  };
}
