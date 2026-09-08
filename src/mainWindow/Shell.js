import { html, useEffect, useState } from "../shared/vendor/preact-htm-standalone.module.js";
import { Icon } from "../shared/icons.js";
import { ChatsListSection } from "./sections/ChatsSection.js";
import { SkillsSection } from "./sections/SkillsSection.js";
import { SettingsSection } from "./sections/SettingsSection.js";
import { TerminalSection, nextTerminalId } from "./sections/TerminalSection.js";

const LAUNCHER_ITEMS = [
  { id: "chats", label: "Chats", icon: "chat" },
  { id: "skills", label: "Skills & Plugins", icon: "puzzle" },
  { id: "settings", label: "Settings", icon: "gear" },
];

const HOME_TAB = { id: "chats", type: "chats", label: "Chats", icon: "chat" };

function tabIcon(tab) {
  return Icon[tab.icon] ? Icon[tab.icon](15) : null;
}

function renderTabContent(tab, openChatTab, openNewChatTab) {
  switch (tab.type) {
    case "chats":
      return html`<${ChatsListSection} onOpenChat=${openChatTab} onNewChat=${openNewChatTab} />`;
    case "skills":
      return html`<${SkillsSection} />`;
    case "settings":
      return html`<${SettingsSection} />`;
    case "terminal":
      return html`<${TerminalSection} terminalId=${tab.terminalId} args=${tab.args} />`;
    default:
      return null;
  }
}

export function Shell() {
  const [tabs, setTabs] = useState([HOME_TAB]);
  const [activeId, setActiveId] = useState(HOME_TAB.id);
  const [reuseTabs, setReuseTabs] = useState(true);
  const [claudeConnected, setClaudeConnected] = useState(null);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    window.clanceApp.getPreferences().then((prefs) => setReuseTabs(prefs.reuseTabs));
    window.clanceApp.getSetupStatus().then((status) => setClaudeConnected(status.claude.loggedIn));
  }, []);

  function openTab(newTab) {
    const existing = tabs.find((t) => t.id === newTab.id);
    if (existing) {
      if (reuseTabs) {
        setActiveId(existing.id);
        return;
      }
      const uniqueTab = { ...newTab, id: `${newTab.id}#${Date.now()}` };
      setTabs([...tabs, uniqueTab]);
      setActiveId(uniqueTab.id);
      return;
    }
    setTabs([...tabs, newTab]);
    setActiveId(newTab.id);
  }

  function openSection(id) {
    const item = LAUNCHER_ITEMS.find((i) => i.id === id);
    openTab({ id, type: id, label: item.label, icon: item.icon });
  }

  function openNewChatTab() {
    const terminalId = nextTerminalId();
    openTab({
      id: terminalId,
      type: "terminal",
      label: "New Chat",
      icon: "terminal",
      terminalId,
      args: [],
    });
  }

  async function openChatTab(session) {
    const terminalId = nextTerminalId();
    // A session already running as a background agent can't be resumed —
    // it needs `attach` instead; resolved on the main process via `claude
    // agents --json` since that's the source of truth for what's running.
    const args = await window.clanceApp.resolveOpenArgs(session.id);
    openTab({
      id: `chat:${session.filePath}`,
      type: "terminal",
      label: session.title,
      icon: "terminal",
      terminalId,
      args,
    });
  }

  function closeTab(id, event) {
    event.stopPropagation();
    if (tabs.length <= 1) return;
    const index = tabs.findIndex((t) => t.id === id);
    if (index === -1) return;
    const nextTabs = tabs.filter((t) => t.id !== id);
    setTabs(nextTabs);
    if (activeId === id) {
      const neighbor = nextTabs[Math.max(0, index - 1)] ?? nextTabs[0];
      setActiveId(neighbor.id);
    }
  }

  const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[0];

  return html`
    <div class="shell">
      <nav class="sidebar ${collapsed ? "sidebar-collapsed" : ""}">
        <div class="sidebar-header">
          ${!collapsed && html`<div class="brand">Clance</div>`}
          <button
            class="sidebar-collapse-btn"
            title=${collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick=${() => setCollapsed(!collapsed)}
          >
            <span style=${{ display: "flex", transform: collapsed ? "none" : "rotate(180deg)" }}>
              ${Icon.chevronRight(14)}
            </span>
          </button>
        </div>
        <div class="launcher-label">Launcher</div>
        ${LAUNCHER_ITEMS.map(
          (item) => html`
            <button
              class="sidebar-item ${activeTab?.type === item.id ? "sidebar-item-active" : ""}"
              title=${item.label}
              onClick=${() => openSection(item.id)}
            >
              ${Icon[item.icon](16)}
              <span>${item.label}</span>
            </button>
          `
        )}
        <div class="sidebar-footer">
          <span class="status-dot ${claudeConnected ? "status-dot-ok" : "status-dot-off"}"></span>
          <span>${claudeConnected ? "Claude Connected" : "Claude Disconnected"}</span>
        </div>
      </nav>
      <div class="shell-main">
        <div class="tab-bar">
          ${tabs.map(
            (tab) => html`
              <button
                class="tab ${tab.id === activeId ? "tab-active" : ""}"
                onClick=${() => setActiveId(tab.id)}
              >
                <span class="tab-icon">${tabIcon(tab)}</span>
                <span class="tab-label">${tab.label}</span>
                <span class="tab-close" onClick=${(e) => closeTab(tab.id, e)}>
                  ${Icon.close(12)}
                </span>
              </button>
            `
          )}
        </div>
        <main class="content ${activeTab?.type === "terminal" ? "content-chat" : ""}">
          ${activeTab && renderTabContent(activeTab, openChatTab, openNewChatTab)}
        </main>
      </div>
    </div>
  `;
}
