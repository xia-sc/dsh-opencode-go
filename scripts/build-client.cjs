// Generated bundle entry: do NOT edit lib/client.js by hand.
// Edit src/client/*.js, then run: node scripts/build-client.cjs
// (or: npm run build:client)
const fs = require('fs');
const path = require('path');
const { Script } = require('node:vm');
const ROOT = __dirname + '/..';
const ORDER = ['00-head.js', '01-dicts.js', '02-ui.js', '10-store.js', '20-card.js', '21-section.js', '99-tail.js'];
const OUT = path.join(ROOT, 'lib', 'client.js');

function build() {
  const missing = ORDER.filter((f) => !fs.existsSync(path.join(ROOT, 'src', 'client', f)));
  if (missing.length > 0) {
    throw new Error(`missing parts: ${missing.join(', ')}`);
  }
  return ORDER.map((f) => fs.readFileSync(path.join(ROOT, 'src', 'client', f), 'utf8').replace(/\s+$/, '')).join('\n') + '\n';
}

function main() {
  let out;
  try {
    out = build();
  } catch (error) {
    console.error(`build-client: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  // Syntax gate (in-process vm compile, no child process): a broken splice
  // must fail here, not in the browser console. Checked BEFORE writing so a
  // bad build never clobbers the last good lib/client.js.
  try {
    new Script(out, { filename: 'lib/client.js' });
  } catch (error) {
    console.error(`build-client: syntax check failed:\n${error.message}`);
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(OUT, out);
  console.log('built lib/client.js from ' + ORDER.length + ' parts');
}

if (require.main === module) main();
module.exports = { ORDER, OUT, build };
