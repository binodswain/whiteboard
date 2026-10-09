import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  type MetadataStore,
  type MetadataStoreConfig,
  createMetadataStore,
} from "./metadata-store.js";

const stores: MetadataStore[] = [];

const dirs: string[] = [];

const open = async (config: MetadataStoreConfig) => {
  const store = await createMetadataStore(config);
  stores.push(store);

  return store;
};

const sqliteFile = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "metadata-store-"));
  dirs.push(dir);

  return path.join(dir, "test.db");
};

afterAll(async () => {
  for (const store of stores) await store.close().catch(() => {});

  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** The contract every backend keeps. `shared` tells whether a second store
 * opened on the same config sees the first store's data — false for
 * `:memory:`, true for files and remote URLs. Table names are suffixed so a
 * persistent database can be retested without collisions. */
const suite = (
  describeImpl: (name: string, fn: () => void) => void,
  name: string,
  config: MetadataStoreConfig,
  shared: boolean,
) => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const table = (base: string) => `${base}_${suffix}`;
  const sharedIt = shared ? it : it.skip;

  describeImpl(name, () => {
    it("runs DDL, writes and reads rows, and reports change counts", async () => {
      const store = await open(config);
      const items = table("items");

      await store.exec(
        `CREATE TABLE ${items}(id TEXT PRIMARY KEY, amount INTEGER)`,
      );

      expect(
        (await store.run(`INSERT INTO ${items} VALUES(?,?)`, "a", 41)).changes,
      ).toBe(1);

      expect(
        await store.get(`SELECT * FROM ${items} WHERE id=?`, "a"),
      ).toMatchObject({ amount: 41 });
      expect(
        (await store.all(`SELECT * FROM ${items}`)).map((row) => row.id),
      ).toEqual(["a"]);

      expect(
        (await store.run(`UPDATE ${items} SET amount=? WHERE id=?`, 42, "a"))
          .changes,
      ).toBe(1);
      expect(
        (
          await store.run(
            `UPDATE ${items} SET amount=? WHERE id=?`,
            43,
            "missing",
          )
        ).changes,
      ).toBe(0);
      expect(
        await store.get(`SELECT * FROM ${items} WHERE id=?`, "missing"),
      ).toBeUndefined();
    });

    it("commits and rolls back transactions, joining nested calls", async () => {
      const store = await open(config);
      const items = table("items_tx");
      await store.exec(`CREATE TABLE ${items}(id TEXT PRIMARY KEY)`);

      const nested = await store.transaction(async () => {
        await store.run(`INSERT INTO ${items} VALUES(?)`, "outer");

        return store.transaction(async () => {
          await store.run(`INSERT INTO ${items} VALUES(?)`, "inner");

          return "done";
        });
      });

      expect(nested).toBe("done");
      expect(await store.all(`SELECT * FROM ${items}`)).toHaveLength(2);

      await expect(
        store.transaction(async () => {
          await store.run(`INSERT INTO ${items} VALUES(?)`, "rolled-back");
          throw new Error("abort");
        }),
      ).rejects.toThrow("abort");

      expect(
        await store.all(`SELECT id FROM ${items} WHERE id=?`, "rolled-back"),
      ).toEqual([]);
    });

    it("serializes concurrent writers without losing commits", async () => {
      const store = await open(config);
      const counter = table("counter");
      await store.exec(
        `CREATE TABLE ${counter}(id TEXT PRIMARY KEY, n INTEGER NOT NULL)`,
      );
      await store.run(`INSERT INTO ${counter} VALUES('c', 0)`);

      const bump = () =>
        store.transaction(async () => {
          const row = await store.get(`SELECT n FROM ${counter} WHERE id='c'`);
          await store.run(
            `UPDATE ${counter} SET n=? WHERE id='c'`,
            Number(row?.n) + 1,
          );
        });

      await Promise.all(Array.from({ length: 10 }, bump));

      expect(await store.get(`SELECT n FROM ${counter} WHERE id='c'`)).toEqual({
        n: 10,
      });
    });

    it("answers the dialect helpers", async () => {
      const store = await open(config);
      const docs = table("docs");
      const d = store.dialect;
      await store.exec(`CREATE TABLE ${docs}(id TEXT PRIMARY KEY, value TEXT)`);
      await store.run(
        `INSERT INTO ${docs} VALUES(?,?)`,
        "d1",
        JSON.stringify({ reviewId: "r1", flag: true, name: "alpha" }),
      );

      expect(
        await store.get(
          `SELECT ${d.jsonText("value", "reviewId")} AS rid FROM ${docs}`,
        ),
      ).toMatchObject({ rid: "r1" });

      const stripped = await store.get(
        `SELECT ${d.jsonWithout("value", "flag")} AS v FROM ${docs}`,
      );

      expect(JSON.parse(String(stripped?.v))).toEqual({
        reviewId: "r1",
        name: "alpha",
      });

      expect(
        await store.get(
          `SELECT 1 AS hit FROM ${docs} WHERE ${d.jsonFlag("value", "flag")}`,
        ),
      ).toMatchObject({ hit: 1 });

      expect(
        await store.all(
          `SELECT id FROM ${docs} WHERE ${d.containsText("value")}`,
          "alph",
        ),
      ).toEqual([{ id: "d1" }]);
    });

    sharedIt("surfaces commits another connection made", async () => {
      const first = await open(config);
      const second = await open(config);
      const items = table("items_shared");
      await first.exec(`CREATE TABLE ${items}(id TEXT PRIMARY KEY)`);

      const before = await first.dataVersion();
      await second.run(`INSERT INTO ${items} VALUES('x')`);

      // Postgres reports the commit count through stats that flush
      // asynchronously, so poll rather than read once.
      await expect
        .poll(() => first.dataVersion(), { timeout: 5000, interval: 50 })
        .not.toBe(before);
    });
  });
};

suite(describe, "sqlite", { kind: "sqlite", dir: sqliteFile() }, true);

suite(describe, "sqlite in-memory", { kind: "sqlite", dir: ":memory:" }, false);

suite(
  process.env.TEST_POSTGRES_URL ? describe : describe.skip,
  "postgres",
  { kind: "postgres", url: process.env.TEST_POSTGRES_URL ?? "" },
  true,
);

describe("sqlite file reopen", () => {
  it("keeps an existing file's rows across reopens", async () => {
    const dir = sqliteFile();
    const items = "reopen_items";

    const first = await open({ kind: "sqlite", dir });
    await first.exec(`CREATE TABLE ${items}(id TEXT PRIMARY KEY)`);
    await first.run(`INSERT INTO ${items} VALUES('persisted')`);
    await first.close();

    const reopened = await open({ kind: "sqlite", dir });
    expect(await reopened.all(`SELECT id FROM ${items}`)).toEqual([
      { id: "persisted" },
    ]);
  });
});
