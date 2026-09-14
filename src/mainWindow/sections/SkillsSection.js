import { html, useEffect, useState } from "../../shared/vendor/preact-htm-standalone.module.js";
import { Icon } from "../../shared/icons.js";
import { Toggle } from "../components/Toggle.js";

const TABS = [
  { id: "all", label: "All Extensions" },
  { id: "skills", label: "Skills" },
  { id: "mcp", label: "MCP Servers" },
  { id: "tools", label: "Custom Tools" },
];

// onToggle is optional — omit it (see the Skills list below) to render a
// plain, non-interactive card with no Toggle at all, for extensions Clance
// has no way to actually gate (see skills.ts's read-only note).
function ExtensionCard({ icon, title, subtitle, description, enabled, onToggle }) {
  return html`
    <div class="item-card item-card-static">
      <span class="item-card-icon item-card-icon-accent">${icon}</span>
      <span class="item-card-body">
        <span class="item-card-title">${title}</span>
        ${subtitle && html`<span class="pill pill-mono">${subtitle}</span>`}
        ${description && html`<span class="item-card-description">${description}</span>`}
      </span>
      <span class="item-card-actions">
        ${onToggle && html`<${Toggle} checked=${enabled} onChange=${onToggle} />`}
        <span class="icon-button">${Icon.moreVertical(16)}</span>
      </span>
    </div>
  `;
}

export function SkillsSection() {
  const [tab, setTab] = useState("all");
  const [skills, setSkills] = useState([]);
  const [loadingSkills, setLoadingSkills] = useState(true);
  const [servers, setServers] = useState([]);
  const [loadingServers, setLoadingServers] = useState(true);
  const [localTools, setLocalTools] = useState([]);
  const [loadingLocalTools, setLoadingLocalTools] = useState(true);
  const [serverStatus, setServerStatus] = useState(null);
  const [health, setHealth] = useState(null);
  const [checkingHealth, setCheckingHealth] = useState(false);

  useEffect(() => {
    window.clanceApp.listSkills().then((result) => {
      setSkills(result);
      setLoadingSkills(false);
    });
    window.clanceApp.listMcpServers().then((result) => {
      setServers(result);
      setLoadingServers(false);
    });
    window.clanceApp.listLocalTools().then((result) => {
      setLocalTools(result);
      setLoadingLocalTools(false);
    });
    window.clanceApp.localToolsServerStatus().then(setServerStatus);
  }, []);

  // The health check itself starts the server if it wasn't running yet
  // (see localToolsServer.ts's checkLocalToolsServerHealth), so re-reads
  // status afterward rather than assuming it's unchanged.
  function handleCheckHealth() {
    setCheckingHealth(true);
    setHealth(null);
    window.clanceApp.checkLocalToolsServerHealth().then((result) => {
      setHealth(result);
      setCheckingHealth(false);
      window.clanceApp.localToolsServerStatus().then(setServerStatus);
    });
  }

  function handleServerToggle(name, enabled) {
    setServers((current) =>
      current.map((server) => (server.name === name ? { ...server, enabled } : server))
    );
    window.clanceApp.setMcpServerEnabled(name, enabled).then(setServers);
  }

  function handleLocalToolToggle(name, enabled) {
    setLocalTools((current) =>
      current.map((tool) => (tool.name === name ? { ...tool, enabled } : tool))
    );
    window.clanceApp.setLocalToolEnabled(name, enabled).then(setLocalTools);
  }

  const showSkills = tab === "all" || tab === "skills";
  const showServers = tab === "all" || tab === "mcp";
  const showTools = tab === "tools";

  return html`
    <div class="section-page">
      <h1 class="page-title">Skills & Plugins</h1>
      <p class="page-subtitle">Extend Clance with specialized capabilities and external integrations.</p>

      <div class="segmented">
        ${TABS.map(
          (t) => html`
            <button
              class="segmented-item ${tab === t.id ? "segmented-item-active" : ""}"
              onClick=${() => setTab(t.id)}
            >
              ${t.label} ${t.planned && html`<span class="pill pill-muted">PLANNED</span>`}
            </button>
          `
        )}
      </div>

      ${showSkills &&
      html`
        <section class="extension-group">
          <h2 class="group-title">Skills</h2>
          <p class="page-subtitle">
            Read-only — every Clance-launched session already reads
            <code>~/.claude/skills/</code> directly, the same way any other <code>claude</code>
            session does. There's no per-skill on/off switch at the CLI level to hook a toggle
            to here, so add or remove a skill's folder there to change what's available.
          </p>
          ${loadingSkills
            ? html`<p class="empty-note">Loading…</p>`
            : skills.length === 0
            ? html`<p class="empty-note">
                No skills found in <code>~/.claude/skills/</code>.
              </p>`
            : skills.map(
                (skill) => html`
                  <${ExtensionCard}
                    icon=${Icon.markdown(18)}
                    title=${skill.name}
                    description=${skill.description}
                  />
                `
              )}
        </section>
      `}
      ${showServers &&
      html`
        <section class="extension-group">
          <h2 class="group-title">Clance's Local Tools Server</h2>
          <div class="item-card item-card-static">
            <span
              class="item-card-icon item-card-icon-accent"
              style=${{ color: serverStatus?.running ? "#3C6B40" : "#7A7267" }}
            >
              ${Icon.plug(18)}
            </span>
            <span class="item-card-body">
              <span class="item-card-title">clance-tools</span>
              <span class="pill pill-mono">
                ${serverStatus === null
                  ? "Checking…"
                  : serverStatus.running
                  ? serverStatus.url
                  : "Not started yet"}
              </span>
              <span class="item-card-description">
                Backs the Custom Tools below (screenshot, click, type) — starts automatically the
                first time a session opens, not something you configure directly.
              </span>
              ${health &&
              html`
                <span class="item-card-description">
                  <span class="status-dot ${health.ok ? "status-dot-ok" : "status-dot-off"}"></span>
                  ${health.detail}
                </span>
              `}
            </span>
            <span class="item-card-actions">
              <button class="btn-ghost" onClick=${handleCheckHealth} disabled=${checkingHealth}>
                ${checkingHealth ? "Checking…" : "Check Health"}
              </button>
            </span>
          </div>
        </section>
        <section class="extension-group">
          <div class="group-title-row">
            <h2 class="group-title">MCP Servers</h2>
            <button class="btn-ghost">${Icon.addServer(12)} Add Server</button>
          </div>
          ${loadingServers
            ? html`<p class="empty-note">Loading…</p>`
            : servers.length === 0
            ? html`<p class="empty-note">
                No MCP servers configured yet. Add entries to
                <code>~/.clance/mcp.json</code> (mirrors Claude Code's own
                <code>.mcp.json</code> shape) to see them here.
              </p>`
            : servers.map(
                (server) => html`
                  <${ExtensionCard}
                    icon=${Icon.plug(18)}
                    title=${server.name}
                    subtitle=${server.config.type === "stdio" || !server.config.type
                      ? [server.config.command, ...(server.config.args ?? [])].join(" ")
                      : server.config.url}
                    enabled=${server.enabled}
                    onToggle=${(enabled) => handleServerToggle(server.name, enabled)}
                  />
                `
              )}
        </section>
      `}
      ${showTools &&
      html`
        <section class="extension-group">
          <h2 class="group-title">Custom Tools</h2>
          <p class="page-subtitle">
            Clance's own tools for reading and acting on your screen — click, type, take a
            screenshot on demand. Turning one off makes the assistant unable to use it at all,
            not just unprompted; a tool marked "Asks first" still needs the CLI's own
            Allow/Deny/Always-allow prompt the first time each session even while it's on.
          </p>
          ${loadingLocalTools
            ? html`<p class="empty-note">Loading…</p>`
            : localTools.map(
                (tool) => html`
                  <${ExtensionCard}
                    icon=${Icon.sparkle(18)}
                    title=${tool.name}
                    subtitle=${tool.tier === "auto" ? "No prompt" : "Asks first"}
                    description=${tool.description}
                    enabled=${tool.enabled}
                    onToggle=${(enabled) => handleLocalToolToggle(tool.name, enabled)}
                  />
                `
              )}
        </section>
      `}
    </div>
  `;
}
