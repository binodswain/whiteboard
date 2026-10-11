import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { ReviewDiffFileSchema } from "@dev.fast/review-protocol";
import { z } from "zod";

/** Caps on what one unattended run copies into its working directory. */
export const WORKDIR_LIMITS = {
  patchBytes: 2_000_000,
  fileBytes: 256_000,
  totalBytes: 8_000_000,
  files: 200,
};

/** Fetches a review route as the ask's own token and parses its JSON body. */
export type ReviewFetch = <T>(
  route: string,
  schema: z.ZodType<T>,
) => Promise<T>;

/** The /file route answers `{ text }`, or `{ binary: true }` with no text. */
const FileBody = z.looseObject({ text: z.string().optional() });

/**
 * Gives an unattended agent the pull request to read with its local tools:
 * `PR_DIFF.patch`, `CHANGED_FILES.txt`, and the changed files' head contents
 * under `head/`. Everything comes from the review, through the ask's token,
 * so the runner never needs repository credentials. Oversized or binary
 * files are listed but not copied.
 */
export async function writePullRequestContext(
  workdir: string,
  reviewId: string,
  fetchReview: ReviewFetch,
  limits = WORKDIR_LIMITS,
): Promise<void> {
  const base = `/${encodeURIComponent(reviewId)}`;

  const files = await fetchReview(
    `${base}/diff?patch=true`,
    z.array(ReviewDiffFileSchema),
  );

  let patch = files
    .map((file) => file.patch ?? "")
    .filter(Boolean)
    .join("\n");

  if (Buffer.byteLength(patch) > limits.patchBytes)
    patch =
      Buffer.from(patch).subarray(0, limits.patchBytes).toString() +
      "\n[diff truncated]\n";
  await writeFile(path.join(workdir, "PR_DIFF.patch"), patch);

  const listing: string[] = [];
  let total = 0;
  let copied = 0;
  const headDir = path.join(workdir, "head");

  for (const file of files) {
    const renamed = file.previousPath ? ` (from ${file.previousPath})` : "";
    let note = "";

    if (file.status === "deleted") {
      // Nothing to copy at the head.
    } else if (file.binary) note = " [binary, not copied]";
    else if (copied >= limits.files) note = " [not copied: file limit]";
    else {
      const target = path.join(headDir, file.path);

      // A path that escapes head/ is listed, never written.
      if (!target.startsWith(headDir + path.sep)) note = " [not copied]";
      else {
        const body = await fetchReview(
          `${base}/file?side=head&file=${encodeURIComponent(file.path)}`,
          FileBody,
        ).catch(() => undefined);

        const text = body?.text;
        const size = text === undefined ? 0 : Buffer.byteLength(text);

        if (text === undefined) note = " [not copied]";
        else if (size > limits.fileBytes) note = " [too large, not copied]";
        else if (total + size > limits.totalBytes)
          note = " [not copied: size limit]";
        else {
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, text);
          total += size;
          copied++;
        }
      }
    }

    listing.push(
      `${file.status}\t+${file.additions} -${file.deletions}\t${file.path}${renamed}${note}`,
    );
  }

  await writeFile(
    path.join(workdir, "CHANGED_FILES.txt"),
    listing.join("\n") + "\n",
  );
}
