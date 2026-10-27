'use strict';
// Fork-local packaging only: read a fixed allowlist, never import upstream code.
// Adapted from new-mit-2026-09-08/packaging-copy.cjs (2026-10-27, manual-riposte-2026-10-27):
// - plan.output names the generated web root (default 'dist', as before). A repository whose committed
//   dist/ IS the source can write elsewhere (for example 'build'), and the output may never overlap a
//   source path, so static mode can never delete source files.
// - plan.rewrites applies exact, pinned string replacements to files in the OUTPUT only (the source
//   stays byte-identical): each `find` must occur exactly once, and the file's SHA-256 must match
//   before_sha256 before and after_sha256 after, or the build fails.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const plan = JSON.parse(fs.readFileSync(path.join(__dirname, 'plan.json'), 'utf8'));
function relativeOk(relative) {
  return typeof relative === 'string' && relative !== '' && !path.isAbsolute(relative) && !relative.split(/[\\/]/).includes('..');
}
function safe(base, relative) {
  if (!relativeOk(relative)) throw new Error('Unsafe packaging path');
  return path.join(base, relative);
}
const outputName = plan.output || 'dist';
if (!relativeOk(outputName) || outputName === '.' || outputName.split(/[\\/]/).includes('.')) throw new Error('Unsafe output path');
const output = safe(root, outputName);
function overlaps(a, b) {
  const x = path.resolve(a) + path.sep, y = path.resolve(b) + path.sep;
  return x.startsWith(y) || y.startsWith(x);
}
const sourceRoot = safe(root, plan.source_root || '.');
const sources = [];
if (plan.source_root && plan.source_root !== '.') sources.push(sourceRoot);
for (const relative of plan.include) sources.push(safe(sourceRoot, relative));
for (const relative of plan.root_files || []) sources.push(safe(root, relative));
for (const source of Object.values(plan.aliases || {})) sources.push(safe(root, source));
if (plan.output && sources.some((source) => overlaps(source, output))) throw new Error('Output overlaps a source path');
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function copy(source, destination, relative) {
  if ((plan.exclude || []).some(p => relative === p || relative.startsWith(p + '/'))) return;
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error('Symlinks are not package assets');
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(source).sort()) copy(path.join(source, name), path.join(destination, name), relative + '/' + name);
  } else if (stat.isFile()) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  } else throw new Error('Non-regular package asset');
}
if (fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink()) throw new Error('Unsafe output');
if (plan.mode === 'static') fs.rmSync(output, { recursive: true, force: true });
else if (!fs.existsSync(path.join(output, 'index.html'))) throw new Error('Build ' + outputName + '/index.html first');
for (const relative of plan.include) copy(safe(sourceRoot, relative), safe(output, relative), relative);
for (const relative of plan.root_files || []) copy(safe(root, relative), safe(output, relative), relative);
for (const [destination, source] of Object.entries(plan.aliases || {})) copy(safe(root, source), safe(output, destination), source);
for (const rewrite of plan.rewrites || []) {
  const file = safe(output, rewrite.path);
  if (sha256(file) !== rewrite.before_sha256) throw new Error('Rewrite source changed: ' + rewrite.path);
  let text = fs.readFileSync(file, 'utf8');
  for (const [find, replacement] of rewrite.replace) {
    if (typeof find !== 'string' || !find || typeof replacement !== 'string') throw new Error('Invalid rewrite');
    if (text.split(find).length !== 2) throw new Error('Rewrite target must occur exactly once: ' + rewrite.path);
    text = text.replace(find, () => replacement);
  }
  fs.writeFileSync(file, text);
  if (sha256(file) !== rewrite.after_sha256) throw new Error('Rewrite result changed: ' + rewrite.path);
}
