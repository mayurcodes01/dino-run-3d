// Concatenates src/*.js into one module script and inlines it into the HTML template.
import fs from 'node:fs';
const read = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
const strip = (s) => s
  .replace(/^import .*;\s*$/gm, '')
  .replace(/^export (const|let|function|class) /gm, '$1 ')
  .replace(/^export \{[^}]*\};?\s*$/gm, '');
const parts = ['src/prelude.js', 'src/logic.js', 'src/audio.js', 'src/gfx.js', 'src/main.js'].map((f) => `// ---- ${f} ----\n` + strip(read(f)));
const js = parts.join('\n\n');
fs.mkdirSync(new URL('dist/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('dist/game.mjs', import.meta.url), js);
const html = read('src/index.template.html').replace('/*__SCRIPT__*/', () => js.replace(/<\/script/gi, '<\\/script'));
fs.writeFileSync(new URL('dist/index.html', import.meta.url), html);
console.log('built dist/index.html', (html.length / 1024).toFixed(0) + ' KB');
