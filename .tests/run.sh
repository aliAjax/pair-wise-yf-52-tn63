#!/usr/bin/env bash
set -e
cd /workspace/.tests
/workspace/node_modules/.bin/tsc -p tsconfig.test.json
NODE_PATH=/workspace/node_modules node -e "
const Module = require('module');
const orig = Module._resolveFilename;
Module._resolveFilename = function(request, ...args) {
  if (request === '@angular/core') return require.resolve('/workspace/.tests/dist/.tests/stubs/core.js');
  return orig.call(this, request, ...args);
};
require('/workspace/.tests/dist/.tests/tests/all.test.js');
"
