// The same rule set the community store's automated review runs, reproduced
// locally so a finding reaches us before a release instead of in a report
// after one. eslint-plugin-obsidianmd is the store's own plugin.
import tseslint from 'typescript-eslint';
import obsidianmd from 'eslint-plugin-obsidianmd';

export default tseslint.config(
  { ignores: ['main.js', 'build.js', 'demo/**', 'assets/**', 'scripts/**', 'node_modules/**'] },
  ...tseslint.configs.recommendedTypeChecked,
  ...obsidianmd.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Not in the store's own scan, and its suggestions lower-case proper
      // nouns — "local gemma", "webgpu" — so every finding would be a fight
      // between the rule and the product's vocabulary.
      'obsidianmd/ui/sentence-case': 'off',
      // Both point at the same future change: adopting the 1.13 declarative
      // settings API (issue #106). Until then the imperative tab works on the
      // 1.11.4 floor this plugin declares, and failing every build over a
      // migration we have scheduled would just teach us to ignore the linter.
      'obsidianmd/settings-tab/prefer-setting-definitions': 'warn',
      '@typescript-eslint/no-deprecated': 'warn',
    },
  },
  // The plugin forbids inline disables of its restricted rules, so the two
  // deliberate exceptions are declared here, scoped to the file that owns
  // each, where the justification also lives as a comment in the code:
  {
    // requestUrl resolves with the whole body in memory. model-store streams
    // ~3 GB with resume; wasm-store's stall timeout is built on the stream.
    files: ['src/model-store.ts', 'src/wasm-store.ts'],
    rules: { 'no-restricted-globals': 'off' },
  },
  {
    // One gated debug log, off by default, behind the Developer commands
    // toggle — a support thread needs something to ask the user to paste.
    files: ['src/main.ts'],
    rules: { 'obsidianmd/rule-custom-message': 'off' },
  }
);
