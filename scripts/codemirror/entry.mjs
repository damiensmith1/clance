// Everything the editor uses from CodeMirror, re-exported from one module.
// scripts/build-codemirror.mjs bundles this into
// src/shared/vendor/codemirror.mjs. CodeMirror's packages share state
// (@codemirror/state must exist exactly once), so they're bundled together
// rather than vendored one by one. Versions are pinned in package.json's
// devDependencies.

export * from "@codemirror/state";
export * from "@codemirror/view";
export * from "@codemirror/commands";
export * from "@codemirror/search";
export * from "@codemirror/language";
export { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
export { MergeView, unifiedMergeView, getChunks, goToNextChunk, goToPreviousChunk, getOriginalDoc, updateOriginalDoc, Chunk, presentableDiff, acceptChunk, rejectChunk } from "@codemirror/merge";
export { tags, highlightCode } from "@lezer/highlight";

export { javascript } from "@codemirror/lang-javascript";
export { json } from "@codemirror/lang-json";
export { css } from "@codemirror/lang-css";
export { html } from "@codemirror/lang-html";
export { markdown } from "@codemirror/lang-markdown";
export { python } from "@codemirror/lang-python";
export { yaml } from "@codemirror/lang-yaml";
export { sql } from "@codemirror/lang-sql";
export { rust } from "@codemirror/lang-rust";
export { go } from "@codemirror/lang-go";

export { shell } from "@codemirror/legacy-modes/mode/shell";
export { toml } from "@codemirror/legacy-modes/mode/toml";
export { swift } from "@codemirror/legacy-modes/mode/swift";
export { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
export { properties } from "@codemirror/legacy-modes/mode/properties";
export { ruby } from "@codemirror/legacy-modes/mode/ruby";
export { lua } from "@codemirror/legacy-modes/mode/lua";
export { diff } from "@codemirror/legacy-modes/mode/diff";
export { c, cpp, java, kotlin, csharp, scala } from "@codemirror/legacy-modes/mode/clike";
export { nginx } from "@codemirror/legacy-modes/mode/nginx";
export { xml } from "@codemirror/legacy-modes/mode/xml";
