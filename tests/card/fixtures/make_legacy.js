// Translate a card build from BEFORE 1.0.0 (the separate "islautopia-intercom-card" repo) to
// today's names, so the benches' negative/positive controls can still run an old build.
//
//   node tests/card/fixtures/make_legacy.js <old build.js> <out.js>
//
// Why the fixtures exist at all: the controls of sim_carrera_reentrada.js (negative control: the
// build BEFORE the reentrancy fix must fail cases 1 and 5) and of ui_v1_9_7 / ui_v1_9_8 (the
// previous release must fail the new checks) used `git show <commit>:dist/...` in the card's own
// repository. That history did not move with the card into this repository, and the benches poke
// the card's internals by name (`_superseded`, `_pauseState`...), which 1.0.0 renamed from Spanish.
// A control run against an untranslated old build would fail on a missing name - red for the
// wrong reason, which is exactly a control that controls nothing.
//
// What this changes: identifiers (by AST position, never inside comments or strings) using
// rename_map.json - the same map applied to the card in 1.0.0 - plus the element tags, storage
// keys, CSS class names, integration domain and pause-state values. Nothing else: the logic of the
// old build is what the control is about, so it must stay byte-for-byte the old logic.
//
// The three fixtures in legacy/ were made with this script from the card repo's commits:
//   3983f68 (before the 2026-09-07 reentrancy fix), 5a75507 (1.9.6), 84c6bc1 (1.9.7).
const acorn = require('acorn');
const walk = require('acorn-walk');
const fs = require('fs');
const path = require('path');

const [src, out] = process.argv.slice(2);
const map = JSON.parse(fs.readFileSync(path.join(__dirname, 'rename_map.json'), 'utf8'));
let text = fs.readFileSync(src, 'utf8');

const ast = acorn.parse(text, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true });
const sites = new Map();
const rec = (node, name) => { if (Object.prototype.hasOwnProperty.call(map, name)) sites.set(node.start, { end: node.end, name }); };
walk.full(ast, (node) => {
  if (node.type === 'Identifier') rec(node, node.name);
  if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') rec(node.property, node.property.name);
  if (/^(Property|MethodDefinition|PropertyDefinition)$/.test(node.type) && !node.computed && node.key.type === 'Identifier') rec(node.key, node.key.name);
});
for (const start of [...sites.keys()].sort((a, b) => b - a)) {
  const { end, name } = sites.get(start);
  text = text.slice(0, start) + map[name] + text.slice(end);
}
const literal = [
  ["'oculta'", "'hidden'"], ["'inactividad'", "'idle'"], ["'gracia'", "'grace'"], ["'colgada'", "'hung_up'"],
  ["return 'ausente';", "return 'away';"], ["return 'noche';", "return 'night';"],
  ['  ausente: { icon', '  away: { icon'], ['  noche: { icon', '  night: { icon'],
  ['.mode-ausente', '.mode-away'], ['.mode-noche', '.mode-night'], ["'sin-id'", "'no-id'"],
  ['islautopia-intercom-card-editor', 'ig-doorbell-card-editor'],
  ['islautopia-intercom-card-selected', 'ig-doorbell-card-selected'],
  ['islautopia-intercom-view', 'ig-doorbell-view'],
  ['islautopia-intercom-', 'ig-doorbell-'],
  ['islautopia-loader', 'ig-loader-overlay'],
  ['islautopia_doorbell', 'ig_doorbell'],
  ['intercom-container', 'ig-container'], ['intercom-button', 'mic-button'], ['active-intercom', 'active-talk'],
];
for (const [a, b] of literal) text = text.split(a).join(b);
fs.writeFileSync(out, text, 'utf8');
console.log(`${out}: ${sites.size} identifiers renamed`);
