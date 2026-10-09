import { z } from "zod";

export const reviewTagSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9][a-z0-9._/-]{0,39}$/,
    "Tags are 1 to 40 letters, digits, dots, slashes, dashes or underscores, starting with a letter or digit.",
  );

/** Query and tool filters. Unknown keys are dropped, so a query may carry
 * other parameters such as `mode`. */
export const reviewFilterSchema = z.object({
  repo: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  commit: z
    .string()
    .regex(/^[0-9a-f]{4,40}$/i, "commit must be 4 to 40 hexadecimal digits.")
    .transform((commit) => commit.toLowerCase())
    .optional(),
  author: z.string().min(1).optional(),
  tag: reviewTagSchema.optional(),
});

export type ReviewFilter = z.infer<typeof reviewFilterSchema>;

/** Filters a summary already in hand, for reviews the local table cannot
 * answer for, such as shared imports. Matches the SQL the store builds. */
export function matchesReviewFilter(
  review: {
    repositoryName?: string;
    pins?: { repositoryId: string; base: string; head: string };
    origin?: { branch?: string };
    createdBy?: string;
    tags?: string[];
  },
  filter: ReviewFilter,
): boolean {
  if (
    filter.repo !== undefined &&
    review.repositoryName !== filter.repo &&
    review.pins?.repositoryId !== filter.repo
  )
    return false;

  if (filter.branch !== undefined && review.origin?.branch !== filter.branch)
    return false;

  if (
    filter.commit !== undefined &&
    !review.pins?.head.startsWith(filter.commit) &&
    !review.pins?.base.startsWith(filter.commit)
  )
    return false;

  if (filter.author !== undefined && review.createdBy !== filter.author)
    return false;

  if (filter.tag !== undefined && !review.tags?.includes(filter.tag))
    return false;

  return true;
}
