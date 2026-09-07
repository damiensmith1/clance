import { html, useEffect, useState } from "../../shared/vendor/preact-htm-standalone.module.js";
import { Icon } from "../../shared/icons.js";
import { Toggle } from "../components/Toggle.js";

const TABS = [
  { id: "all", label: "All Extensions" },
  { id: "skills", label: "Skills" },
  { id: "mcp", label: "MCP Servers" },
  { id: "tools", label: "Custom Tools", planned: true },
];

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
        <${Toggle} checked=${enabled} onChange=${onToggle} />
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

  useEffect(() => {
    window.clanceApp.listSkills().then((result) => {
      setSkills(result);
      setLoadingSkills(false);
    });
    window.clanceApp.listMcpServers().then((result) => {
      setServers(result);
      setLoadingServers(false);
    });
  }, []);

  function handleSkillToggle(name, enabled) {
    setSkills((current) =>
      current.map((skill) => (skill.name === name ? { ...skill, enabled } : skill))
    );
    window.clanceApp.setSkillEnabled(name, enabled).then(setSkills);
  }

  function handleServerToggle(name, enabled) {
    setServers((current) =>
      current.map((server) => (server.name === name ? { ...server, enabled } : server))
    );
    window.clanceApp.setMcpServerEnabled(name, enabled).then(setServers);
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
                    enabled=${skill.enabled}
                    onToggle=${(enabled) => handleSkillToggle(skill.name, enabled)}
                  />
                `
              )}
        </section>
      `}
      ${showServers &&
      html`
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
      html`<p class="empty-note">Custom tools are planned but not built yet.</p>`}
    </div>
  `;
}
