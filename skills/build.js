// Copies skills/marginalia.py into the code block at the end of each skill's SKILL.md
const fs = require('fs');
const path = require('path');

const code = fs.readFileSync(path.join(__dirname, 'marginalia.py'), 'utf8');
for (const name of ['marginalia-feedback', 'marginalia-address']) {
  const file = path.join(__dirname, name, 'SKILL.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/```python marginalia\.py\n[\s\S]*```\n$/, () => '```python marginalia.py\n' + code + '```\n'));
}
