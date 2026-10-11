import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

/**
 * AES-256-GCM sealing for secrets kept in the metadata database, keyed by the
 * deployment's auth secret and a purpose, so a database dump alone cannot
 * read them and one purpose's ciphertext does not open as another's.
 */
export function createSealer(secret: string, purpose: string) {
  const key = createHash("sha256").update(`${secret}:${purpose}`).digest();

  const seal = (value: string): string => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);

    return `${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${data.toString("base64")}`;
  };

  /** The plaintext, or undefined for a value sealed under another key. */
  const unseal = (sealed: string): string | undefined => {
    const [iv, tag, data] = sealed
      .split(".")
      .map((part) => Buffer.from(part, "base64"));

    if (!iv?.length || !tag?.length || !data?.length) return undefined;

    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);

      return Buffer.concat([decipher.update(data), decipher.final()]).toString(
        "utf8",
      );
    } catch {
      return undefined;
    }
  };

  return { seal, unseal };
}
