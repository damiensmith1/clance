import { h, html, render, useState } from "../shared/vendor/preact-htm-standalone.module.js";
import { ChatsSection } from "./sections/ChatsSection.js";
import { SkillsSection } from "./sections/SkillsSection.js";
import { SettingsSection } from "./sections/SettingsSection.js";

const SECTIONS = {
  chats: { label: "Chats", Component: ChatsSection },
  skills: { label: "Skills & Plugins", Component: SkillsSection },
  settings: { label: "Settings", Component: SettingsSection },
};

function App() {
  const [sectionId, setSectionId] = useState("chats");
  const ActiveSection = SECTIONS[sectionId].Component;

  return html`
    <div class="shell">
      <nav class="sidebar">
        ${Object.entries(SECTIONS).map(
          ([id, { label }]) => html`
            <button
              class=${id === sectionId ? "active" : ""}
              onClick=${() => setSectionId(id)}
            >
              ${label}
            </button>
          `
        )}
      </nav>
      <main class="content">
        <${ActiveSection} />
      </main>
    </div>
  `;
}

render(html`<${App} />`, document.getElementById("root"));
