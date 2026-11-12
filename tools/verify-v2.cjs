/* =============================================================================
 * verify-v2.cjs — Uji ACTIVE-v2 (ns record.gs + ns domain.gs) di Node dengan
 * lingkungan Google Apps Script ditiru. Read-only terhadap file sumber.
 *
 * Jalankan dari root project:
 *   node tools/verify-v2.cjs
 *
 * Yang diuji:
 *   1. Sesi SSO: email terdaftar / tidak terdaftar / kosong (mode USER_DEPLOYING)
 *   2. Gerbang modul: user tanpa izin ditolak
 *   3. Anti-spoofing: NIK dari client tidak bisa menaikkan hak akses
 *   4. 4 endpoint HR benar-benar mengembalikan status success + data
 *
 * Fixture memakai tools/sheet_values.json (data MASTER KARYAWAN hasil dump xlsx).
 * ============================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const V2 = path.join(ROOT, 'ACTIVE-v2');
const GS_AUTH = path.join(V2, 'ns record.gs');
const GS_DOMAIN = path.join(V2, 'ns domain.gs');

const REGRESSION_TODAY_ISO = '2026-07-16T12:00:00+07:00';

// ---------------------------------------------------------------- fixtures ---
const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'sheet_values.json'), 'utf8'));
const nsValues = raw.map(row => row.map(c => (c && c.__date__) ? new Date(c.__date__) : c));

// User uji: punya semua izin. User kedua: tidak punya izin apa pun.
const karyawanValues = [
  ['NIK', 'Nama', 'Departemen', 'Jabatan', 'Otorisasi', 'Password', 'Email',
    'NS Headcount', 'NS Contract', 'NS Recruitment', 'NS Manning'],
  ['999', 'User Uji', 'Engineering', 'Staff', 'user', 'rahasia', 'uji@contoh.com', 1, 1, 1, 1],
  ['888', 'Tanpa Akses', 'Production', 'Staff', 'user', 'rahasia', 'noakses@contoh.com', 0, 0, 0, 0],
  ['777', 'Izin Sebagian', 'Production', 'Spv', 'user', 'rahasia', 'sebagian@contoh.com', 1, 0, 0, 0]
];

const manningValues = [
  ['Type', 'Periode', 'Comp', 'Comp Code', 'Cost Center', 'Head count', 'Nama Cost Center'],
  ['IDL', '06.2026', 'DACO', 'A028', '121101', 23, 'Engineering DAM'],
  ['DL', 62026, 'DACO', 'A028', '111102', 100, 'Diapers Production DAM'],
  ['IDL', '07.2026', 'DACO', 'A028', '121101', 25, 'Engineering DAM'],
  ['DL', 72026, 'DACO', 'A028', '111102', 105, 'Diapers Production DAM']
];

// ------------------------------------------------------------ GAS mock env ---
const cacheStore = {};
const scriptProperties = { NSRECORD_SPREADSHEET_ID: 'FAKE_NS_ID' };
const scheduledTriggers = [];
const logs = [];
let sessionEmail = '';
let failKaryawanRead = false; // dipakai untuk menguji pembedaan "gagal baca" vs "tidak terdaftar"

function makeSheet(name, values) {
  return {
    getName: () => name,
    getDataRange: () => ({ getValues: () => values.map(r => r.slice()) }),
    getLastRow: () => values.length,
    getLastColumn: () => (values[0] ? values[0].length : 0),
    getRange: (row, col, numRows, numCols) => ({
      getValues: () => Array.from({ length: numRows }, (_, r) =>
        Array.from({ length: numCols }, (_, c) => (values[row - 1 + r] || [])[col - 1 + c] || '')),
      getValue: () => ((values[row - 1] || [])[col - 1] || ''),
      setValues: (newValues) => {
        newValues.forEach((newRow, r) => {
          const target = row - 1 + r;
          while (values.length <= target) values.push([]);
          newRow.forEach((v, c) => { values[target][col - 1 + c] = v; });
        });
      },
      setValue: (v) => {
        while (values.length <= row - 1) values.push([]);
        values[row - 1][col - 1] = v;
      },
      clearContent: () => {
        for (let r = 0; r < numRows; r++) {
          const target = row - 1 + r;
          if (!values[target]) continue;
          for (let c = 0; c < numCols; c++) values[target][col - 1 + c] = '';
        }
      }
    }),
    setFrozenRows: () => {},
    hideSheet: () => {},
    autoResizeColumns: () => {},
    deleteRow: (r) => values.splice(r - 1, 1)
  };
}

const nsSheets = [makeSheet('MASTER KARYAWAN', nsValues), makeSheet('MANNING DISTRIBUTION', manningValues)];
const nsByName = { 'MASTER KARYAWAN': nsSheets[0], 'MANNING DISTRIBUTION': nsSheets[1] };
function insertNsSheet(name) {
  const sheet = makeSheet(name, []);
  nsSheets.push(sheet);
  nsByName[name] = sheet;
  return sheet;
}
const kSheet = makeSheet('KARYAWAN', karyawanValues);

const RealDate = Date;
function makeFrozenDate(iso) {
  const fixed = new RealDate(iso);
  function FrozenDate(...args) {
    if (!(this instanceof FrozenDate)) return args.length ? RealDate(...args) : RealDate(fixed.getTime());
    return args.length ? new RealDate(...args) : new RealDate(fixed.getTime());
  }
  FrozenDate.now = () => fixed.getTime();
  FrozenDate.parse = RealDate.parse;
  FrozenDate.UTC = RealDate.UTC;
  FrozenDate.prototype = RealDate.prototype;
  return FrozenDate;
}

const sandbox = {
  console: { log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push('ERR ' + a.join(' ')), warn: (...a) => logs.push('WARN ' + a.join(' ')) },
  Date: makeFrozenDate(REGRESSION_TODAY_ISO),
  JSON, Math, Object, Array, String, Number, Boolean, RegExp, Error,
  isNaN, isFinite, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: (k) => (scriptProperties[k] === undefined ? null : scriptProperties[k]),
      setProperty: (k, v) => { scriptProperties[k] = v; },
      deleteProperty: (k) => { delete scriptProperties[k]; }
    })
  },
  SpreadsheetApp: {
    openById: (id) => {
      if (failKaryawanRead && id !== 'FAKE_NS_ID') {
        throw new Error('Access denied: Anda tidak memiliki izin untuk membuka spreadsheet ini.');
      }
      return {
        getId: () => id,
        getSheetByName: (n) => (id === 'FAKE_NS_ID' ? (nsByName[n] || null) : (n === 'KARYAWAN' ? kSheet : null)),
        getSheets: () => (id === 'FAKE_NS_ID' ? nsSheets : [kSheet]),
        insertSheet: (n) => (id === 'FAKE_NS_ID' ? insertNsSheet(n) : null)
      };
    },
    flush: () => {}
  },
  CacheService: {
    getScriptCache: () => ({
      get: (k) => (cacheStore[k] === undefined ? null : cacheStore[k]),
      getAll: (keys) => {
        const out = {};
        (keys || []).forEach(k => { if (cacheStore[k] !== undefined) out[k] = cacheStore[k]; });
        return out;
      },
      put: (k, v) => { cacheStore[k] = v; },
      putAll: (obj) => { Object.keys(obj || {}).forEach(k => { cacheStore[k] = obj[k]; }); },
      remove: (k) => { delete cacheStore[k]; },
      removeAll: (keys) => { (keys || []).forEach(k => { delete cacheStore[k]; }); }
    })
  },
  Utilities: {
    sleep: () => {},
    newBlob: (text) => ({
      getBytes: () => Buffer.from(String(text), 'utf8'),
      getDataAsString: () => String(text)
    }),
    formatDate: (d, tz, fmt) => {
      const p = (n) => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    },
    getUuid: () => 'uuid-' + Math.random().toString(36).slice(2)
  },
  Session: {
    getScriptTimeZone: () => 'Asia/Jakarta',
    getActiveUser: () => ({ getEmail: () => sessionEmail }),
    getEffectiveUser: () => ({ getEmail: () => 'uji@contoh.com' })
  },
  LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {}, tryLock: () => true }) },
  ScriptApp: {
    getProjectTriggers: () => scheduledTriggers.slice(),
    deleteTrigger: (t) => { const i = scheduledTriggers.indexOf(t); if (i >= 0) scheduledTriggers.splice(i, 1); },
    newTrigger: (handler) => {
      const trigger = { getHandlerFunction: () => handler };
      const b = { timeBased: () => b, atHour: () => b, nearMinute: () => b, everyDays: () => b, inTimezone: () => b, create: () => { scheduledTriggers.push(trigger); return trigger; } };
      return b;
    }
  },
  HtmlService: {
    createTemplateFromFile: () => ({ evaluate: () => ({ setTitle() { return this; }, addMetaTag() { return this; }, setFaviconUrl() { return this; }, setXFrameOptionsMode() { return this; } }) }),
    createHtmlOutputFromFile: () => ({ getContent: () => '<html></html>' }),
    XFrameOptionsMode: { ALLOWALL: 1 }
  },
  Logger: { log: (m) => logs.push(String(m)) }
};

const context = vm.createContext(sandbox);

// ------------------------------------------------------- load BOTH .gs files --
function load(file) {
  const code = fs.readFileSync(file, 'utf8');
  vm.runInContext(code, context, { filename: path.basename(file) });
}
load(GS_AUTH);
load(GS_DOMAIN);

// ------------------------------------------------------------------ helpers ---
let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')); }
}
function parse(rawValue) {
  if (typeof rawValue === 'object' && rawValue !== null) return rawValue;
  try { return JSON.parse(rawValue); } catch (e) { return { status: 'parse-error', message: String(rawValue) }; }
}
function call(fn, ...args) {
  return context[fn](...args);
}

// ================================================================ TEST SUITE ==
console.log('\n=== 0. reset cache & properti ===');
scriptProperties.NS_ADMIN_NIKS = '';
scriptProperties.NS_ADMIN_EMAILS = '';
scriptProperties.NS_DASHBOARD_REFRESH_NIK = '';
Object.keys(cacheStore).forEach(k => delete cacheStore[k]);

console.log('\n=== 1. getSessionUserInfo (SSO) ===');

sessionEmail = 'uji@contoh.com';
let res = parse(call('getSessionUserInfo'));
check('email terdaftar -> success', res.status === 'success', JSON.stringify(res).slice(0, 160));
check('NIK terbaca', res.data && res.data.nik === '999', res.data && res.data.nik);
check('4 modul dikirim', res.data && res.data.modules && res.data.modules.length === 4);
check('semua modul allowed', res.data && res.data.modules.every(m => m.allowed));

sessionEmail = 'orangasing@contoh.com';
res = parse(call('getSessionUserInfo'));
check('email tak terdaftar -> forbidden', res.status === 'forbidden', res.message);

sessionEmail = ''; // meniru eksekusi tanpa user aktif (trigger), bukan USER_DEPLOYING
res = parse(call('getSessionUserInfo'));
check('tanpa email & tanpa NIK scheduler -> forbidden', res.status === 'forbidden', res.message);
check('pesan menyebut jalur scheduler', /scheduler|NS_DASHBOARD_REFRESH_NIK/i.test(res.message || ''), res.message);

console.log('\n=== 2. Gerbang izin modul ===');
sessionEmail = 'noakses@contoh.com';
res = parse(call('getNsHeadcountData', '888'));
check('user tanpa izin -> forbidden', res.status === 'forbidden', res.message);

sessionEmail = 'sebagian@contoh.com';
check('izin sebagian: Headcount boleh', parse(call('getNsHeadcountData', '777')).status === 'success');
check('izin sebagian: Contract ditolak', parse(call('getNsContractData', '777')).status === 'forbidden');

console.log('\n=== 3. Anti-spoofing NIK client ===');
sessionEmail = 'noakses@contoh.com';
res = parse(call('getNsHeadcountData', '999')); // mengaku NIK admin
check('klaim NIK admin tidak menaikkan hak', res.status === 'forbidden', res.message);

sessionEmail = 'uji@contoh.com';
res = parse(call('getNsHeadcountData', '888')); // NIK orang lain
check('NIK client diabaikan, identitas dari SSO', res.status === 'success', res.message);

console.log('\n=== 4. Endpoint HR (parity portal) ===');
sessionEmail = 'uji@contoh.com';

const hc = parse(call('getNsHeadcountData', '999'));
check('getNsHeadcountData success', hc.status === 'success', hc.message);
if (hc.status === 'success') {
  check('  payload berupa objek', typeof hc.data === 'object' && hc.data !== null);
  check('  ada minimal 3 seksi', Object.keys(hc.data || {}).length >= 3, Object.keys(hc.data || {}).join(','));
  console.log('        seksi: ' + Object.keys(hc.data || {}).slice(0, 12).join(', '));
}

const ct = parse(call('getNsContractData', '999'));
check('getNsContractData success', ct.status === 'success', ct.message);

const rc = parse(call('getNsRecruitmentData', '999'));
check('getNsRecruitmentData success', rc.status === 'success', rc.message);

const mn = parse(call('getNsManningData', '999', '2026-07'));
check('getNsManningData success', mn.status === 'success', mn.message);
if (mn.status === 'success') {
  check('  payload berupa objek', typeof mn.data === 'object' && mn.data !== null);
  console.log('        seksi: ' + Object.keys(mn.data || {}).slice(0, 10).join(', '));
}

console.log('\n=== 5. doGet + includeHtml_ ===');
const page = call('doGet');
check('doGet mengembalikan objek halaman', !!page);
check('includeHtml_ mengembalikan string', typeof call('includeHtml_', 'TrialFrontendHr') === 'string');

console.log('\n=== 6. Gerbang admin (review HIGH-2 / MEDIUM-3) ===');

sessionEmail = 'noakses@contoh.com';
scheduledTriggers.length = 0;
scriptProperties.NS_ADMIN_NIKS = '';
scriptProperties.NS_ADMIN_EMAILS = '';

let adminErr = null;
try { call('nsAssertAdmin_', 'uji'); } catch (e) { adminErr = e; }
check('nsAssertAdmin_ fail-closed saat daftar admin kosong', !!adminErr && /Akses admin ditolak/.test(adminErr.message), adminErr && adminErr.message);

adminErr = null;
try { call('nsInstallDailyDashboardRefresh'); } catch (e) { adminErr = e; }
check('installer scheduler ditolak untuk non-admin', !!adminErr && /Akses admin ditolak/.test(adminErr.message), adminErr && adminErr.message);
check('installer tidak membuat trigger sebelum lolos gate', scheduledTriggers.length === 0, String(scheduledTriggers.length));

check('nsSelfCheck non-admin -> forbidden', parse(call('nsSelfCheck')).status === 'forbidden');
check('nsClearAuthCache non-admin -> forbidden', parse(call('nsClearAuthCache')).status === 'forbidden');
check('nsRecordSelfTest non-admin ditolak', (() => {
  try { call('nsRecordSelfTest'); return false; } catch (e) { return /Akses admin ditolak/.test(e.message); }
})());
check('nsInspectSpreadsheetLive non-admin ditolak', (() => {
  try { call('nsInspectSpreadsheetLive'); return false; } catch (e) { return /Akses admin ditolak/.test(e.message); }
})());

// admin sah: NIK 999
scriptProperties.NS_ADMIN_NIKS = '999';
sessionEmail = 'uji@contoh.com';
check('admin sah lolos nsAssertAdmin_', (() => {
  try { const r = call('nsAssertAdmin_', 'uji'); return !!(r && r.profile && r.profile.nik === '999'); } catch (e) { return false; }
})());
let selfCheckAdmin = parse(call('nsSelfCheck'));
check('nsSelfCheck admin -> success', selfCheckAdmin.status === 'success', JSON.stringify(selfCheckAdmin).slice(0, 120));
check('nsSelfCheck melaporkan revisi patch', /v2\.1/.test(JSON.stringify(selfCheckAdmin)));
check('nsClearAuthCache admin -> success', parse(call('nsClearAuthCache')).status === 'success');

sessionEmail = 'sebagian@contoh.com';
adminErr = null;
try { call('nsAssertAdmin_', 'uji'); } catch (e) { adminErr = e; }
check('user ber-izin modul tetap bukan admin', !!adminErr, adminErr && adminErr.message);

console.log('\n=== 7. Jalur scheduler tanpa user aktif (perbaikan regresi) ===');
scriptProperties.NS_DASHBOARD_REFRESH_NIK = '999';
sessionEmail = '';
Object.keys(cacheStore).forEach(k => delete cacheStore[k]);

let schedRes = parse(call('getNsHeadcountData', '999'));
check('trigger refresh bisa mengambil data (NIK scheduler)', schedRes.status === 'success', schedRes.message);

const schedWrong = parse(call('getNsHeadcountData', '888'));
check('NIK selain scheduler tetap ditolak', schedWrong.status === 'forbidden', schedWrong.message);

sessionEmail = 'uji@contoh.com';
scriptProperties.NS_DASHBOARD_REFRESH_NIK = '';

console.log('\n=== 8. Kegagalan baca spreadsheet dibedakan (review LOW-9) ===');
Object.keys(cacheStore).forEach(k => delete cacheStore[k]);
failKaryawanRead = true;
const readFail = parse(call('getSessionUserInfo'));
check('baca spreadsheet gagal -> status error, bukan forbidden', readFail.status === 'error', readFail.status);
check('pesan tidak menyalahkan pendaftaran email', !/tidak terdaftar/i.test(readFail.message || ''), readFail.message);
check('pesan menyebut spreadsheet', /spreadsheet/i.test(readFail.message || ''), readFail.message);
failKaryawanRead = false;
Object.keys(cacheStore).forEach(k => delete cacheStore[k]);
check('pulih setelah gangguan', parse(call('getSessionUserInfo')).status === 'success');

console.log('\n=== 9. Integritas cache chunk (review MEDIUM-5) ===');
Object.keys(cacheStore).forEach(k => delete cacheStore[k]);
const cacheSsId = 'CACHE-TEST-SS';
const cacheData = [['NIK', 'Nama'], ['999', 'User Uji'], ['888', 'Tanpa Akses']];
call('nsAuthCachePut_', cacheSsId, cacheData);
let cacheRead = call('nsAuthCacheGet_', cacheSsId);
check('cache put/get round-trip', JSON.stringify(cacheRead) === JSON.stringify(cacheData));

// generasi baru tidak boleh tercampur generasi lama
const cacheData2 = cacheData.concat([['777', 'Generasi Dua']]);
call('nsAuthCachePut_', cacheSsId, cacheData2);
cacheRead = call('nsAuthCacheGet_', cacheSsId);
check('cache memakai generasi terbaru', JSON.stringify(cacheRead) === JSON.stringify(cacheData2));

// metadata diarahkan ke generasi yang tidak punya chunk -> harus cache miss
const metaKey = 'NS_KARYAWAN_V2:' + cacheSsId + ':meta';
const metaBackup = cacheStore[metaKey];
const tamperedMeta = JSON.parse(metaBackup);
tamperedMeta.gen = 'generasi-palsu';
cacheStore[metaKey] = JSON.stringify(tamperedMeta);
check('metadata menunjuk generasi tanpa chunk -> miss (null)', call('nsAuthCacheGet_', cacheSsId) === null);

// chunk dipotong (panjang tidak cocok) -> harus miss, bukan data campuran
cacheStore[metaKey] = metaBackup;
const realMeta = JSON.parse(metaBackup);
const firstChunkKey = 'NS_KARYAWAN_V2:' + cacheSsId + ':' + realMeta.gen + ':0';
cacheStore[firstChunkKey] = (cacheStore[firstChunkKey] || '') + 'X';
check('chunk dimodifikasi -> miss (null)', call('nsAuthCacheGet_', cacheSsId) === null);

// namespace berbeda tidak saling bocor
call('nsAuthCachePut_', 'SS-LAIN', [['a']]);
check('cache namespace per spreadsheet', JSON.stringify(call('nsAuthCacheGet_', 'SS-LAIN')) === JSON.stringify([['a']]));
check('namespace lain tidak terpengaruh', JSON.stringify(call('nsAuthCacheGet_', cacheSsId)) === JSON.stringify(cacheData2)
  || call('nsAuthCacheGet_', cacheSsId) === null);

const bigOk = call('nsSplitByBytes_', 'x'.repeat(500000), 90000);
check('pemecah byte memecah data besar', Array.isArray(bigOk) && bigOk.join('') === 'x'.repeat(500000), Array.isArray(bigOk) ? String(bigOk.length) : 'null');
const unicodeChunk = call('nsSplitByBytes_', '😀'.repeat(30000), 90000);
check('pemecah byte aman untuk Unicode multi-byte', Array.isArray(unicodeChunk) && unicodeChunk.join('') === '😀'.repeat(30000));

// ------------------------------------------------------------------ ringkasan --
console.log('\n=========================================');
console.log('  HASIL: ' + pass + ' pass, ' + fail + ' fail');
console.log('=========================================\n');
process.exit(fail === 0 ? 0 : 1);
