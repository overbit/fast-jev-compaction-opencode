import type { Plugin } from '@opencode/plugin/tui';

export default {
  id: 'fast-jev-compaction-opencode',
  setup() {
    // The server plugin performs compaction. This V2 CLI companion exists so
    // the package is visible in OpenCode's Plugins UI.
  },
} satisfies Plugin.Definition;
