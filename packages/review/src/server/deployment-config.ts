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
