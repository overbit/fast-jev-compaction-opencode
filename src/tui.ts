import { Plugin } from '@opencode/plugin/tui';

export default Plugin.define({
  id: 'fast-jev-compaction-opencode',
  setup() {
    // The server plugin performs compaction. This companion makes the package
    // visible in OpenCode's Plugins UI and follows the V2 CLI plugin contract.
  },
});
