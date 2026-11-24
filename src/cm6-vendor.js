// CodeMirror 6 vendor 汇总入口：把编辑器需要的 CM6 模块统一导出到 window.CM6，
// 由 build.mjs 打成 iife 供 Tauri webview 直接 <script> 加载（webview 没有 ESM/require）。
// 阶段 0：只做基建，逐步在 editor6.js 里使用这些导出。
export * as State from '@codemirror/state';
export * as View from '@codemirror/view';
export * as Language from '@codemirror/language';
export * as Commands from '@codemirror/commands';
export * as LangMarkdown from '@codemirror/lang-markdown';
export * as Search from '@codemirror/search';
export * as Autocomplete from '@codemirror/autocomplete';
