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

/** `GET`/`PUT /admin/settings`, for admins signed in on the settings page. */
export function adminSettingsRoutes(input: {
  auth: Pick<AuthDriver, "authenticate">;
  admins: readonly string[];
  settings: AdminSettings;
}): Hono {
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

  return routes;
}
