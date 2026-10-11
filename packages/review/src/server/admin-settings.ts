import type { AuthDriver, AuthPrincipal } from "@review/auth/index.js";
import { createSealer } from "@review/auth/seal.js";
import type { MetadataStore } from "@review/review-api/storage/metadata-store.js";
import { Hono } from "hono";
import { z } from "zod";

/** Model providers the reviewer can use, and the variable each key goes in. */
export const reviewerProviders = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  google: "GEMINI_API_KEY",
} as const;

export type ReviewerProvider = keyof typeof reviewerProviders;

const providerSchema = z.enum([
  "anthropic",
  "openai",
  "openrouter",
  "google",
] satisfies ReviewerProvider[]);

const repoSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/, "Use owner/repo.");

/** Same rule as the Pi launcher's: plain model and provider names only. */
const nameSchema = z
  .string()
  .trim()
  .max(200)
  .regex(/^[\w.,:/@=-]*$/, "Letters, digits and . , : / @ = - only.");

const storedSchema = z.object({
  prReviews: z
    .object({
      repos: z.array(repoSchema).optional(),
      drafts: z.boolean().optional(),
      authoring: z.boolean().optional(),
    })
    .default({}),
  reviewer: z
    .object({
      provider: providerSchema.optional(),
      model: nameSchema.optional(),
      /** Sealed; never returned to a browser. */
      apiKey: z.string().optional(),
    })
    .default({}),
});

type Stored = z.infer<typeof storedSchema>;

/** What an admin edits. `apiKey`: a string sets it, null clears it, absent
 * keeps it. */
export const adminSettingsPatchSchema = z.strictObject({
  prReviews: z
    .strictObject({
      repos: z.array(repoSchema).max(500).optional(),
      drafts: z.boolean().optional(),
      authoring: z.boolean().optional(),
    })
    .optional(),
  reviewer: z
    .strictObject({
      provider: providerSchema.nullable().optional(),
      model: nameSchema.nullable().optional(),
      apiKey: z.string().trim().min(1).max(1000).nullable().optional(),
    })
    .optional(),
});

export type AdminSettingsPatch = z.infer<typeof adminSettingsPatchSchema>;

/** The PR review switches in effect: stored values over the env defaults. */
export interface PrReviewSettings {
  repos: string[];
  drafts: boolean;
  authoring: boolean;
}

/** What the settings page sees: no key, only whether one is stored. */
export interface AdminSettingsView {
  prReviews: PrReviewSettings;
  reviewer: {
    provider: ReviewerProvider | null;
    model: string | null;
    apiKeySet: boolean;
  };
  providers: ReviewerProvider[];
  updatedAt: string | null;
  updatedBy: string | null;
}

/** What a pull request runner gets at claim: the variables to give its
 * agent, and the provider and model to run. */
export interface ReviewerAgentConfig {
  provider?: string;
  model?: string;
  env: Record<string, string>;
}

const ROW_KEY = "deployment";

/**
 * Deployment settings an admin edits from the settings page, kept in the
 * metadata database. Env values are the defaults until an admin saves; the
 * reviewer's API key is sealed with the auth secret.
 */
export function createAdminSettings(input: {
  meta: MetadataStore;
  secret: string;
  defaults: PrReviewSettings;
}) {
  const { meta } = input;
  const { seal, unseal } = createSealer(input.secret, "admin-settings");

  const read = async () => {
    const row = await meta.get<{
      value: string;
      updated_at: string;
      updated_by: string | null;
    }>(
      "SELECT value,updated_at,updated_by FROM admin_settings WHERE key=?",
      ROW_KEY,
    );

    const parsed = storedSchema.safeParse(row ? JSON.parse(row.value) : {});

    return {
      stored: parsed.success ? parsed.data : storedSchema.parse({}),
      updatedAt: row?.updated_at ?? null,
      updatedBy: row?.updated_by ?? null,
    };
  };

  const prReviewsOf = (stored: Stored): PrReviewSettings => ({
    repos: stored.prReviews.repos ?? input.defaults.repos,
    drafts: stored.prReviews.drafts ?? input.defaults.drafts,
    authoring: stored.prReviews.authoring ?? input.defaults.authoring,
  });

  const view = async (): Promise<AdminSettingsView> => {
    const { stored, updatedAt, updatedBy } = await read();

    return {
      prReviews: prReviewsOf(stored),
      reviewer: {
        provider: stored.reviewer.provider ?? null,
        model: stored.reviewer.model || null,
        apiKeySet: Boolean(stored.reviewer.apiKey),
      },
      providers: providerSchema.options,
      updatedAt,
      updatedBy,
    };
  };

  return {
    view,

    prReviews: async () => prReviewsOf((await read()).stored),

    /** The stored reviewer key, unsealed, for checking it from the page. */
    storedApiKey: async (): Promise<string | undefined> => {
      const { apiKey } = (await read()).stored.reviewer;

      return apiKey ? unseal(apiKey) : undefined;
    },

    /** The reviewer's agent config, or undefined when no key is stored. */
    reviewerAgent: async (): Promise<ReviewerAgentConfig | undefined> => {
      const { reviewer } = (await read()).stored;
      const apiKey = reviewer.apiKey ? unseal(reviewer.apiKey) : undefined;

      if (!reviewer.provider || !apiKey) return undefined;

      return {
        provider: reviewer.provider,
        ...(reviewer.model && { model: reviewer.model }),
        env: { [reviewerProviders[reviewer.provider]]: apiKey },
      };
    },

    update: async (
      patch: AdminSettingsPatch,
      by: string,
    ): Promise<AdminSettingsView> => {
      const parsed = adminSettingsPatchSchema.parse(patch);

      await meta.transaction(async () => {
        const { stored } = await read();

        const next: Stored = {
          prReviews: { ...stored.prReviews, ...parsed.prReviews },
          reviewer: { ...stored.reviewer },
        };

        if (parsed.prReviews?.repos)
          next.prReviews.repos = [...new Set(parsed.prReviews.repos)].sort();

        const reviewer = parsed.reviewer ?? {};

        if (reviewer.provider !== undefined)
          next.reviewer.provider = reviewer.provider ?? undefined;

        if (reviewer.model !== undefined)
          next.reviewer.model = reviewer.model || undefined;

        if (reviewer.apiKey !== undefined)
          next.reviewer.apiKey =
            reviewer.apiKey === null ? undefined : seal(reviewer.apiKey);

        const now = new Date().toISOString();

        await meta.run(
          `INSERT INTO admin_settings(key,value,updated_at,updated_by) VALUES(?,?,?,?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,updated_by=excluded.updated_by`,
          ROW_KEY,
          JSON.stringify(next),
          now,
          by,
        );
      });

      return view();
    },
  };
}

export type AdminSettings = ReturnType<typeof createAdminSettings>;

/**
 * Whether a caller is a deployment admin. A person signed in through GitHub or
 * the proxy is; an API token counts only where `tokens` is set, since that is
 * how an unattended runner claims pull request asks.
 */
export function isAdmin(
  principal: AuthPrincipal | null,
  admins: readonly string[],
  options: { tokens?: boolean } = {},
): boolean {
  if (!principal) return false;

  const person =
    principal.via === "github" ||
    principal.via === "proxy" ||
    (options.tokens === true && principal.via === "api-token");

  return person && admins.includes(principal.login.toLowerCase());
}

export interface ReviewerKeyCheck {
  ok: boolean;
  message: string;
}

/**
 * Whether a provider accepts `apiKey`, by listing its models — a free call
 * that needs a valid key — and, when it can, whether `model` is among them.
 */
export async function checkReviewerKey(
  input: { provider: ReviewerProvider; apiKey: string; model?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<ReviewerKeyCheck> {
  const { provider, apiKey, model } = input;

  const request: { url: string; headers: Record<string, string> } = {
    anthropic: {
      url: "https://api.anthropic.com/v1/models?limit=1000",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    },
    openai: {
      url: "https://api.openai.com/v1/models",
      headers: { authorization: `Bearer ${apiKey}` },
    },
    // OpenRouter's model list is public; its key endpoint is not.
    openrouter: {
      url: "https://openrouter.ai/api/v1/key",
      headers: { authorization: `Bearer ${apiKey}` },
    },
    google: {
      url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
      headers: { "x-goog-api-key": apiKey },
    },
  }[provider];

  let response: Response;

  try {
    response = await fetchImpl(request.url, {
      headers: request.headers,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, message: `Could not reach ${provider}.` };
  }

  // Google answers a bad key with 400. A 403 can be a least-privilege key
  // that may run models but not list them, so it does not block saving.
  if (
    response.status === 401 ||
    (provider === "google" && response.status === 400)
  )
    return { ok: false, message: `${provider} rejected this key.` };

  if (response.status === 403)
    return {
      ok: true,
      message: `Could not verify: this key may not list ${provider} models.`,
    };

  if (!response.ok)
    return {
      ok: false,
      message: `${provider} answered ${response.status}; try again.`,
    };

  if (!model || provider === "openrouter")
    return { ok: true, message: "Key works." };

  const listed = z
    .object({
      data: z.array(z.object({ id: z.string() })).optional(),
      models: z.array(z.object({ name: z.string() })).optional(),
    })
    .safeParse(await response.json().catch(() => null));

  const ids = listed.success
    ? [
        ...(listed.data.data ?? []).map((entry) => entry.id),
        ...(listed.data.models ?? []).map((entry) =>
          entry.name.replace(/^models\//, ""),
        ),
      ]
    : [];

  return ids.length === 0 || ids.includes(model)
    ? { ok: true, message: "Key works." }
    : {
        ok: false,
        message: `Key works, but ${provider} does not list the model “${model}”.`,
      };
}

const keyCheckSchema = z.strictObject({
  provider: providerSchema,
  model: nameSchema.optional(),
  /** Absent checks the stored key. */
  apiKey: z.string().trim().min(1).max(1000).optional(),
});

const githubRepoSchema = z.array(
  z.object({
    full_name: z.string(),
    private: z.boolean(),
    permissions: z.object({ admin: z.boolean() }).partial().optional(),
  }),
);

/** `GET`/`PUT /admin/settings`, for admins signed in on the settings page;
 * `GET /admin/repositories` lists the admin's GitHub repositories and
 * `POST /admin/reviewer/check` tries a provider key. */
export function adminSettingsRoutes(input: {
  auth: Pick<AuthDriver, "authenticate">;
  admins: readonly string[];
  settings: AdminSettings;
  githubApiUrl?: string;
  fetchImpl?: typeof fetch;
}): Hono {
  const fetchImpl = input.fetchImpl ?? fetch;

  const routes = new Hono();

  const admin = async (request: Request) => {
    const principal = await input.auth.authenticate(request);

    return isAdmin(principal, input.admins) ? principal : null;
  };

  const forbidden = () =>
    Response.json(
      { ok: false, error: "Only deployment admins can do this." },
      { status: 403 },
    );

  routes.get("/settings", async (context) => {
    if (!(await admin(context.req.raw))) return forbidden();

    return context.json(await input.settings.view());
  });

  routes.put("/settings", async (context) => {
    const principal = await admin(context.req.raw);

    if (!principal) return forbidden();

    const parsed = adminSettingsPatchSchema.safeParse(
      await context.req.json().catch(() => undefined),
    );

    if (!parsed.success)
      return context.json(
        { ok: false, error: z.prettifyError(parsed.error) },
        400,
      );

    return context.json(
      await input.settings.update(parsed.data, principal.login),
    );
  });

  routes.get("/repositories", async (context) => {
    const principal = await admin(context.req.raw);

    if (!principal) return forbidden();

    if (!principal.githubToken)
      return context.json(
        { ok: false, error: "Sign in with GitHub to list repositories." },
        409,
      );

    const apiUrl = input.githubApiUrl ?? "https://api.github.com";
    const repos: { name: string; private: boolean }[] = [];

    // Ten pages of a hundred is plenty for a picker; the rest stay typeable.
    for (let page = 1; page <= 10; page++) {
      const response = await fetchImpl(
        `${apiUrl}/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`,
        {
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${principal.githubToken}`,
            "user-agent": "whiteboard",
          },
        },
      ).catch(() => undefined);

      // GitHub App user tokens expire after eight hours; a fresh sign-in
      // mints a new one.
      if (response?.status === 401)
        return context.json(
          {
            ok: false,
            error:
              "Your GitHub sign-in has expired; sign out and back in to list repositories.",
          },
          401,
        );

      if (!response?.ok)
        return context.json(
          {
            ok: false,
            error: `GitHub did not list repositories (${response?.status ?? "unreachable"}).`,
          },
          502,
        );

      const parsed = githubRepoSchema.safeParse(await response.json());

      if (!parsed.success) break;

      repos.push(
        ...parsed.data.map((repo) => ({
          name: repo.full_name.toLowerCase(),
          private: repo.private,
        })),
      );

      if (parsed.data.length < 100) break;
    }

    return context.json({ repositories: repos });
  });

  routes.post("/reviewer/check", async (context) => {
    if (!(await admin(context.req.raw))) return forbidden();

    const parsed = keyCheckSchema.safeParse(
      await context.req.json().catch(() => undefined),
    );

    if (!parsed.success)
      return context.json(
        { ok: false, error: z.prettifyError(parsed.error) },
        400,
      );

    const apiKey = parsed.data.apiKey ?? (await input.settings.storedApiKey());

    if (!apiKey)
      return context.json({
        ok: false,
        message: "No key to check.",
      } satisfies ReviewerKeyCheck);

    return context.json(
      await checkReviewerKey({ ...parsed.data, apiKey }, fetchImpl),
    );
  });

  return routes;
}
