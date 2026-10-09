import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

import { resolveRepoContextSync } from "@dev.fast/local-vcs";
import {
  type ReviewApiSummary,
  SCRATCHPAD_REVIEW_ID,
} from "@dev.fast/review-protocol";
import { AskQueue } from "@review/ask/runner/queue.js";
import { sourceAnchors } from "@review/lens-selection.js";
import {
  liftFileLenses,
  migrateStoredDocument,
  migrateStoredLenses,
} from "@review/stored-document-migration.js";
import {
  type Coverage,
  coverageSchema,
  emptyCoverage,
  updateCoverage,
} from "@review/viewed-coverage.js";
import { z } from "zod";

import { type ActivitySurface, ReviewActivity } from "./activity.js";
import { AskHistory } from "./ask-history.js";
import { ReviewComments } from "./comments.js";
import {
  type Lens,
  applyLensEdit,
  lensEditSchema,
  lensSelections,
} from "./diff-lenses.js";
import {
  type Applied,
  type Block,
  type EditSummary,
  type Element,
  type FileLineRange,
  type Pins,
  ReviewInputError,
  type ReviewTarget,
  type WrittenComponent,
  anchorPins,
  applyEdit,
  assignFreshIds,
  checkReferences,
  documentSchema,
  editSchema,
  elements,
  explicitPins,
  isUnit,
  resourceReferences,
  reviewTargetSchema,
  sourceReferences,
  summarizeEdit,
} from "./document.js";
import { pullRequestKey, pullRequestUrl, setPullRequest } from "./origin.js";
import { type ReviewFilter, reviewTagSchema } from "./review-filter.js";
import {
  type MetadataParam,
  type MetadataStore,
  createMetadataStore,
  isMetadataStore,
} from "./storage/metadata-store.js";

const reviewId = z.string().min(1);

/** There is one scratchpad. Its id is fixed so a skill can name it. */
export const SCRATCHPAD_ID = SCRATCHPAD_REVIEW_ID;

const DIAGRAM_TYPES = new Set([
  "sequence",
  "flow_diagram",
  "call_stack_diff",
  "database_lens",
  "software_map",
]);

export const SCRATCHPAD_TITLE = "Scratchpad";

const activityId = z
  .string()
  .min(1)
  .optional()
  .describe(
    "The activityId from review_activity_begin: your courier draws this edit. Never rejects a write.",
  );

export const commandSchema = z.strictObject({
  operation: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("delete"), reviewId }),
    z.strictObject({
      type: z.literal("attention"),
      reviewId,
      action: z.enum(["view", "dismiss", "restore"]),
    }),
    z.strictObject({
      type: z.literal("tags"),
      reviewId,
      add: z.array(reviewTagSchema).max(20).default([]),
      remove: z.array(reviewTagSchema).max(20).default([]),
    }),
    z.strictObject({
      type: z.literal("create"),
      /** Required unless pullRequestUrl alone names the source; then the PR title. */
      title: z.string().trim().min(1).optional(),
      target: reviewTargetSchema.optional(),
      pullRequestUrl: pullRequestUrl.optional(),
      /** Who asked for the review, for the list's author filter. */
      createdBy: z.string().trim().min(1).max(200).optional(),
      /** With pullRequestUrl and no target: the checkout to fetch the PR into. */
      repositoryId: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Only with pullRequestUrl and no target: the registered checkout to fetch the PR into. Default: the existing review's, else the first registered checkout with a remote for the PR's repository.",
        ),
      /** Return the existing review for pullRequestUrl instead of creating one. */
      reuseExisting: z
        .boolean()
        .optional()
        .describe(
          "Default true: return the existing review for pullRequestUrl. false creates a separate review.",
        ),
      /** The one scratchpad: no target, no pins; every reference names its own. */
      kind: z.literal("scratchpad").optional(),
    }),
    z.strictObject({
      type: z.literal("set_target"),
      reviewId,
      target: reviewTargetSchema,
      pullRequestUrl: pullRequestUrl.nullable().optional(),
    }),
    z.strictObject({
      type: z.literal("edit"),
      reviewId,
      edit: editSchema,
      activityId,
    }),
    z.strictObject({
      type: z.literal("lens_edit"),
      reviewId,
      edit: lensEditSchema,
      activityId,
    }),
    z.strictObject({
      type: z.literal("rename"),
      reviewId,
      title: z.string().trim().min(1),
    }),
    z.strictObject({
      type: z.literal("restore"),
      reviewId,
      version: z.number().int().nonnegative(),
    }),
  ]),
});

/** Source identity displayed in the review header and Home, alongside immutable pins. */
export interface SnapshotOrigin {
  /** Managed tutorial; readable by ID but excluded from the user catalog. */
  tutorial?: boolean;
  branch?: string;
  baseRef?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  /** The legacy review revision this version was imported from. */
  revision?: string;
}

export interface Snapshot {
  shared?: { login?: string; sharedAt?: number; cloneUrl?: string };
  reviewId: string;
  version: number;
  title: string;
  /** Absent for a review. The scratchpad has no pins, target or lifecycle. */
  kind?: "scratchpad";
  /** The default pins for references that name none. A document whose
   * references all carry their own pins has neither pins nor target. */
  pins?: Pins;
  target?: ReviewTarget;
  staleSources?: string[];
  sourceUnavailable?: boolean;
  document: Block[];
  /** The Diff view's lenses, beside the document and versioned with it.
   * Absent on a version with none. */
  lenses?: Lens[];
  createdAt: string;
  origin?: SnapshotOrigin;
  /** The edit that produced this version, when one did; absent for a
   * rename, set_target, restore or import, which the canvas does not draw. */
  lastEdit?: EditSummary;
}

export interface Result {
  /** Create only: false when an existing review for the same PR came back. */
  created?: boolean;
  /** Why an existing review came back, and what to do next, in words. */
  note?: string;
  reviewId: string;
  version: number;
  /** The existing review's stored target; the requested one is not applied. */
  target?: ReviewTarget;
  /** The requested head differs from the existing review's. */
  headMoved?: boolean;
  /** An agent is working on the existing review. */
  working?: boolean;
  /** Older reviews that also name the PR, newest first. */
  otherReviewIds?: string[];
  /** The component an edit landed on, its type, and — for an insert or
   * replace — its first-level children with their fresh IDs. */
  targetId?: string;
  type?: Element["type"] | "lens";
  children?: WrittenComponent[];
  attention?: true;
  deleted?: true;
  /** The review's tags after a tags command, sorted. */
  tags?: string[];
  warnings?: string[];
}

/** A PR's current comparison: GitHub's head and diff base, fetched locally. */
export interface ResolvedPullRequest {
  target: ReviewTarget;
  pins: Pins;
  title: string;
}

export interface ReviewProviders {
  headBranch?(pins: Pins, headRef?: string): Promise<string | undefined>;
  projectSource?(snapshot: Snapshot, pins: Pins): Promise<Snapshot>;
  /** Fetch a PR into a registered checkout: the named one, else the first
   * preferred one that still matches, else any whose remote is the PR's. */
  resolvePullRequest?(
    url: string,
    repository: { id?: string; preferred?: string },
  ): Promise<ResolvedPullRequest>;
  resolveTarget?(
    target: ReviewTarget,
    pinned?: Pins,
  ): Promise<{ target: ReviewTarget; pins: Pins }>;
  /** Rejects with a 404 ReviewInputError when the snapshot's checkout is gone.
   * Resolves undefined for a document without default pins. */
  sourcePins?(snapshot: Snapshot): Promise<Pins | undefined>;
  /** Ids of references whose own pins no longer name a usable checkout. */
  unavailableAnchors?(snapshot: Snapshot): Promise<string[]>;
  validatePins(pins: Pins): Promise<void>;
  /** A file's text at one side's commit, or undefined when it has none there. */
  fileText?(
    pins: Pins,
    side: "base" | "head",
    file: string,
  ): Promise<string | undefined>;
  /** The files each side's commit changed from one set of pins to another,
   * or undefined when they can't be diffed commit to commit. */
  filesChangedBetween?(
    from: Pins,
    to: Pins,
  ): Promise<{ base: Set<string>; head: Set<string> } | undefined>;
  validateSource(
    pins: Pins,
    source: FileLineRange,
    options: { peek: boolean },
  ): Promise<void>;
  validateResource(pins: Pins | undefined, block: Block): Promise<void>;
}

/** One instance owned by the desktop server. All writers go through execute().
 * The queue includes async validation; transactions contain only writes.
 * This prototype uses a new, explicitly supplied database, never an existing profile.
 */
export class ReviewStore {
  readonly activity: ReviewActivity;
  readonly askHistory: AskHistory;
  readonly comments: ReviewComments;
  readonly askQueue: AskQueue;
  private readonly meta: MetadataStore;
  metadataStore(): MetadataStore {
    return this.meta;
  }
  private pending: Promise<unknown> = Promise.resolve();
  private closing = false;
  private readonly liveSources = new Map<string, Snapshot>();
  private refreshTimer?: ReturnType<typeof setInterval>;
  private refreshSubscribers = 0;

  watchWorktrees(): () => void {
    this.refreshSubscribers++;
    this.refreshTimer ??= setInterval(() => {
      void this.refreshWorktrees().catch(() => {});
    }, 1000);
    this.refreshTimer.unref();

    return () => {
      if (--this.refreshSubscribers === 0) {
        clearInterval(this.refreshTimer);
        this.refreshTimer = undefined;
      }
    };
  }

  private async projectLiveSource(
    snapshot: Snapshot,
    current = snapshot,
  ): Promise<Snapshot> {
    if (snapshot.target?.kind !== "worktree") {
      await this.providers.sourcePins?.(snapshot);

      // References with their own pins go unavailable one at a time.
      const unavailable =
        (await this.providers.unavailableAnchors?.(snapshot)) ?? [];

      const stale = [
        ...new Set([...(snapshot.staleSources ?? []), ...unavailable]),
      ];

      const staleChanged =
        JSON.stringify(stale) !== JSON.stringify(current.staleSources ?? []);

      if (!current.sourceUnavailable && !staleChanged) return current;
      const projected = { ...current, sourceUnavailable: undefined };

      if (stale.length) projected.staleSources = stale;
      else delete projected.staleSources;

      return projected;
    }

    const { pins } = await this.providers.resolveTarget!(
      snapshot.target,
      current.pins,
    );

    if (
      JSON.stringify(current.pins) === JSON.stringify(pins) &&
      !current.sourceUnavailable
    )
      return current;

    return this.providers.projectSource
      ? this.providers.projectSource(snapshot, pins)
      : { ...snapshot, pins, sourceUnavailable: undefined };
  }

  private refreshPending: Promise<void> | undefined;

  /** Refresh source state without writing authored document versions. Serialized with edits. */
  refreshWorktrees(): Promise<void> {
    if (this.closing || !this.providers.resolveTarget) return Promise.resolve();

    if (this.refreshPending) return this.refreshPending;

    const run = this.pending.then(async () => {
      for (const summary of await this.list()) {
        const snapshot = await this.read(summary.reviewId, summary.version);

        try {
          const live = this.liveSources.get(summary.reviewId);
          const last = live?.version === snapshot.version ? live : snapshot;
          const previous = last.pins;
          const projected = await this.projectLiveSource(snapshot, last);

          if (projected === last) continue;
          this.liveSources.set(snapshot.reviewId, projected);

          if (
            JSON.stringify(previous) !== JSON.stringify(projected.pins) ||
            JSON.stringify(last.staleSources ?? []) !==
              JSON.stringify(projected.staleSources ?? []) ||
            last.sourceUnavailable
          )
            this.notify({
              reviewId: snapshot.reviewId,
              version: snapshot.version,
            });
        } catch (error) {
          if (error instanceof ReviewInputError && error.status === 404) {
            const last = await this.read(snapshot.reviewId);

            if (!last.sourceUnavailable) {
              this.liveSources.set(snapshot.reviewId, {
                ...last,
                sourceUnavailable: true,
              });
              this.notify({
                reviewId: snapshot.reviewId,
                version: snapshot.version,
              });
            }
          }
        }
      }
    });

    this.pending = run.catch(() => {});

    this.refreshPending = run.finally(() => {
      this.refreshPending = undefined;
    });

    return this.refreshPending;
  }
  private readonly listeners = new Set<(result: Result) => void>();
  private readonly catalogListeners = new Set<() => void>();
  private externalChanges?: ReturnType<typeof setInterval>;
  private externalPending: Promise<unknown> = Promise.resolve();
  private observedDataVersion = -1;
  private observedVersions = new Map<string, number>();
  subscribeCatalog(listener: () => void) {
    this.catalogListeners.add(listener);

    return () => {
      this.catalogListeners.delete(listener);
    };
  }
  /** For a host whose listing changed without the store: a preference flip. */
  invalidateCatalog(): void {
    for (const listener of this.catalogListeners)
      try {
        listener();
      } catch {
        // A disconnected viewer must not block other catalog subscribers.
      }
  }
  subscribe(listener: (result: Result) => void) {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }
  private constructor(
    meta: MetadataStore,
    private readonly providers: ReviewProviders,
  ) {
    this.meta = meta;
    this.activity = new ReviewActivity(meta, (id) => this.assertExists(id));
    this.askHistory = new AskHistory(meta);
    this.comments = new ReviewComments(meta);
    this.askQueue = new AskQueue(meta);
  }

  /** A store over an existing metadata backend or a SQLite file path. */
  static async open(
    source: string | MetadataStore,
    providers: ReviewProviders,
  ): Promise<ReviewStore> {
    const meta = isMetadataStore(source)
      ? source
      : await createMetadataStore({ kind: "sqlite", dir: source });

    const store = new ReviewStore(meta, providers);
    await store.init();

    return store;
  }

  private async init() {
    await this.activity.init();
    this.observedDataVersion = await this.dataVersion();
    this.observedVersions = await this.currentVersions();
    this.externalChanges = setInterval(() => {
      this.externalPending = this.refreshExternalChanges().catch(() => {});
    }, 250);
    this.externalChanges.unref();
  }

  private dataVersion() {
    return this.meta.dataVersion();
  }

  private async currentVersions() {
    return new Map(
      (await this.meta.all("SELECT id,version FROM reviews")).map((row) => [
        String(row.id),
        Number(row.version),
      ]),
    );
  }

  private async refreshExternalChanges() {
    if (this.closing) return;

    const version = await this.dataVersion();

    if (version === this.observedDataVersion) return;
    this.observedDataVersion = version;
    const current = await this.currentVersions();
    const previous = this.observedVersions;
    this.observedVersions = current;

    for (const [reviewId, savedVersion] of current)
      if (previous.get(reviewId) !== savedVersion)
        this.notify({ reviewId, version: savedVersion });

    for (const [reviewId, savedVersion] of previous)
      if (!current.has(reviewId)) {
        await this.activity.deleted(reviewId);
        this.notify({ reviewId, version: savedVersion, deleted: true });
      }

    await this.activity.refresh();

    // Attention and repository/resource changes need catalog invalidation too.
    for (const listener of this.catalogListeners) {
      try {
        listener();
      } catch {
        /* Disconnected readers do not stop polling. */
      }
    }
  }
  /** Reader progress never creates a document version or authoring event. */
  async viewedCoverage(
    reviewId: string,
  ): Promise<Map<string, { fingerprint: string; coverage: Coverage }>> {
    await this.assertExists(reviewId);

    return new Map(
      (
        await this.meta.all(
          "SELECT file,fingerprint,coverage FROM review_coverage WHERE review_id=?",
          reviewId,
        )
      ).map((row) => [
        String(row.file),
        {
          fingerprint: String(row.fingerprint),
          coverage: coverageSchema.parse(JSON.parse(String(row.coverage))),
        },
      ]),
    );
  }
  async updateViewedCoverage(
    reviewId: string,
    files: { path: string; fingerprint: string; scope: Coverage }[],
    viewed: boolean,
  ): Promise<void> {
    await this.meta.transaction(async () => {
      await this.assertExists(reviewId);
      const current = await this.viewedCoverage(reviewId);

      for (const file of files) {
        const previous = current.get(file.path);

        const coverage = updateCoverage(
          previous?.fingerprint === file.fingerprint
            ? previous.coverage
            : emptyCoverage(),
          file.scope,
          viewed,
        );

        await this.meta.run(
          "INSERT INTO review_coverage(review_id,file,fingerprint,coverage) VALUES(?,?,?,?) ON CONFLICT(review_id,file) DO UPDATE SET fingerprint=excluded.fingerprint,coverage=excluded.coverage",
          reviewId,
          file.path,
          file.fingerprint,
          JSON.stringify(coverage),
        );
      }
    });
  }
  private readonly repositoryGroups = new Map<
    string,
    ReviewApiSummary["repositoryGroup"]
  >();

  private repositoryGroup(root: string): ReviewApiSummary["repositoryGroup"] {
    if (this.repositoryGroups.has(root)) return this.repositoryGroups.get(root);

    // Resolving a missing checkout would spawn on every listing.
    if (!existsSync(root)) return undefined;

    const context = resolveRepoContextSync(root);

    if (!context) return undefined;

    const group = context.githubSlug
      ? {
          key: `remote:https://github.com/${context.githubSlug.toLowerCase()}.git`,
          label: context.githubSlug,
        }
      : {
          key: `git:${context.commonDir}`,
          label: path.basename(path.dirname(context.commonDir)),
        };

    this.repositoryGroups.set(root, group);

    return group;
  }

  async registerRepository(root: string) {
    await this.meta.run(
      "INSERT INTO repositories(id,path,name) VALUES(?,?,?) ON CONFLICT DO NOTHING",
      randomUUID(),
      root,
      root.split(/[\\/]/).at(-1)!,
    );

    const row = (await this.meta.get(
      "SELECT id,name FROM repositories WHERE path=?",
      root,
    ))!;

    return { id: String(row.id), name: String(row.name) };
  }
  async unregisterRepository(id: string) {
    // Document pins and per-reference pins both spell the id in the snapshot.
    await this.meta.run(
      `DELETE FROM repositories WHERE id=?
      AND NOT EXISTS (SELECT 1 FROM versions WHERE ${this.meta.dialect.containsText("snapshot")})
      AND NOT EXISTS (SELECT 1 FROM resources WHERE repository_id=?)`,
      id,
      `"repositoryId":${JSON.stringify(id)}`,
      id,
    );
  }
  /** Registered checkouts, oldest registration first. */
  async repositories() {
    return (
      await this.meta.all("SELECT id,path FROM repositories ORDER BY rowid")
    ).map((row) => ({ id: String(row.id), path: String(row.path) }));
  }
  async repositoryPath(id: string) {
    const row = await this.meta.get(
      "SELECT path FROM repositories WHERE id=?",
      id,
    );

    if (!row) throw new ReviewInputError("Repository is not registered.", 404);

    return String(row.path);
  }
  async putResource(
    id: string,
    repositoryId: string,
    kind: string,
    mimeType: string,
    data: Uint8Array,
  ) {
    await this.meta.run(
      "INSERT INTO resources(id,repository_id,kind,mime_type,data) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING",
      id,
      repositoryId,
      kind,
      mimeType,
      data,
    );
    const saved = await this.resource(id);

    if (
      saved.repositoryId !== repositoryId ||
      saved.kind !== kind ||
      saved.mimeType !== mimeType ||
      !Buffer.from(saved.data).equals(data)
    )
      throw new ReviewInputError(
        "Resource ID was already used for different content.",
        409,
      );

    return { id, kind, mimeType };
  }
  async resource(id: string) {
    const row = await this.meta.get("SELECT * FROM resources WHERE id=?", id);

    if (!row) throw new ReviewInputError("Resource not found.", 404);

    return {
      id,
      repositoryId: String(row.repository_id),
      kind: String(row.kind),
      mimeType: String(row.mime_type),
      // SAFETY: resources.data is a BLOB written by putResource; each adapter returns raw bytes.
      data: row.data as Uint8Array,
    };
  }
  async close() {
    this.closing = true;
    clearInterval(this.externalChanges);
    clearInterval(this.refreshTimer);
    await this.pending;
    await this.externalPending;
    this.listeners.clear();
    this.catalogListeners.clear();
    this.activity.close();
    await this.meta.close();
  }
  /** Stable across restarts; the first host on a new store chooses it. */
  async serverId(): Promise<string> {
    const read = async () =>
      (await this.meta.get("SELECT id FROM server_identity"))?.id;

    let id = await read();

    if (id === undefined) {
      // Another host may insert first; its id wins.
      await this.meta.run(
        "INSERT INTO server_identity(one,id) VALUES(1,?) ON CONFLICT DO NOTHING",
        randomUUID(),
      );
      id = await read();
    }

    return String(id);
  }
  async resetServerId(): Promise<string> {
    const id = randomUUID();
    await this.meta.run(
      "INSERT INTO server_identity(one,id) VALUES(1,?) ON CONFLICT(one) DO UPDATE SET id=excluded.id",
      id,
    );

    return id;
  }
  /** The 404 check alone, without loading a snapshot. */
  async assertExists(id: string) {
    if (!(await this.meta.get("SELECT 1 FROM reviews WHERE id=?", id)))
      throw new ReviewInputError(
        "Review not found. If this is an old Whiteboard review, ask your agent to migrate your old Whiteboard reviews.",
        404,
      );
  }
  async read(id: string, version?: number): Promise<Snapshot> {
    const row =
      version === undefined
        ? await this.meta.get(
            "SELECT snapshot FROM versions JOIN reviews ON reviews.id=review_id AND reviews.version=versions.version WHERE reviews.id=?",
            id,
          )
        : await this.meta.get(
            "SELECT snapshot FROM versions WHERE review_id=? AND version=?",
            id,
            version,
          );

    if (!row) {
      await this.assertExists(id);
      throw new ReviewInputError("Review version not found.", 404);
    }

    // SAFETY: versions contains only snapshots validated by execute before committing.
    const snapshot = JSON.parse(String(row.snapshot)) as Snapshot;

    // SAFETY: stored blocks were validated on write; migration only replaces
    // retired attachment representations with their canonical equivalent and
    // drops retired fields.
    // Lenses saved as document blocks read as the snapshot's own.
    const { document, lenses } = liftFileLenses(
      migrateStoredDocument(snapshot.document),
    );

    // SAFETY: stored blocks were validated on write; migration only replaces
    // retired representations and lifts retired lens blocks out.
    snapshot.document = document as Block[];

    if (snapshot.lenses)
      // SAFETY: as above, migration only rewrites retired range forms.
      snapshot.lenses = migrateStoredLenses(snapshot.lenses) as Lens[];

    if (lenses.length)
      snapshot.lenses = [...(snapshot.lenses ?? []), ...lenses];

    if (snapshot.pins)
      snapshot.target ??= {
        kind: "commits",
        repositoryId: snapshot.pins.repositoryId,
        base: snapshot.pins.base,
        head: snapshot.pins.head,
      };
    const live = version === undefined ? this.liveSources.get(id) : undefined;

    if (live?.version === snapshot.version) return structuredClone(live);

    return snapshot;
  }
  async setDiffStats(
    pins: Pins,
    stats: NonNullable<ReviewApiSummary["diffStats"]>,
    mode: "structural" | "textual" = "structural",
  ) {
    if (this.closing) return;
    await this.meta.run(
      "INSERT INTO comparison_stats(identity, stats) VALUES (?, ?) ON CONFLICT(identity) DO UPDATE SET stats=excluded.stats",
      JSON.stringify([pins, mode]),
      JSON.stringify(stats),
    );

    for (const listener of this.catalogListeners) {
      try {
        listener();
      } catch {
        /* A disconnected viewer must not block other catalog subscribers. */
      }
    }
  }

  /** Managed records are discoverable even if their preparation stamp was lost. */
  async tutorialIds(): Promise<string[]> {
    return (
      await this.meta.all(
        `SELECT reviews.id FROM reviews JOIN versions ON versions.review_id=reviews.id AND versions.version=reviews.version WHERE ${this.meta.dialect.jsonFlag("versions.snapshot", "origin.tutorial")}`,
      )
    ).map((row) => String(row.id));
  }

  list(
    mode: "structural" | "textual" = "structural",
    filter: ReviewFilter = {},
  ): Promise<ReviewApiSummary[]> {
    return this.summaries(mode, undefined, filter);
  }
  /** One review's catalog entry, as review_list shows it. */
  async summary(id: string): Promise<ReviewApiSummary | undefined> {
    return (await this.summaries("structural", id))[0];
  }
  private async summaries(
    mode: "structural" | "textual",
    id?: string,
    filter: ReviewFilter = {},
  ): Promise<ReviewApiSummary[]> {
    // One query, and the document never leaves the database: every catalog
    // watcher re-lists on every command.
    const dialect = this.meta.dialect;

    const clauses: string[] = [];
    const params: MetadataParam[] = [];

    if (id !== undefined) {
      clauses.push("reviews.id=?");
      params.push(id);
    }

    if (filter.repo !== undefined) {
      clauses.push("(repositories.name=? OR repositories.id=?)");
      params.push(filter.repo, filter.repo);
    }

    if (filter.branch !== undefined) {
      clauses.push("reviews.branch=?");
      params.push(filter.branch);
    }

    if (filter.commit !== undefined) {
      clauses.push("(reviews.head_sha LIKE ? OR reviews.base_sha LIKE ?)");
      params.push(`${filter.commit}%`, `${filter.commit}%`);
    }

    if (filter.author !== undefined) {
      clauses.push("reviews.created_by=?");
      params.push(filter.author);
    }

    if (filter.tag !== undefined) {
      clauses.push(
        "reviews.id IN (SELECT review_id FROM review_tags WHERE tag=?)",
      );
      params.push(filter.tag);
    }

    const rows = await this.meta.all(
      `SELECT ${dialect.jsonWithout("versions.snapshot", "document")} AS summary,
        (SELECT ${dialect.jsonText("first.snapshot", "createdAt")} FROM versions AS first WHERE first.review_id=reviews.id ORDER BY first.version LIMIT 1) AS first_created_at,
        review_attention.viewed_at, review_attention.dismissed_at, repositories.name AS repository_name, repositories.path AS repository_path,
        reviews.created_by
      FROM reviews
      JOIN versions ON versions.review_id=reviews.id AND versions.version=reviews.version
      LEFT JOIN review_attention ON review_attention.review_id=reviews.id
      LEFT JOIN repositories ON repositories.id=${dialect.jsonText("versions.snapshot", "pins.repositoryId")}
      WHERE NOT ${dialect.jsonFlag("versions.snapshot", "origin.tutorial")}
      ${clauses.map((clause) => `AND ${clause}`).join("")}
      ORDER BY reviews.rowid`,
      ...params,
    );

    const tags = new Map<string, string[]>();

    for (const row of await this.meta.all(
      "SELECT review_id, tag FROM review_tags ORDER BY tag",
    )) {
      const reviewTags = tags.get(String(row.review_id)) ?? [];

      reviewTags.push(String(row.tag));
      tags.set(String(row.review_id), reviewTags);
    }

    const reviews: ReviewApiSummary[] = [];

    for (const row of rows) {
      // SAFETY: versions contains only snapshots validated by execute before committing.
      const summary = JSON.parse(String(row.summary)) as Omit<
        Snapshot,
        "document"
      >;

      if (summary.pins)
        summary.target ??= {
          kind: "commits",
          repositoryId: summary.pins.repositoryId,
          base: summary.pins.base,
          head: summary.pins.head,
        };

      const live = this.liveSources.get(summary.reviewId);

      if (
        live?.version === summary.version &&
        summary.target?.kind === "worktree"
      )
        summary.pins = live.pins;

      const listed: ReviewApiSummary = {
        ...summary,
        firstCreatedAt: row.first_created_at
          ? String(row.first_created_at)
          : undefined,
        repositoryPath: row.repository_path
          ? String(row.repository_path)
          : undefined,
        repositoryGroup: row.repository_path
          ? this.repositoryGroup(String(row.repository_path))
          : undefined,
        repositoryName: row.repository_name
          ? String(row.repository_name)
          : (summary.pins?.repositoryId ?? ""),
        viewedAt: row.viewed_at ? String(row.viewed_at) : null,
        dismissedAt: row.dismissed_at ? String(row.dismissed_at) : null,
        working: this.activity.isWorking(summary.reviewId),
        tags: tags.get(summary.reviewId) ?? [],
        ...(row.created_by !== null && { createdBy: String(row.created_by) }),
      };

      if (summary.kind === "scratchpad")
        listed.contents = await this.scratchpadContents();

      reviews.push(listed);
    }

    return this.withDiffStats(reviews, mode);
  }

  /** Local and imported summaries use the same persisted, mode-specific counts. */
  async withDiffStats<T extends ReviewApiSummary>(
    reviews: T[],
    mode: "structural" | "textual" = "structural",
  ): Promise<T[]> {
    const stats = new Map(
      (await this.meta.all("SELECT identity, stats FROM comparison_stats")).map(
        (row) => [
          String(row.identity),
          // SAFETY: comparison_stats is written only from the validated diff-stats contract.
          JSON.parse(String(row.stats)) as NonNullable<
            ReviewApiSummary["diffStats"]
          >,
        ],
      ),
    );

    return reviews.map((review) => ({
      ...review,
      diffStats: review.pins
        ? (stats.get(JSON.stringify([review.pins, mode])) ?? null)
        : null,
    }));
  }

  /** What the pad holds, for its Home card: blocks, and the diagrams among them. */
  private async scratchpadContents(): Promise<
    NonNullable<ReviewApiSummary["contents"]>
  > {
    const blocks = elements((await this.read(SCRATCHPAD_ID)).document).filter(
      (element) => !isUnit(element),
    );

    return {
      blocks: blocks.length,
      diagrams: blocks.filter((block) => DIAGRAM_TYPES.has(block.type)).length,
    };
  }
  /** The one scratchpad, made on first use. A host that loses the race to
   * another on the same home finds it made. */
  async ensureScratchpad(): Promise<void> {
    if (await this.has(SCRATCHPAD_ID)) return;

    try {
      await this.execute({
        operation: {
          type: "create",
          title: SCRATCHPAD_TITLE,
          kind: "scratchpad",
        },
      });
    } catch (error) {
      if (!(await this.has(SCRATCHPAD_ID))) throw error;
    }
  }
  async history(id: string) {
    const dialect = this.meta.dialect;

    return (
      await this.meta.all(
        `SELECT version,${dialect.jsonText("snapshot", "title")} AS title,${dialect.jsonText("snapshot", "createdAt")} AS created_at FROM versions WHERE review_id=? ORDER BY version`,
        id,
      )
    ).map((row) => ({
      version: Number(row.version),
      title: String(row.title),
      createdAt: String(row.created_at),
    }));
  }
  async inspect(id: string, targetId?: string, version?: number) {
    const snapshot = await this.read(id, version);

    return inspectSnapshot(snapshot, targetId);
  }
  /** The host can seed a managed document; transport callers only supply a command. */
  execute(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Command boundary: commandSchema.parse below rejects malformed input before mutation.
    input: unknown,
    initial?: { document: Block[]; origin: SnapshotOrigin },
  ): Promise<Result> {
    if (this.closing)
      return Promise.reject(new Error("Review store is closing."));
    const command = commandSchema.parse(input);

    if (initial && command.operation.type !== "create")
      throw new ReviewInputError("Initial content requires a create command.");
    // Network and fetch time stay out of the write queue.
    const pullRequest = this.startPullRequest(command);

    pullRequest?.catch(() => {});

    const run = this.pending.then(async () => {
      const op = command.operation;

      // The scratchpad is edited and restored like a review, and nothing else.
      if (
        op.type !== "create" &&
        op.type !== "edit" &&
        op.type !== "lens_edit" &&
        op.type !== "restore" &&
        (await this.read(op.reviewId)).kind === "scratchpad"
      )
        throw new ReviewInputError(
          "The scratchpad has no lifecycle, title or pins of its own.",
          409,
        );

      if (op.type === "create" && op.kind === "scratchpad") {
        if (op.target)
          throw new ReviewInputError("A scratchpad has no target of its own.");

        if (await this.has(SCRATCHPAD_ID))
          throw new ReviewInputError("The scratchpad already exists.", 409);
      } else if (op.type === "create") {
        if (!op.target && !op.pullRequestUrl)
          throw new ReviewInputError("Supply a target or a pullRequestUrl.");

        if (op.repositoryId && op.target)
          throw new ReviewInputError(
            "A checkout for the PR applies only to a create from pullRequestUrl alone; name it in the target instead.",
          );

        if (!op.title && op.target)
          throw new ReviewInputError("Supply a title.");
      }

      const requestedTarget =
        op.type === "create" || op.type === "set_target"
          ? op.target
          : undefined;

      const fromPullRequest = await pullRequest;

      const resolvedTarget = requestedTarget
        ? await (this.providers.resolveTarget?.(requestedTarget) ??
            namedCommits(requestedTarget))
        : fromPullRequest;

      if (requestedTarget && !resolvedTarget)
        throw new ReviewInputError("Review targets are unavailable.");

      if (
        op.type === "create" &&
        op.pullRequestUrl &&
        op.reuseExisting !== false
      ) {
        const [found, ...others] = await this.reviewsForPullRequest(
          op.pullRequestUrl,
        );

        if (found) {
          const result = await this.existingReview(
            found,
            others,
            resolvedTarget!.pins,
          );

          return result;
        }
      }

      if (op.type === "delete") {
        const result: Result = {
          reviewId: op.reviewId,
          version: (await this.read(op.reviewId)).version,
          deleted: true,
        };

        await this.commitCommand(
          result,
          async () => {
            for (const table of [
              "ask_conversations",
              "review_comments",
              "authoring_presences",
              "review_tags",
              "review_coverage",
              "review_attention",
              "versions",
            ])
              await this.meta.run(
                `DELETE FROM ${table} WHERE review_id=?`,
                op.reviewId,
              );
            await this.meta.run("DELETE FROM reviews WHERE id=?", op.reviewId);
          },
          () => this.assertMutation(op.reviewId, result.version),
        );

        return result;
      }

      if (op.type === "tags") {
        const result: Result = {
          reviewId: op.reviewId,
          version: (await this.read(op.reviewId)).version,
          tags: [],
        };

        await this.commitCommand(result, async () => {
          for (const tag of op.add)
            await this.meta.run(
              "INSERT INTO review_tags(review_id,tag) VALUES(?,?) ON CONFLICT DO NOTHING",
              op.reviewId,
              tag,
            );

          for (const tag of op.remove)
            await this.meta.run(
              "DELETE FROM review_tags WHERE review_id=? AND tag=?",
              op.reviewId,
              tag,
            );

          result.tags = (
            await this.meta.all(
              "SELECT tag FROM review_tags WHERE review_id=? ORDER BY tag",
              op.reviewId,
            )
          ).map((row) => String(row.tag));
        });

        return result;
      }

      if (op.type === "attention") {
        const result: Result = {
          reviewId: op.reviewId,
          version: (await this.read(op.reviewId)).version,
          attention: true,
        };

        await this.commitCommand(result, async () => {
          await this.meta.run(
            "INSERT INTO review_attention(review_id) VALUES(?) ON CONFLICT DO NOTHING",
            op.reviewId,
          );

          if (op.action === "view")
            await this.meta.run(
              "UPDATE review_attention SET viewed_at=? WHERE review_id=?",
              new Date().toISOString(),
              op.reviewId,
            );
          else
            await this.meta.run(
              "UPDATE review_attention SET dismissed_at=? WHERE review_id=?",
              op.action === "dismiss" ? new Date().toISOString() : null,
              op.reviewId,
            );
        });

        return result;
      }

      const id =
        op.type !== "create"
          ? op.reviewId
          : op.kind === "scratchpad"
            ? SCRATCHPAD_ID
            : randomUUID();

      const previous = op.type === "create" ? undefined : await this.read(id);

      let snapshot: Snapshot =
        op.type === "create"
          ? createdSnapshot(id, op, resolvedTarget, fromPullRequest?.title)
          : structuredClone(previous!);

      // Overlay state: a degraded read must not persist unavailability.
      delete snapshot.sourceUnavailable;
      // Each version describes only its own edit.
      delete snapshot.lastEdit;

      let nextId = previous
        ? Number(
            (await this.meta.get("SELECT next_id FROM reviews WHERE id=?", id))!
              .next_id,
          )
        : 0;

      let applied: Applied | undefined;
      let lensTarget: { targetId: string; type: "lens" } | undefined;

      if (
        (op.type === "create" || op.type === "set_target") &&
        this.providers.headBranch
      ) {
        const pins = resolvedTarget?.pins ?? snapshot.pins;

        if (pins) {
          const headRef =
            requestedTarget?.kind === "commits"
              ? requestedTarget.head
              : undefined;

          const branch = await this.providers.headBranch(pins, headRef);

          snapshot.origin = { ...snapshot.origin, branch };
        }
      }

      switch (op.type) {
        case "create":
          if (initial) {
            snapshot.document = documentSchema.parse(initial.document);
            snapshot.origin = {
              ...snapshot.origin,
              ...structuredClone(initial.origin),
            };

            for (const block of snapshot.document)
              assignFreshIds(block, (prefix) => `${prefix}-${++nextId}`);
          }

          setPullRequest(snapshot, op.pullRequestUrl);
          break;
        case "rename":
          snapshot.title = op.title;
          break;
        case "set_target":
          setPullRequest(
            snapshot,
            op.pullRequestUrl ??
              (op.pullRequestUrl === null ||
              snapshot.pins?.repositoryId !== resolvedTarget!.pins.repositoryId
                ? null
                : undefined),
          );
          snapshot.staleSources = [];
          snapshot.target = resolvedTarget!.target;
          snapshot.pins = resolvedTarget!.pins;
          break;
        case "restore":
          snapshot = await this.read(id, op.version);
          delete snapshot.lastEdit;
          break;
        case "lens_edit": {
          if (snapshot.kind === "scratchpad")
            throw new ReviewInputError(
              "The scratchpad has no changes of its own to lens.",
              409,
            );

          const lenses = snapshot.lenses ?? [];
          const lens = applyLensEdit(lenses, op.edit, () => `lens-${++nextId}`);

          if (lenses.length) snapshot.lenses = lenses;
          else delete snapshot.lenses;
          lensTarget = { targetId: lens.id, type: "lens" };
          snapshot.lastEdit = {
            type: op.edit.type,
            targetId: lens.id,
            blockId: lens.id,
            kind: "lens",
            ...(op.edit.type === "update" && {
              fields: Object.keys(op.edit).filter(
                (key) => key !== "type" && key !== "targetId",
              ),
            }),
          };
          break;
        }

        case "edit": {
          applied = applyEdit(
            snapshot.document,
            op.edit,
            (prefix) => `${prefix}-${++nextId}`,
            // The scratchpad is a running log: the newest thought goes on top.
            { placement: snapshot.kind === "scratchpad" ? "first" : "last" },
          );

          snapshot.lastEdit = summarizeEdit(
            op.edit,
            applied,
            previous!.document,
            snapshot.document,
          );

          if (snapshot.staleSources?.length) {
            const oldSources = new Map(
              sourceReferences(previous!.document).map((item) => [
                item.id,
                JSON.stringify(item.source),
              ]),
            );

            const newSources = new Map(
              sourceReferences(snapshot.document).map((item) => [
                item.id,
                JSON.stringify(item.source),
              ]),
            );

            snapshot.staleSources = snapshot.staleSources.filter(
              (id) =>
                oldSources.get(id) === newSources.get(id) && newSources.has(id),
            );
          }

          break;
        }
      }

      if (
        snapshot.target?.kind === "worktree" &&
        op.type !== "restore" &&
        !resolvedTarget
      ) {
        snapshot = await this.projectLiveSource(snapshot);
      }

      // Component shapes were checked at entry (or when merging a field patch).
      // Check cross-references here; do not reparse the whole stored document.
      checkReferences(snapshot.document);

      if (
        snapshot.pins &&
        (!previous ||
          JSON.stringify(previous.pins) !== JSON.stringify(snapshot.pins))
      )
        await this.providers.validatePins(snapshot.pins);

      const warnings = await this.validateExternal(
        snapshot,
        previous,
        op.type === "set_target",
      );

      snapshot.version = previous ? previous.version + 1 : 0;
      snapshot.createdAt = new Date().toISOString();

      const result: Result = {
        ...(op.type === "create" && { created: true }),
        reviewId: id,
        version: snapshot.version,
        targetId: applied?.targetId ?? lensTarget?.targetId,
        ...(applied && { type: applied.type }),
        ...(lensTarget && { type: lensTarget.type }),
        ...(applied?.children && { children: applied.children }),
      };

      if (warnings.length) result.warnings = warnings;

      await this.commitCommand(
        result,
        async () => {
          await this.meta.run(
            "INSERT INTO reviews(id,version,next_id,branch,base_sha,head_sha,created_by) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,next_id=excluded.next_id,branch=excluded.branch,base_sha=excluded.base_sha,head_sha=excluded.head_sha,created_by=COALESCE(excluded.created_by,reviews.created_by)",
            id,
            snapshot.version,
            nextId,
            snapshot.origin?.branch ?? null,
            snapshot.pins?.base ?? null,
            snapshot.pins?.head ?? null,
            op.type === "create" ? (op.createdBy ?? null) : null,
          );
          await this.meta.run(
            "INSERT INTO versions(review_id,version,snapshot) VALUES(?,?,?)",
            id,
            snapshot.version,
            JSON.stringify(snapshot),
          );

          if (
            previous?.pins &&
            snapshot.pins &&
            this.providers.fileText &&
            JSON.stringify(previous.pins) !== JSON.stringify(snapshot.pins)
          ) {
            const { fileText } = this.providers;
            const previousPins = previous.pins;
            const nextPins = snapshot.pins;

            await this.comments.carryForward(
              id,
              snapshot.version,
              {
                previous: (side, file) => fileText(previousPins, side, file),
                next: (side, file) => fileText(nextPins, side, file),
              },
              new Set(
                elements(snapshot.document).flatMap((element) =>
                  element.id ? [element.id] : [],
                ),
              ),
            );
          }
        },
        previous ? () => this.assertMutation(id, previous.version) : undefined,
        op.type === "edit" || op.type === "lens_edit"
          ? {
              surface: op.type === "edit" ? "document" : "lenses",
              activityId: op.activityId,
              // The version names the agent whose courier draws it.
              owned: (owner) => {
                if (snapshot.lastEdit) snapshot.lastEdit.activityId = owner;
              },
            }
          : undefined,
      );

      return result;
    });

    this.pending = run.catch(() => {});

    return run;
  }
  /** Resolve a target-less PR create before it queues, when it will need it. */
  private startPullRequest(
    command: z.infer<typeof commandSchema>,
  ): Promise<ResolvedPullRequest | undefined> | undefined {
    const op = command.operation;

    if (op.type !== "create" || op.kind || op.target || !op.pullRequestUrl)
      return undefined;

    if (!this.providers.resolvePullRequest)
      return Promise.reject(
        new ReviewInputError("Pull request targets are unavailable."),
      );

    const resolvePullRequest = this.providers.resolvePullRequest;

    return (async () => {
      // Keep an existing review's checkout so headMoved compares like with like.
      const [existing] =
        op.reuseExisting === false
          ? []
          : await this.reviewsForPullRequest(op.pullRequestUrl!);

      return resolvePullRequest(op.pullRequestUrl!, {
        id: op.repositoryId,
        preferred: existing && (await this.read(existing)).pins?.repositoryId,
      });
    })();
  }
  /** Reviews whose PR is this one, newest version first. Summaries only. */
  private async reviewsForPullRequest(url: string): Promise<string[]> {
    const dialect = this.meta.dialect;

    return (
      await this.meta.all(
        `SELECT reviews.id FROM reviews
        JOIN versions ON versions.review_id=reviews.id AND versions.version=reviews.version
        WHERE lower(${dialect.jsonText("versions.snapshot", "origin.pullRequestUrl")})=?
          AND NOT ${dialect.jsonFlag("versions.snapshot", "origin.tutorial")}
        ORDER BY ${dialect.jsonText("versions.snapshot", "createdAt")} DESC, reviews.rowid DESC`,
        pullRequestKey(url),
      )
    ).map((row) => String(row.id));
  }
  /** The answer to a create that found its PR's review. Its target stays:
   * moving it would silently point existing links at different code. */
  private async existingReview(
    reviewId: string,
    others: string[],
    requested: Pins,
  ): Promise<Result> {
    const snapshot = await this.read(reviewId);

    const headMoved =
      snapshot.pins?.repositoryId !== requested.repositoryId ||
      snapshot.pins?.head !== requested.head;

    const working = (await this.activity.read(reviewId)).activities ?? [];

    const note = [
      "Returned the existing review for this PR instead of creating one; the requested title and target were not applied. Update it in place (read it with session_get first), or pass reuseExisting:false to create a separate review.",
      headMoved &&
        "The PR head moved since this review's target was set, and the target was NOT changed: call review_set_target to move it, then repair the source references it reports.",
      working.length > 0 &&
        `Another agent is working on it${working[0]!.focus ? `: ${working[0]!.focus.description}` : ""}.`,
      others.length > 0 &&
        "Older reviews also name this PR; see otherReviewIds.",
    ]
      .filter(Boolean)
      .join(" ");

    return {
      created: false,
      note,
      reviewId,
      version: snapshot.version,
      target: snapshot.target,
      headMoved,
      ...(working.length > 0 && { working: true }),
      ...(others.length > 0 && { otherReviewIds: others }),
    };
  }
  private async commitCommand(
    result: Result,
    apply: () => Promise<void> | void,
    guard?: () => Promise<void> | void,
    /** An edit credits the agent it came from, renewing its presence. */
    attribution?: {
      surface: ActivitySurface;
      activityId?: string;
      owned(activityId: string): void;
    },
  ) {
    let owner: string | undefined;

    await this.meta.transaction(async () => {
      await guard?.();

      if (attribution) {
        owner = await this.activity.attribute(
          result.reviewId,
          attribution.surface,
          attribution.activityId,
        );

        if (owner) attribution.owned(owner);
        else if (attribution.activityId)
          result.warnings = [
            ...(result.warnings ?? []),
            "Your activity has ended or expired, so readers no longer see you working. The edit was saved; call session_activity_begin and pass the new activityId.",
          ];
      }

      await apply();
    });

    if (result.deleted) await this.activity.deleted(result.reviewId);
    else if (owner) await this.activity.extended(result.reviewId);
    this.notify(result);
  }
  private async assertMutation(reviewId: string, version: number | undefined) {
    const current = await this.meta.get(
      "SELECT version FROM reviews WHERE id=?",
      reviewId,
    );

    if ((current ? Number(current.version) : undefined) !== version)
      throw new ReviewInputError(
        "Review changed during validation. Reread it and retry the edit.",
        409,
      );
  }

  private notify(result: Result) {
    if (result.deleted) this.observedVersions.delete(result.reviewId);
    else if (!result.attention)
      this.observedVersions.set(result.reviewId, result.version);

    if (!result.attention)
      for (const listener of this.listeners)
        try {
          listener(result);
        } catch {
          // A subscriber failure must not reject the committed command.
        }

    for (const listener of this.catalogListeners)
      try {
        listener();
      } catch {
        // The saved command must remain successful if a viewer disconnects.
      }
  }
  /** Dismissed reviews, as Home lists them; only a restore clears it, not a view. */
  async dismissedIds(): Promise<string[]> {
    return (
      await this.meta.all(
        "SELECT review_id FROM review_attention WHERE dismissed_at IS NOT NULL",
      )
    ).map((row) => String(row.review_id));
  }
  async has(reviewId: string): Promise<boolean> {
    return (
      (await this.meta.get("SELECT 1 FROM reviews WHERE id=?", reviewId)) !==
      undefined
    );
  }
  private async validateExternal(
    snapshot: Snapshot,
    previous?: Snapshot,
    repin = false,
  ) {
    const warnings: string[] = [];

    const references = (
      document: Block[],
      tolerant = false,
      lenses: readonly Lens[] = [],
    ) => {
      const sources = new Map<
        string,
        { source: FileLineRange; peek: boolean }
      >();

      const resources = new Map<string, Block>();

      const add = (source: FileLineRange, peek: boolean) => {
        const key = JSON.stringify(source);
        const kept = sources.get(key);
        sources.set(key, { source, peek: peek || (kept?.peek ?? false) });
      };

      for (const { source, peek } of sourceReferences(document, { tolerant }))
        add(source, peek === true);

      // A lens range is a prose-like link: it must exist, not read as a peek.
      for (const { source } of lensSelections(lenses))
        for (const anchor of sourceAnchors(source)) add(anchor, false);

      for (const block of resourceReferences(document))
        resources.set(JSON.stringify(block), block);

      return { sources, resources };
    };

    const current = references(snapshot.document, repin, snapshot.lenses);

    // Stored content is not re-validated: an edit may fix a link that the
    // current rules reject.
    const pinsChanged =
      previous &&
      JSON.stringify(previous.pins) !== JSON.stringify(snapshot.pins);

    const worktreeMoved = pinsChanged && snapshot.target?.kind === "worktree";

    const changed =
      repin && pinsChanged && previous.pins && snapshot.pins
        ? await this.providers
            .filesChangedBetween?.(previous.pins, snapshot.pins)
            .catch(() => undefined)
        : undefined;

    const retained = references(
      previous?.document ?? [],
      true,
      previous?.lenses,
    );

    // Independent reads of immutable commits: run them concurrently.
    const checks: Promise<void>[] = [];

    // Pins a reference names itself must be resolved commits of a registered
    // repository, like document pins. Check each distinct new set once.
    const retainedPins = new Set(
      explicitPins([...retained.sources.values()]).map((pins) =>
        JSON.stringify(pins),
      ),
    );

    for (const pins of explicitPins([...current.sources.values()]))
      if (!retainedPins.has(JSON.stringify(pins)))
        checks.push(this.providers.validatePins(pins));

    for (const [key, { source, peek }] of current.sources) {
      const kept = retained.sources.get(key);

      // A range validated earlier as a prose link still needs the peek check
      // the first time a code peek points at it. A reference with its own
      // pins is unaffected by the document's pins changing.
      if ((pinsChanged && !source.pins) || !kept || (peek && !kept.peek))
        checks.push(
          this.providers
            .validateSource(anchorPins(source, snapshot.pins), source, {
              peek,
            })
            .then(
              () => {
                if (
                  repin &&
                  (!changed || changed[source.side].has(source.file))
                )
                  warnings.push(
                    `${source.side}/${source.file}#L${source.fromLine}-L${source.toLine}: source pins changed; verify that this range still supports the document.`,
                  );
              },
              (error) => {
                if (
                  (!repin && !(worktreeMoved && kept)) ||
                  !(error instanceof ReviewInputError)
                )
                  throw error;
                warnings.push(
                  `${source.side}/${source.file}#L${source.fromLine}-L${source.toLine}: ${error.message}`,
                );
              },
            ),
        );
    }

    for (const [key, block] of current.resources)
      if (pinsChanged || !retained.resources.has(key))
        checks.push(
          this.providers
            .validateResource(snapshot.pins, block)
            .catch((error) => {
              if (
                (!repin && !(worktreeMoved && retained.resources.has(key))) ||
                !(error instanceof ReviewInputError)
              )
                throw error;
              warnings.push(`${block.id} (${block.type}): ${error.message}`);
            }),
        );

    await Promise.all(checks);

    return warnings.sort();
  }
}

/** Without a resolver, a commits target that names both commits pins them as
 * given; validatePins still checks they exist. */
function namedCommits(target: ReviewTarget) {
  if (target.kind !== "commits" || target.base === undefined) return undefined;

  const { repositoryId, base, head } = target;

  return { target, pins: { repositoryId, base, head } };
}

/** A new document's first version, before its initial content. Field order
 * is kept so stored JSON reads as it always has. */
function createdSnapshot(
  id: string,
  op: { title?: string; kind?: "scratchpad" },
  resolved: { target: ReviewTarget; pins: Pins } | undefined,
  defaultTitle?: string,
): Snapshot {
  const title = op.title ?? defaultTitle;

  if (!title) throw new ReviewInputError("Supply a title.");

  if (!resolved)
    return {
      reviewId: id,
      version: 0,
      title,
      kind: op.kind,
      document: [],
      createdAt: "",
    };

  return {
    reviewId: id,
    version: 0,
    title,
    pins: resolved.pins,
    target: resolved.target,
    document: [],
    createdAt: "",
  };
}

export function inspectSnapshot(snapshot: Snapshot, targetId?: string) {
  if (targetId !== undefined) {
    const target = elements(snapshot.document).find(
      (element) => element.id === targetId,
    );

    if (!target)
      throw new ReviewInputError("Target not found in this version.", 404);

    return target;
  }

  return elements(snapshot.document).map((element) => ({
    id: element.id,
    type: element.type,
    label:
      "title" in element
        ? element.title
        : "label" in element
          ? element.label
          : element.type === "markdown"
            ? element.markdown.slice(0, 120)
            : undefined,
  }));
}
