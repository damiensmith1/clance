import { html, useEffect, useState } from "../../shared/vendor/preact-htm-standalone.module.js";

function Toggle({ checked, onChange }) {
  return html`<input type="checkbox" checked=${checked} onChange=${(e) => onChange(e.target.checked)} />`;
}

function SkillsList({ skills, loading, onToggle }) {
  if (loading) return html`<p class="section-placeholder-note">Loading…</p>`;
  if (skills.length === 0) {
    return html`<p class="section-placeholder-note">
      No skills found in <code>~/.claude/skills/</code>.
    </p>`;
  }
  return html`
    <div class="extensibility-list">
      ${skills.map(
        (skill) => html`
          <div class="extensibility-row">
            <div class="extensibility-row-info">
              <span class="extensibility-row-name">${skill.name}</span>
              ${skill.description &&
              html`<span class="extensibility-row-description">${skill.description}</span>`}
            </div>
            <${Toggle}
              checked=${skill.enabled}
              onChange=${(enabled) => onToggle(skill.name, enabled)}
            />
          </div>
        `
      )}
    </div>
  `;
}

function McpServersList({ servers, loading, onToggle }) {
  if (loading) return html`<p class="section-placeholder-note">Loading…</p>`;
  if (servers.length === 0) {
    return html`<p class="section-placeholder-note">
      No MCP servers configured yet. Add entries to
      <code>~/.clance/mcp.json</code> (mirrors Claude Code's own
      <code>.mcp.json</code> shape) to see them here.
    </p>`;
  }
  return html`
    <div class="extensibility-list">
      ${servers.map(
        (server) => html`
          <div class="extensibility-row">
            <div class="extensibility-row-info">
              <span class="extensibility-row-name">${server.name}</span>
              <span class="extensibility-row-description">
                ${server.config.type === "stdio" || !server.config.type
                  ? [server.config.command, ...(server.config.args ?? [])].join(" ")
                  : server.config.url}
              </span>
            </div>
            <${Toggle}
              checked=${server.enabled}
              onChange=${(enabled) => onToggle(server.name, enabled)}
            />
          </div>
        `
      )}
    </div>
  `;
}

export function SkillsSection() {
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

  return html`
    <div class="section-skills">
      <h2>Skills & Plugins</h2>
      <section class="extensibility-group">
        <h3>Skills</h3>
        <${SkillsList} skills=${skills} loading=${loadingSkills} onToggle=${handleSkillToggle} />
      </section>
      <section class="extensibility-group">
        <h3>MCP Servers</h3>
        <${McpServersList}
          servers=${servers}
          loading=${loadingServers}
          onToggle=${handleServerToggle}
        />
      </section>
    </div>
  `;
}
