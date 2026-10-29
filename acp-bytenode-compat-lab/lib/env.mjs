// acp-bytenode-compat-lab/lib/env.mjs
// Environment metadata collector for differential compatibility lab

import process from 'node:process';

export function getEnvironmentMetadata() {
  return {
    timestamp: new Date().toISOString(),
    node: {
      version: process.version,
      major: parseInt(process.versions.node.split('.')[0], 10),
      abi: process.versions.modules,
    },
    v8: {
      version: process.versions.v8,
    },
    platform: {
      os: process.platform,
      arch: process.arch,
    },
  };
}
