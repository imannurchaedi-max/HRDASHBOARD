/* Cek syntax blok <script> inline di index.html + kesehatan dasar HTML. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
// Path relatif - project ini di-rename dari "0. EMPLOYEE NS RECORD" ke
// "0. HR DASHBOARD" (28 Jul 2026); hardcode absolut sebelumnya jadi basi.
const P = path.join(__dirname, '..', 'ACTIVE', 'index.html');
const html = fs.readFileSync(P, 'utf8');

let fails = 0;
function ok(label, cond, extra) {
  if (!cond) fails++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ': ' + extra : ''}`);
}

// --- non-ASCII ---
const bad = [];
for (let i = 0; i < html.length; i++) {
  if (html.charCodeAt(i) > 127) bad.push(html.charCodeAt(i));
}
ok('0 karakter non-ASCII', bad.length === 0, bad.length ? bad.length + ' ditemukan' : '');

// --- syntax blok script inline (yang tanpa src) ---
const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
ok('ada blok script inline', blocks.length === 1, blocks.length + ' blok');
blocks.forEach((code, i) => {
  try {
    new vm.Script(code, { filename: `inline-${i}.js` });
    ok(`syntax blok script #${i}`, true);
  } catch (e) {
    ok(`syntax blok script #${i}`, false, e.message);
  }
});

// --- id yang dirujuk $() harus ada di markup ---
const code = blocks.join('\n');
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
const refs = new Set([...code.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]));
// id yang dibuat dinamis lewat innerHTML (canvas chart) - dikecualikan
const dynamic = new Set(['cDept', 'cGender', 'cBagian', 'cUsia', 'cGroup', 'cRing', 'cBucket', 'cTren', 'cRef', 'cKec']);
const missing = [...refs].filter(r => !ids.has(r) && !dynamic.has(r));
ok('semua id yang dirujuk $() ada di markup', missing.length === 0, missing.join(', '));

// --- canvas id yang dibuat render harus cocok dengan yang dipanggil chart ---
const canvasMade = new Set([...code.matchAll(/canvas\('([^']+)'/g)].map(m => m[1]));
// Selain helper barChart/doughnut/lineChart, sebagian canvas dipasang lewat
// blok new Chart() tulisan tangan yang mengambil elemennya via $('id') -
// hitung itu juga, kalau tidak checker melaporkan false positive.
const chartUsed = new Set([...code.matchAll(/(?:barChart|doughnut|lineChart|stackedTypeChart_|ccByTypeStackChart_)\('([^']+)'/g)].map(m => m[1]));
[...code.matchAll(/\$\('([^']+)'\)/g)].forEach(m => { if (canvasMade.has(m[1])) chartUsed.add(m[1]); });
const orphanChart = [...chartUsed].filter(c => !canvasMade.has(c));
const orphanCanvas = [...canvasMade].filter(c => !chartUsed.has(c));
ok('setiap chart punya canvas', orphanChart.length === 0, orphanChart.join(', '));
ok('setiap canvas dipakai chart', orphanCanvas.length === 0, orphanCanvas.join(', '));

// --- fungsi server yang dipanggil client harus ada di ns record.gs ---
const gs = fs.readFileSync(path.join(__dirname, '..', 'ACTIVE', 'ns record.gs'), 'utf8');
const called = new Set();
[...code.matchAll(/google\.script\.run[\s\S]{0,400}?\.(\w+)\(/g)].forEach(m => called.add(m[1]));
[...code.matchAll(/\)\[fn\]\(/g)].forEach(() => {});
['getNsHeadcountData', 'getNsContractData', 'getNsRecruitmentData', 'getNsManningData'].forEach(f => called.add(f));
const chainHelpers = new Set(['withSuccessHandler', 'withFailureHandler', 'run']);
const serverFns = [...called].filter(f => !chainHelpers.has(f));
const notDefined = serverFns.filter(f => !new RegExp('function\\s+' + f + '\\s*\\(').test(gs));
ok('semua fungsi server yang dipanggil client terdefinisi di .gs',
   notDefined.length === 0, notDefined.join(', '));
console.log('  info: fungsi server dipanggil =', serverFns.join(', '));

// --- data-module di html harus cocok NS_ACCESS_MODULES di .gs ---
const mods = [...html.matchAll(/data-module="([^"]+)"/g)].map(m => m[1]);
const gsMods = (gs.match(/const NS_ACCESS_MODULES = \[([^\]]+)\]/) || [, ''])[1]
  .split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
ok('data-module cocok dengan NS_ACCESS_MODULES',
   JSON.stringify(mods.slice().sort()) === JSON.stringify(gsMods.slice().sort()),
   'html=[' + mods.join('|') + '] gs=[' + gsMods.join('|') + ']');

// --- tag berpasangan kasar ---
['html', 'head', 'body', 'style', 'nav', 'form', 'table'].forEach(t => {
  const open = (html.match(new RegExp('<' + t + '(\\s|>)', 'g')) || []).length;
  const close = (html.match(new RegExp('</' + t + '>', 'g')) || []).length;
  ok(`tag <${t}> berpasangan`, open === close, `${open} buka / ${close} tutup`);
});

console.log('\n' + (fails === 0 ? 'SEMUA CEK HTML LULUS' : fails + ' CEK GAGAL'));
process.exit(fails ? 1 : 0);
