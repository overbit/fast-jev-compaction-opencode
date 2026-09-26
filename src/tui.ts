import type { TuiPluginModule } from '@opencode-ai/plugin/tui';

export default {
  id: 'fast-jev-compaction-opencode',
  tui: async () => {
    // Presence in the TUI registry makes the installed compaction plugin visible
    // in OpenCode's Plugins dialog. Compaction itself runs in the server target.
  },
} satisfies TuiPluginModule & { id: string };
