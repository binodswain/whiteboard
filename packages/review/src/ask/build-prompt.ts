/** Preamble for the "build" purpose: tells an agent this is a new, empty
 * Whiteboard session and its job is to populate the board using the Whiteboard
 * tools, then report what it built.
 *
 * @param repoLabel  Optional human-readable name for the repository or review.
 *   When absent, the preamble still makes sense on its own.
 */
export function buildSessionPreamble(repoLabel?: string): string {
  const repoLine = repoLabel
    ? `The session is for the repository: ${repoLabel}.`
    : "";

  return [
    "This is a new, empty Whiteboard session.",
    repoLine,
    "Your task: populate the board using the Whiteboard MCP tools (session_get_instructions, session_edit, etc.) or the `whiteboard api` CLI as a fallback.",
    "After you have built the board, report a brief summary of what you created.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** Preamble plus the user's task text, separated by a blank line.
 *
 * @param text  The user's description of what to build / investigate.
 * @param repoLabel  Optional human-readable name for the repository or review.
 */
export function buildSessionPrompt(text: string, repoLabel?: string): string {
  const preamble = buildSessionPreamble(repoLabel);

  return text ? `${preamble}\n\n${text}` : preamble;
}
