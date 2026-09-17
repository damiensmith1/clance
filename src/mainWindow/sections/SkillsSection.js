import { html, useEffect, useState } from "../../shared/vendor/preact-htm-standalone.module.js";
import { Toggle } from "../components/Toggle.js";

const TABS = [
  { id: "skills", label: "Skills" },
  { id: "mcp", label: "MCP servers" },
  { id: "tools", label: "Clance tools" },
];

// One row of the Tools lists. `toggle` is optional: skills have no per-skill
// switch at the CLI level (see skills.ts), so their rows render without one.
function ToolRow({ name, detail, description, tag, tagTone, toggle }) {
  return html`
    <div class="tool-row">
      <div class="tool-row-main">
        <span class="tool-row-name">${name}</span>
        ${description && html`<span class="tool-row-description">${description}</span>`}
        ${detail && html`<span class="tool-row-detail">${detail}</span>`}
      </div>
      ${tag && html`<span class="tool-row-tag ${tagTone ? `tool-row-tag-${tagTone}` : ""}">${tag}</span>`}
      ${toggle}
    </div>
  `;
}

export function SkillsSection() {
  const [tab, setTab] = useState("tools");
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

  // Optimistic, then reconciled with what the main process actually saved.
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

  const counts = { tools: localTools.length, mcp: servers.length, skills: skills.length };

  const serverHost = serverStatus?.url ? serverStatus.url.replace(/^https?:\/\//, "").replace(/\/.*$/, "") : null;
  const serverLine =
    serverStatus === null
      ? html`<span class="status-dot"></span><span class="tool-server-text">Checking the local tools server…</span>`
      : serverStatus.running
        ? html`<span class="status-dot status-dot-ok"></span>
            <span class="tool-server-text">Local tools server is running</span>
            <span class="mono-label">${serverHost}</span>`
        : html`<span class="status-dot"></span>
            <span class="tool-server-text">Local tools server starts when a session opens</span>`;

  return html`
    <div class="section-page">
      <header class="page-header">
        <h1 class="page-title">Tools</h1>
        <span class="page-meta">what sessions can do on this Mac</span>
      </header>

      <div class="tabs tools-tabs" role="tablist" aria-label="Tool type">
        ${TABS.map(
          (t) => html`
            <button
              role="tab"
              aria-selected=${tab === t.id}
              class="tabs-item ${tab === t.id ? "tabs-item-active" : ""}"
              onClick=${() => setTab(t.id)}
            >
              ${t.label}<span class="tabs-count">${counts[t.id]}</span>
            </button>
          `
        )}
      </div>

      ${tab === "tools" &&
      html`
        <div class="tool-server">
          ${serverLine}
          <span class="tool-server-spacer"></span>
          ${health &&
          html`<span class="status status-plain ${health.ok ? "status-ok" : "status-danger"}">${health.detail.toLowerCase()}</span>`}
          <button class="btn-quiet btn-small" onClick=${handleCheckHealth} disabled=${checkingHealth}>
            ${checkingHealth ? "Checking…" : "Check"}
          </button>
        </div>
        ${loadingLocalTools
          ? html`<p class="empty-note">Loading tools…</p>`
          : html`
              <div class="tool-list">
                ${localTools.map(
                  (tool) => html`
                    <${ToolRow}
                      key=${tool.name}
                      name=${tool.name}
                      description=${tool.description}
                      tag=${tool.tier === "auto" ? "no prompt" : "asks first"}
                      tagTone=${tool.tier === "auto" ? null : "attention"}
                      toggle=${html`<${Toggle}
                        checked=${tool.enabled}
                        label=${tool.name}
                        onChange=${(enabled) => handleLocalToolToggle(tool.name, enabled)}
                      />`}
                    />
                  `
                )}
              </div>
            `}
        <p class="section-note">
          Off means sessions can't use the tool at all. "Asks first" tools still need your OK the
          first time in each session.
        </p>
      `}

      ${tab === "mcp" &&
      html`
        ${loadingServers
          ? html`<p class="empty-note">Loading servers…</p>`
          : servers.length === 0
            ? html`<p class="empty-note">
                No MCP servers yet. Add them to <code>~/.clance/mcp.json</code>, in the same shape as
                Claude Code's <code>.mcp.json</code>.
              </p>`
            : html`
                <div class="tool-list">
                  ${servers.map(
                    (server) => html`
                      <${ToolRow}
                        key=${server.name}
                        name=${server.name}
                        detail=${server.config.type === "stdio" || !server.config.type
                          ? [server.config.command, ...(server.config.args ?? [])].join(" ")
                          : server.config.url}
                        toggle=${html`<${Toggle}
                          checked=${server.enabled}
                          label=${server.name}
                          onChange=${(enabled) => handleServerToggle(server.name, enabled)}
                        />`}
                      />
                    `
                  )}
                </div>
                <p class="section-note">Servers are read from <code>~/.clance/mcp.json</code>.</p>
              `}
      `}

      ${tab === "skills" &&
      html`
        ${loadingSkills
          ? html`<p class="empty-note">Loading skills…</p>`
          : skills.length === 0
            ? html`<p class="empty-note">No skills in <code>~/.claude/skills/</code>.</p>`
            : html`
                <div class="tool-list">
                  ${skills.map(
                    (skill) => html`
                      <${ToolRow} key=${skill.name} name=${skill.name} description=${skill.description} />
                    `
                  )}
                </div>
              `}
        <p class="section-note">
          Every session reads <code>~/.claude/skills/</code>, like any Claude Code session. Add or
          remove a skill's folder there to change what's available.
        </p>
      `}
    </div>
  `;
}
