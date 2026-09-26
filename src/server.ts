import type { PluginModule } from '@opencode-ai/plugin';

import { FastJevCompaction } from './plugin.js';

export default {
  id: 'fast-jev-compaction-opencode',
  server: FastJevCompaction,
} satisfies PluginModule;
