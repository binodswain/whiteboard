# Review

Review lets authors explain code changes against specific source revisions.

## Language

**Headless authoring**:
Creating and editing a Review without installing or running the desktop application, including from a CI job.

**Session**:
The user-facing name for a Review: an agent-populated review workspace listed on the home page. UI copy says Session; code, APIs, and `/r/:id` URLs say review.

**Scratchpad**:
A Session with no repository of its own.

**Surface**:
The host environment the canvas renders in: `desktop` (the workbench app) or `web` (the browser bundle). Chrome and navigation differ per surface.

**Canvas**:
The shared review UI that either surface mounts — it renders Home, a Session, Settings, Welcome, and loading/error states.
