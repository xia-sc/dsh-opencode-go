// Generated bundle entry: do NOT edit lib/client.js by hand.
// Edit src/client/*.js, then run: node scripts/build-client.cjs
const fs = require('fs');
const path = require('path');
const ROOT = __dirname + '/..';
const ORDER = ['00-head.js', '01-dicts.js', '02-ui.js', '10-store.js', '20-card.js', '21-section.js', '99-tail.js'];
const out = ORDER.map((f) => fs.readFileSync(path.join(ROOT, 'src', 'client', f), 'utf8').replace(/\s+$/, '')).join('\n');
fs.writeFileSync(path.join(ROOT, 'lib', 'client.js'), out + '\n');
console.log('built lib/client.js from ' + ORDER.length + ' parts');
