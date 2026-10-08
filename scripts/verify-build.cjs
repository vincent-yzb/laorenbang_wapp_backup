const { existsSync, readdirSync } = require('node:fs');
const { join, relative } = require('node:path');

function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : path.endsWith('.ts') && !path.endsWith('.d.ts') ? [path] : [];
  });
}

const missing = sources('src')
  .map(path => join('dist', relative('src', path).replace(/\.ts$/, '.js')))
  .filter(path => !existsSync(path));
if (missing.length) {
  throw new Error(`Backend build is incomplete: ${missing.join(', ')}`);
}
console.log('Backend build artifacts verified, including dist/main.js.');
