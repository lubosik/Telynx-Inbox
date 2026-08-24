'use strict';

const { spawnSync } = require('node:child_process');

let cachedAvailability;

function hasXcodeSwiftCompiler() {
  if (cachedAvailability !== undefined) return cachedAvailability;

  const probe = spawnSync('xcrun', ['--find', 'swiftc'], { encoding: 'utf8' });
  cachedAvailability = probe.status === 0;
  return cachedAvailability;
}

module.exports = { hasXcodeSwiftCompiler };
