import {
  type AskAgentId,
  type AskEntry,
  type AskHistoryEntry,
  type AskOffer,
  askEntrySchema,
  askHistoryEntrySchema,
  askOfferSchema,
} from "@review/ask/thread-state.js";
import { z } from "zod";

import type { MetadataStore } from "./storage/metadata-store.js";

/** A saved Ask conversation: its history entry, and how to reopen it. */
export const askRecordSchema = askHistoryEntrySchema.extend({
  reviewId: z.string(),
  /** The ACP session the agent keeps the transcript under. */
  sessionId: z.string(),
  /** The review version asked about; its pins recreate the checkout. */
  version: z.number().int(),
  cwd: z.string(),
  /** What the panel showed last; absent until a turn ends or it closes. */
  entries: z.array(askEntrySchema).optional(),
  /** The agent edits and runs commands without asking. */
  bypass: z.boolean().optional(),
});

export type AskRecord = z.infer<typeof askRecordSchema>;

const rowSchema = z
  .object({
    id: z.string(),
    review_id: z.string(),
    agent: z.string(),
    session_id: z.string(),
    version: z.number(),
    head: z.string(),
    cwd: z.string(),
    selection: z.string(),
    title: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    entries: z.string().nullable(),
    bypass: z.number(),
  })
  .transform((row) =>
    askRecordSchema.parse({
      id: row.id,
      reviewId: row.review_id,
      agent: row.agent,
      sessionId: row.session_id,
      version: row.version,
      head: row.head,
      cwd: row.cwd,
      selection: JSON.parse(row.selection),
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      entries: row.entries === null ? undefined : JSON.parse(row.entries),
      bypass: row.bypass === 1,
    }),
  );

/** Saved Ask conversations, per review. Shared reviews are not in
 * `reviews`, so there is no foreign key; deleting a review deletes its rows. */
export class AskHistory {
  constructor(private readonly meta: MetadataStore) {}

  async save(record: AskRecord) {
    await this.meta.run(
      `INSERT INTO ask_conversations(id,review_id,agent,session_id,version,head,cwd,selection,title,created_at,updated_at,bypass)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET review_id=excluded.review_id,agent=excluded.agent,session_id=excluded.session_id,
        version=excluded.version,head=excluded.head,cwd=excluded.cwd,selection=excluded.selection,title=excluded.title,
        created_at=excluded.created_at,updated_at=excluded.updated_at,bypass=excluded.bypass`,
      record.id,
      record.reviewId,
      record.agent,
      record.sessionId,
      record.version,
      record.head,
      record.cwd,
      JSON.stringify(record.selection),
      record.title,
      record.createdAt,
      record.updatedAt,
      record.bypass ? 1 : 0,
    );
  }

  /** Whether reopening the conversation bypasses permissions. */
  async setBypass(id: string, bypass: boolean) {
    await this.meta.run(
      "UPDATE ask_conversations SET bypass=? WHERE id=?",
      bypass ? 1 : 0,
      id,
    );
  }

  /** Points a conversation at a new session, when its agent could not
   * reopen the one it had. */
  async updateSession(id: string, sessionId: string) {
    await this.meta.run(
      "UPDATE ask_conversations SET session_id=? WHERE id=?",
      sessionId,
      id,
    );
  }

  /** Keeps what the panel shows, so a reopen need not wait on the agent. */
  async saveEntries(id: string, entries: AskEntry[]) {
    await this.meta.run(
      "UPDATE ask_conversations SET entries=? WHERE id=?",
      JSON.stringify(entries),
      id,
    );
  }

  /** The agent's name for the conversation, which the list shows. */
  async rename(id: string, title: string) {
    await this.meta.run(
      "UPDATE ask_conversations SET title=? WHERE id=?",
      title.slice(0, 200),
      id,
    );
  }

  async saveOffer(agent: AskAgentId, offer: AskOffer) {
    await this.meta.run(
      "INSERT INTO ask_agent_offers(agent, offer) VALUES(?, ?) ON CONFLICT(agent) DO UPDATE SET offer=excluded.offer",
      agent,
      JSON.stringify(offer),
    );
    await this.saveModelOffer(agent, offer);
  }

  /** Keeps what the agent offers with the offer's model, without making
   * it what the agent offered last. */
  async saveModelOffer(agent: AskAgentId, offer: AskOffer) {
    const model = offer.choices.model?.current;

    if (!model) return;
    await this.meta.run(
      "INSERT INTO ask_agent_model_offers(agent, model, offer) VALUES(?, ?, ?) ON CONFLICT(agent,model) DO UPDATE SET offer=excluded.offer",
      agent,
      model,
      JSON.stringify(offer),
    );
  }

  /** What the agent offered last, or last with the model given. */
  async offer(
    agent: AskAgentId,
    model?: string,
  ): Promise<AskOffer | undefined> {
    const row = z
      .object({ offer: z.string() })
      .safeParse(
        model === undefined
          ? await this.meta.get(
              "SELECT offer FROM ask_agent_offers WHERE agent=?",
              agent,
            )
          : await this.meta.get(
              "SELECT offer FROM ask_agent_model_offers WHERE agent=? AND model=?",
              agent,
              model,
            ),
      ).data;

    return row && askOfferSchema.safeParse(JSON.parse(row.offer)).data;
  }

  async touch(id: string, at = new Date().toISOString()) {
    await this.meta.run(
      "UPDATE ask_conversations SET updated_at=? WHERE id=?",
      at,
      id,
    );
  }

  /** Newest first. */
  async list(reviewId: string): Promise<AskHistoryEntry[]> {
    const rows = await this.meta.all(
      "SELECT * FROM ask_conversations WHERE review_id=? ORDER BY updated_at DESC",
      reviewId,
    );

    return rows.map((row) => {
      const {
        reviewId: _reviewId,
        sessionId: _sessionId,
        version: _version,
        cwd: _cwd,
        entries,
        bypass: _bypass,
        ...entry
      } = rowSchema.parse(row);

      const question = entries?.find((entry) => entry.kind === "user")?.text;

      if (question?.trim()) entry.question = question;

      return entry;
    });
  }

  async get(id: string): Promise<AskRecord | undefined> {
    const row = await this.meta.get(
      "SELECT * FROM ask_conversations WHERE id=?",
      id,
    );

    return row ? rowSchema.parse(row) : undefined;
  }

  async delete(id: string) {
    await this.meta.run("DELETE FROM ask_conversations WHERE id=?", id);
  }
}
