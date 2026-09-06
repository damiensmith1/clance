import { contextBridge } from "electron";

// Placeholder API surface for the main window — real methods (chat
// history, settings, plugin management) land in later specs.
contextBridge.exposeInMainWorld("clanceApp", {});
