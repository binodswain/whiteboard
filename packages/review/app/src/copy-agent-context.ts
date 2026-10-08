import type { AgentSelection } from "@review/agent-selection";
import { z } from "zod";

import { copyText } from "./copy-text";
import type { ReviewSession } from "./host/review-session";

/** Copies a selection as the Markdown an agent reads; throws when it can't. */
export async function copyAgentContext(
  session: ReviewSession,
  selection: AgentSelection,
): Promise<void> {
  let text: string;

  try {
    const response = await session.fetch("/copy-context", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(selection),
    });

    if (!response.ok) throw new Error("Context unavailable");

    ({ text } = z.object({ text: z.string() }).parse(await response.json()));
  } catch (error) {
    if (session.config.surface !== "web") throw error;

    // Public/browser deployments may not expose the desktop context endpoint.
    // Preserve the selected target as portable context rather than failing.
    text = [
      "## Selected review context",
      "",
      "```json",
      JSON.stringify(selection, null, 2),
      "```",
    ].join("\n");
  }

  if (!(await copyText(text))) throw new Error("Clipboard unavailable");
}
