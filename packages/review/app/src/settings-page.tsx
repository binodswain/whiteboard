import { Button } from "@canvas/ui/button";
import { textStyles } from "@canvas/ui/text";
import type {
  ReviewCanvasSettingsContent,
  ReviewCliInstallStatus,
  ReviewCtrlTabChoice,
  ReviewDocumentWidthChoice,
  ReviewKeymapChoice,
  ReviewReadyNotificationChoice,
  ReviewThemeChoice,
} from "@dev.fast/review-protocol";
import * as stylex from "@stylexjs/stylex";
import {
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { AccessTokensSection } from "./access-tokens-section";
import { ConnectCard, LegacySkillsRow } from "./connect-card";
import { DiffrConfigSection } from "./diffr-config-section";
import { homeStyles } from "./home-styles";
import { Choice } from "./settings-choice";
import { settingsStyles as styles } from "./settings-styles";
import { withClass } from "./stylex-props";
import { TraceCaptureSection } from "./trace-capture-section";

const THEME_LABELS: Record<ReviewThemeChoice, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

const KEYMAP_LABELS: Record<ReviewKeymapChoice, string> = {
  none: "Default",
  vim: "Vim",
  emacs: "Emacs",
  sublime: "Sublime Text",
};

const CTRL_TAB_LABELS: Record<ReviewCtrlTabChoice, string> = {
  recent: "Last used tab",
  next: "Next tab",
};

const DOCUMENT_WIDTH_LABELS: Record<ReviewDocumentWidthChoice, string> = {
  standard: "Standard",
  wide: "Wide",
  full: "Full",
};

const CODE_FONT_SIZES = [11, 12, 13, 14, 16];

// A size set elsewhere, such as one imported from VS Code, gets its own segment.
function codeFontSizeLabels(current: number) {
  const sizes = [...new Set([...CODE_FONT_SIZES, current])].sort(
    (left, right) => left - right,
  );

  return Object.fromEntries(sizes.map((size) => [String(size), String(size)]));
}

const READY_NOTIFICATION_LABELS: Record<ReviewReadyNotificationChoice, string> =
  {
    notificationAndBadge: "Notification and badge",
    notification: "Notification only",
    off: "Off",
  };

/**
 * The Settings page. It opens from the application menu (Preferences →
 * Settings...), the command palette, or ⌘,. Reuses the Home page shell so the
 * surfaces read as one app.
 *
 * The workbench owns every value here. Each setter resolves with the value that
 * landed, so a row shows the real state rather than an optimistic one.
 */
export function SettingsPage({
  settings,
  web = false,
  onBack,
}: {
  settings: ReviewCanvasSettingsContent;
  web?: boolean;
  onBack?(): void;
}) {
  const [telemetryEnabled, setTelemetryEnabled] = useState(
    settings.telemetryEnabled,
  );

  const [theme, setTheme] = useState(settings.theme);
  const [keymap, setKeymap] = useState(settings.keymap);
  const [ctrlTab, setCtrlTab] = useState(settings.ctrlTab);
  const [documentWidth, setDocumentWidth] = useState(settings.documentWidth);
  const [codeFontSize, setCodeFontSize] = useState(settings.codeFontSize);

  const [readyNotification, setReadyNotification] = useState(
    settings.readyNotification,
  );

  const [softwareMapEnabled, setSoftwareMapEnabled] = useState(
    settings.softwareMapEnabled,
  );

  const [structuralDiffEnabled, setStructuralDiffEnabled] = useState(
    settings.structuralDiffEnabled,
  );

  const [scratchpadEnabled, setScratchpadEnabled] = useState(
    settings.scratchpadEnabled,
  );

  const [installStatus, setInstallStatus] = useState<
    ReviewCliInstallStatus | undefined
  >(settings.install?.status);

  // Each setting reports its own save: only that row shows it is saving, and
  // a failure is explained beside it with its last saved value kept.
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());

  useEffect(
    () => setInstallStatus(settings.install?.status),
    [settings.install?.status],
  );

  const install =
    settings.install && installStatus
      ? { ...settings.install, status: installStatus }
      : settings.install;

  // Controls stay enabled while a save runs so keyboard focus is not dropped;
  // a second change to the same setting waits for the first instead.
  const inFlight = useRef(new Set<string>());

  const run = async <T,>(
    key: string,
    action: () => Promise<T>,
    adopt: (value: T) => void,
  ) => {
    if (inFlight.current.has(key)) return;

    inFlight.current.add(key);
    setPending((current) => new Set(current).add(key));
    setErrors((current) => {
      const next = new Map(current);

      next.delete(key);

      return next;
    });

    try {
      adopt(await action());
    } catch (cause) {
      setErrors((current) =>
        new Map(current).set(
          key,
          cause instanceof Error ? cause.message : String(cause),
        ),
      );
    } finally {
      inFlight.current.delete(key);
      setPending((current) => {
        const next = new Set(current);

        next.delete(key);

        return next;
      });
    }
  };

  const rowStatus = useMemo(() => ({ pending, errors }), [pending, errors]);

  return (
    <RowStatusContext.Provider value={rowStatus}>
      <main {...withClass("review-home", homeStyles.page)}>
        <div {...stylex.props(homeStyles.scroll)}>
          <div {...stylex.props(homeStyles.content, styles.page)}>
            <div {...stylex.props(homeStyles.header)}>
              <h1 {...stylex.props(homeStyles.heading)}>Settings</h1>
              {web && onBack ? (
                <Button variant="ghost" onClick={onBack} aria-label="Go back">
                  Back
                </Button>
              ) : null}
            </div>
            <p {...stylex.props(styles.lede)}>
              {web
                ? "Settings are saved on this Whiteboard server and shared by everyone who uses it."
                : "Settings apply to Whiteboard on this machine."}
            </p>

            {!web && install ? (
              <Section label="Agents">
                <LegacySkillsRow
                  install={install}
                  onStatusChange={setInstallStatus}
                />
                <ConnectCard install={install} />
              </Section>
            ) : null}

            {!web && install?.status.cli ? (
              <Section label="Command line">
                <Row
                  rowKey="command"
                  label="whiteboard command"
                  description={
                    install.status.shim.installed
                      ? `Installed at ${install.status.shim.path}. Your agents and trace capture run it.`
                      : "Adds whiteboard to your shell PATH. Your agents and trace capture run it."
                  }
                >
                  {install.status.shim.installer ? null : (
                    <Button
                      onClick={() =>
                        void run(
                          "command",
                          () =>
                            install.status.shim.installed
                              ? install.remove({ shim: true })
                              : install.apply({ shim: true }),
                          setInstallStatus,
                        )
                      }
                    >
                      {install.status.shim.installed ? "Remove" : "Install"}
                    </Button>
                  )}
                </Row>
              </Section>
            ) : null}

            {settings.accessTokens ? (
              <Section label="API tokens">
                <AccessTokensSection tokens={settings.accessTokens} />
              </Section>
            ) : null}

            {!web ? (
              <Section label="Privacy">
                <Row
                  rowKey="telemetry"
                  controlId="setting-telemetry"
                  label="Share anonymous usage data"
                  description="Counts and timings only. Never code, file paths, or repository names."
                >
                  <label
                    {...stylex.props(styles.toggle)}
                    aria-label="Share anonymous usage data"
                  >
                    <input
                      id="setting-telemetry"
                      {...stylex.props(styles.checkbox)}
                      type="checkbox"
                      checked={telemetryEnabled}
                      onChange={(event) => {
                        const enabled = event.target.checked;
                        void run(
                          "telemetry",
                          () => settings.setTelemetryEnabled(enabled),
                          setTelemetryEnabled,
                        );
                      }}
                    />
                  </label>
                </Row>
              </Section>
            ) : null}

            <Section label="Editor">
              <Row
                rowKey="theme"
                label="Theme"
                description="How Whiteboard looks."
              >
                <Choice
                  label="Theme"
                  value={theme}
                  labels={THEME_LABELS}
                  onChange={(choice) =>
                    void run("theme", () => settings.setTheme(choice), setTheme)
                  }
                />
              </Row>
              <Row
                rowKey="document-width"
                label="Document width"
                description="Wide and Full give diagrams and code more room. Text keeps a reading width."
              >
                <Choice
                  label="Document width"
                  value={documentWidth}
                  labels={DOCUMENT_WIDTH_LABELS}
                  onChange={(choice) =>
                    void run(
                      "document-width",
                      () => settings.setDocumentWidth(choice),
                      setDocumentWidth,
                    )
                  }
                />
              </Row>
              <Row
                rowKey="code-font-size"
                label="Code font size"
                description="Text size in diffs, code peeks, and source tabs."
              >
                <Choice
                  label="Code font size"
                  value={String(codeFontSize)}
                  labels={codeFontSizeLabels(codeFontSize)}
                  onChange={(choice) =>
                    void run(
                      "code-font-size",
                      () => settings.setCodeFontSize(Number(choice)),
                      setCodeFontSize,
                    )
                  }
                />
              </Row>
              {!web ? (
                <Row
                  rowKey="keymap"
                  label="Keymap"
                  description="Vim, Emacs, and Sublime Text keys come from a bundled extension. A change needs a reload."
                >
                  <Choice
                    label="Keymap"
                    value={keymap}
                    labels={KEYMAP_LABELS}
                    onChange={(choice) => {
                      void run(
                        "keymap",
                        () => settings.setKeymap(choice),
                        setKeymap,
                      );
                    }}
                  />
                </Row>
              ) : null}
              {!web ? (
                <Row
                  rowKey="ctrl-tab"
                  label="Ctrl+Tab"
                  description="Jump back to the last used tab, or step through the tab bar."
                >
                  <Choice
                    label="Ctrl+Tab"
                    value={ctrlTab}
                    labels={CTRL_TAB_LABELS}
                    onChange={(choice) =>
                      void run(
                        "ctrl-tab",
                        () => settings.setCtrlTab(choice),
                        setCtrlTab,
                      )
                    }
                  />
                </Row>
              ) : null}
            </Section>

            {!web ? (
              <Section label="Notifications">
                <Row
                  rowKey="ready-notification"
                  label="Review ready"
                  description="When an agent finishes a review you aren't looking at."
                >
                  <Choice
                    label="Review ready"
                    value={readyNotification}
                    labels={READY_NOTIFICATION_LABELS}
                    onChange={(choice) =>
                      void run(
                        "ready-notification",
                        () => settings.setReadyNotification(choice),
                        setReadyNotification,
                      )
                    }
                  />
                </Row>
              </Section>
            ) : null}

            {!web ? (
              <Section label="Tools">
                <Row
                  label="Extensions"
                  description="Install or turn on language extensions."
                >
                  <Button onClick={settings.manageExtensions}>Manage…</Button>
                </Row>
                <Row
                  label="VS Code settings"
                  description="Copy settings and keybindings from VS Code or Cursor again. Replaces Whiteboard's."
                >
                  <Button onClick={settings.importVsCodeSettings}>
                    Import…
                  </Button>
                </Row>
              </Section>
            ) : null}

            <Section label="Experimental Features">
              <Row
                rowKey="structural-diff"
                controlId="setting-structural-diff"
                label="Structural Diffs"
                description="Replace the standard diff view with syntax-aware diffs and linked folds."
              >
                <label {...stylex.props(styles.toggle)}>
                  <input
                    id="setting-structural-diff"
                    {...stylex.props(styles.checkbox)}
                    type="checkbox"
                    aria-label="Structural Diffs"
                    checked={structuralDiffEnabled}
                    onChange={(event) => {
                      const enabled = event.target.checked;
                      void run(
                        "structural-diff",
                        () => settings.setStructuralDiffEnabled(enabled),
                        setStructuralDiffEnabled,
                      );
                    }}
                  />
                </label>
              </Row>
              {structuralDiffEnabled ? (
                settings.diffrConfigAvailable === false ? (
                  <Row
                    label="Summaries"
                    description="Diffr configuration is managed by the server operator."
                  >
                    <span aria-label="Managed by the server operator">
                      Server-managed
                    </span>
                  </Row>
                ) : (
                  <DiffrConfigSection
                    actions={settings.diffrConfig}
                    reloadWindow={settings.reloadWindow}
                  />
                )
              ) : null}
              {!web && install ? (
                <TraceCaptureSection
                  install={install}
                  onStatusChange={setInstallStatus}
                />
              ) : null}
              <Row
                rowKey="software-map"
                controlId="setting-software-map"
                label="Software Map"
                description="Show the experimental Software Map view in sessions."
              >
                <label {...stylex.props(styles.toggle)}>
                  <input
                    id="setting-software-map"
                    {...stylex.props(styles.checkbox)}
                    type="checkbox"
                    aria-label="Software Map"
                    checked={softwareMapEnabled}
                    onChange={(event) => {
                      const enabled = event.target.checked;
                      void run(
                        "software-map",
                        () => settings.setSoftwareMapEnabled(enabled),
                        setSoftwareMapEnabled,
                      );
                    }}
                  />
                </label>
              </Row>
              <Row
                rowKey="scratchpad"
                controlId="setting-scratchpad"
                label="Scratchpad"
                description="Show the experimental scratchpad on Home. Agents draw on it through Whiteboard's MCP tools."
              >
                <label {...stylex.props(styles.toggle)}>
                  <input
                    id="setting-scratchpad"
                    {...stylex.props(styles.checkbox)}
                    type="checkbox"
                    aria-label="Scratchpad"
                    checked={scratchpadEnabled}
                    onChange={(event) => {
                      const enabled = event.target.checked;
                      void run(
                        "scratchpad",
                        () => settings.setScratchpadEnabled(enabled),
                        setScratchpadEnabled,
                      );
                    }}
                  />
                </label>
              </Row>
            </Section>
          </div>
        </div>
      </main>
    </RowStatusContext.Provider>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section {...stylex.props(styles.section)} aria-label={label}>
      <h2 {...stylex.props(textStyles.eyebrow, styles.sectionLabel)}>
        {label}
      </h2>
      {children}
    </section>
  );
}

const RowStatusContext = createContext<{
  pending: ReadonlySet<string>;
  errors: ReadonlyMap<string, string>;
}>({ pending: new Set(), errors: new Map() });

function Row({
  label,
  description,
  rowKey,
  controlId,
  children,
}: {
  label: string;
  description: string;
  rowKey?: string;
  controlId?: string;
  children: ReactNode;
}) {
  const status = useContext(RowStatusContext);
  const saving = rowKey !== undefined && status.pending.has(rowKey);
  const error = rowKey === undefined ? undefined : status.errors.get(rowKey);

  return (
    <div {...stylex.props(styles.row)}>
      <div {...stylex.props(styles.rowText)}>
        {controlId ? (
          <label htmlFor={controlId} {...stylex.props(styles.rowLabel)}>
            {label}
          </label>
        ) : (
          <span {...stylex.props(styles.rowLabel)}>{label}</span>
        )}
        <span {...stylex.props(styles.rowDescription)}>{description}</span>
        {saving ? (
          <span role="status" {...stylex.props(styles.rowDescription)}>
            Saving…
          </span>
        ) : null}
        {error ? (
          <span role="alert" {...stylex.props(styles.error)}>
            Could not save {label}: {error}
          </span>
        ) : null}
      </div>
      <div {...stylex.props(styles.rowControl)}>{children}</div>
    </div>
  );
}
