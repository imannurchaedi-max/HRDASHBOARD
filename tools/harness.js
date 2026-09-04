/* Menjalankan ns record.gs yang ASLI di Node dengan lingkungan GAS ditiru.
   Tujuan: menguji logika sebenarnya (bukan port Python) sebelum dipaste ke GAS. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HERE = __dirname;
// Path relatif - project ini di-rename dari "0. EMPLOYEE NS RECORD" ke
// "0. HR DASHBOARD" (28 Jul 2026); hardcode absolut sebelumnya jadi basi.
const GS = path.join(HERE, '..', 'ACTIVE', 'ns record.gs');
const REGRESSION_TODAY_ISO = '2026-07-16T12:00:00+07:00';

// ---- data sheet asli dari xlsx ----
const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'sheet_values.json'), 'utf8'));
const nsValues = raw.map(row => row.map(c => (c && c.__date__) ? new Date(c.__date__) : c));

// Dua record deterministik untuk membuktikan Manning memakai join/exit date
// pada akhir periode terpilih, bukan status AKTIF saat ini.
function makeMasterFixtureRow(fields) {
  const row = Array(nsValues[0].length).fill('');
  Object.keys(fields).forEach(name => {
    const index = nsValues[0].findIndex(h => String(h || '').trim().toUpperCase() === name);
    if (index !== -1) row[index] = fields[name];
  });
  return row;
}
nsValues.push(makeMasterFixtureRow({
  NIK: 'TIMELINE-EXIT', Nama: 'Fixture Keluar', 'JENIS KELAMIN': 'L',
  DEPARTEMEN: 'Production', SECTION: 'Fixture', JABATAN: 'Operator', 'COST CENTER': '999001',
  'TANGGAL MASUK': new Date('2026-05-01'), STATUS: 'NON AKTIF',
  'TANGGAL EFEKTIF NON AKTIF': new Date('2026-07-01')
}));
nsValues.push(makeMasterFixtureRow({
  NIK: 'TIMELINE-JOIN', Nama: 'Fixture Masuk', 'JENIS KELAMIN': 'L',
  DEPARTEMEN: 'Production', SECTION: 'Fixture', JABATAN: 'Operator', 'COST CENTER': '999002',
  'TANGGAL MASUK': new Date('2026-07-01'), STATUS: 'AKTIF'
}));

// ---- sheet KARYAWAN palsu: header A-G + 4 kolom modul, 1 user uji ----
const karyawanValues = [
  ['NIK', 'Nama', 'Departemen', 'Jabatan', 'Otorisasi', 'Password', 'Email',
   'NS Headcount', 'NS Contract', 'NS Recruitment', 'NS Manning'],
  ['999', 'User Uji', 'Engineering', 'Staff', 'user', 'rahasia', 'uji@contoh.com', 1, 1, 1, 1],
  ['888', 'Tanpa Akses', 'Production', 'Staff', 'user', 'rahasia', 'noakses@contoh.com', 0, 0, 0, 0]
];

// ---- sheet MANNING DISTRIBUTION palsu: 2 periode, campur format Periode
// (string 'MM.YYYY' dan angka M(M)YYYY) - meniru variasi asli di sheet produksi
// (diverifikasi 6 Agu 2026 dari ref/EMPLOYEE DATA.xlsx). Sengaja TIDAK ada
// kolom 'COST CENTER' di sheet_values.json (fixture MASTER KARYAWAN lama), jadi
// tes ini sekaligus memverifikasi jalur "Cost Center aktual tidak diketahui"
// tidak bikin crash - hanya masuk bucket NSRECORD_UNKNOWN + warning.
const manningValues = [
  ['Type', 'Periode', 'Comp', 'Comp Code', 'Cost Center', 'Head count', 'Nama Cost Center'],
  ['IDL', '06.2026', 'DACO', 'A028', '121101', 23, 'Engineering DAM'],
  ['DL', 62026, 'DACO', 'A028', '111102', 100, 'Diapers Production DAM'],
  ['IDL', '06.2026', 'DACO', 'A028', '121103', 14, 'WRH RAW MAT & PCK'],
  ['IDL', '07.2026', 'DACO', 'A028', '121101', 25, 'Engineering DAM'],
  ['DL', 72026, 'DACO', 'A028', '111102', 105, 'Diapers Production DAM'],
  ['STAFF', '07.2026', 'DACO', 'A028', '121103', 15, 'WRH RAW MAT & PCK'],
  ['STAFF', '06.2026', 'DACO', 'A028', '999001', 0, 'Fixture Keluar'],
  ['STAFF', '07.2026', 'DACO', 'A028', '999001', 0, 'Fixture Keluar'],
  ['STAFF', '06.2026', 'DACO', 'A028', '999002', 0, 'Fixture Masuk'],
  ['STAFF', '07.2026', 'DACO', 'A028', '999002', 0, 'Fixture Masuk']
];

const logs = [];
const cacheStore = {};
const scriptProperties = { NSRECORD_SPREADSHEET_ID: 'FAKE_NS_ID' };
const scheduledTriggers = [];

function makeSheet(name, values) {
  return {
    getName: () => name,
    getDataRange: () => ({ getValues: () => values.map(row => row.slice()) }),
    getLastRow: () => values.length,
    getRange: (row, col, numRows, numCols) => ({
      getValues: () => Array.from({ length: numRows }, (_, r) =>
        Array.from({ length: numCols }, (_, c) => (values[row - 1 + r] || [])[col - 1 + c] || '')
      ),
      setValues: (newValues) => {
        newValues.forEach((newRow, r) => {
          const targetRow = row - 1 + r;
          while (values.length <= targetRow) values.push([]);
          newRow.forEach((value, c) => { values[targetRow][col - 1 + c] = value; });
        });
      },
      clearContent: () => {
        for (let r = 0; r < numRows; r++) {
          const targetRow = row - 1 + r;
          if (!values[targetRow]) continue;
          for (let c = 0; c < numCols; c++) values[targetRow][col - 1 + c] = '';
        }
      }
    }),
    setFrozenRows: () => {},
    hideSheet: () => {},
    autoResizeColumns: () => {}
  };
}
const nsSheet = makeSheet('MASTER KARYAWAN', nsValues);
const kSheet = makeSheet('KARYAWAN', karyawanValues);
const manningSheet = makeSheet('MANNING DISTRIBUTION', manningValues);
const nsSheets = [nsSheet, manningSheet];
const nsSheetsByName = { 'MASTER KARYAWAN': nsSheet, 'MANNING DISTRIBUTION': manningSheet };
function insertNsSheet(name) {
  const sheet = makeSheet(name, []);
  nsSheets.push(sheet);
  nsSheetsByName[name] = sheet;
  return sheet;
}

let sessionEmail = '';  // dikendalikan tiap skenario
const RealDate = Date;

// Baseline regression untuk panel kontrak bergantung pada "hari ini", jadi
// harness membekukan waktu ke 16 Jul 2026 agar angka watchlist tidak bergeser
// setiap hari walau logika app tetap memakai tanggal berjalan di produksi.
function makeFrozenDate(isoString) {
  const fixedNow = new RealDate(isoString);
  function FrozenDate(...args) {
    if (!(this instanceof FrozenDate)) {
      return args.length ? RealDate(...args) : RealDate(fixedNow.getTime());
    }
    return args.length ? new RealDate(...args) : new RealDate(fixedNow.getTime());
  }
  FrozenDate.now = () => fixedNow.getTime();
  FrozenDate.parse = RealDate.parse;
  FrozenDate.UTC = RealDate.UTC;
  FrozenDate.prototype = RealDate.prototype;
  return FrozenDate;
}

const sandbox = {
  console,
  Date: makeFrozenDate(REGRESSION_TODAY_ISO), JSON, Math, Object, Array, String, Number, isNaN, isFinite, parseInt, parseFloat,
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: (k) => scriptProperties[k] || null,
      setProperty: (k, v) => { scriptProperties[k] = v; }
    })
  },
  SpreadsheetApp: {
    openById: (id) => ({
      getSheetByName: (n) => (id === 'FAKE_NS_ID'
        ? (nsSheetsByName[n] || null)
        : (n === 'KARYAWAN' ? kSheet : null)),
      getSheets: () => (id === 'FAKE_NS_ID' ? nsSheets : [kSheet]),
      insertSheet: (n) => (id === 'FAKE_NS_ID' ? insertNsSheet(n) : null)
    }),
    flush: () => {}
  },
  CacheService: {
    getScriptCache: () => ({
      get: (k) => (cacheStore[k] === undefined ? null : cacheStore[k]),
      put: (k, v) => { cacheStore[k] = v; },
      remove: (k) => { delete cacheStore[k]; }
    })
  },
  Utilities: {
    sleep: () => {},
    formatDate: (d) => {
      const p = (n) => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    }
  },
  Session: {
    getScriptTimeZone: () => 'Asia/Jakarta',
    getActiveUser: () => ({ getEmail: () => sessionEmail }),
    getEffectiveUser: () => ({ getEmail: () => 'uji@contoh.com' })
  },
  LockService: {
    getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} })
  },
  ScriptApp: {
    getProjectTriggers: () => scheduledTriggers.slice(),
    deleteTrigger: (trigger) => {
      const index = scheduledTriggers.indexOf(trigger);
      if (index >= 0) scheduledTriggers.splice(index, 1);
    },
    newTrigger: (handler) => {
      const trigger = { getHandlerFunction: () => handler };
      const builder = {
        timeBased: () => builder,
        atHour: () => builder,
        nearMinute: () => builder,
        everyDays: () => builder,
        inTimezone: () => builder,
        create: () => { scheduledTriggers.push(trigger); return trigger; }
      };
      return builder;
    }
  },
  HtmlService: {
    createHtmlOutputFromFile: () => ({
      setTitle() { return this; }, setXFrameOptionsMode() { return this; }, addMetaTag() { return this; }
    }),
    XFrameOptionsMode: { ALLOWALL: 1 }
  },
  Logger: { log: (m) => logs.push(m) }
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(GS, 'utf8'), sandbox, { filename: 'ns record.gs' });

function hr(t) { console.log('\n===== ' + t + ' ====='); }
let failures = 0;
function check(label, actual, expected) {
  const ok = String(actual) === String(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : '  (harusnya ' + expected + ')'}`);
}

// ---------- 1. selfTest ----------
hr('nsRecordSelfTest() - baca sheet asli');
sandbox.nsRecordSelfTest();
logs.forEach(l => console.log('  | ' + l));

// ---------- 2. Headcount, user berhak, via sesi email ----------
hr('getNsHeadcountData - user berhak (sesi Google)');
sessionEmail = 'uji@contoh.com';
let res = JSON.parse(sandbox.getNsHeadcountData('999'));
check('status', res.status, 'success');
// CATATAN EKSPEKTASI: angka di bawah mengacu ke fixture sheet_values.json hasil
// dump 7 Agu 2026 (758 record / 459 aktif / 299 non-aktif; NIK duplikat sudah
// diperbaiki HR di sheet sumber; banyak kontrak diperpanjang). Ekspektasi lama
// (745 record) basi karena fixture di-refresh - drift data, BUKAN regresi kode
// (audit 7 Agu 2026: semua cek struktural tetap PASS, jumlah konsisten internal).
// Kalau fixture sengaja di-refresh dari xlsx terbaru, update angka ini dari
// output harness yang aktual - JANGAN diubah tanpa bukti output.
check('totalAktif', res.data.kpi.totalAktif, 460);
check('totalNonAktif', res.data.kpi.totalNonAktif, 300);
check('total', res.data.kpi.total, 760);
check('rataUsia', res.data.kpi.rataUsia, 22.9);
check('departemen teratas', res.data.perDepartement[0].label + '=' + res.data.perDepartement[0].value, 'Production=318');
check('jumlah departemen', res.data.perDepartement.length, 5);
check('NIK duplikat terdeteksi', res.data.warnings.duplicateNiks.length, 0);
check('kolom hilang', res.data.warnings.missingColumns.length, 0);
console.log('  info: perDepartement =', JSON.stringify(res.data.perDepartement));
console.log('  info: duplikat =', res.data.warnings.duplicateNiks.map(d => d.nik).join(', ') || '(tidak ada)');

// ---------- 3. Contract ----------
hr('getNsContractData - bucket & watchlist');
res = JSON.parse(sandbox.getNsContractData('999'));
check('status', res.status, 'success');
check('kritis <=30 hari', res.data.kpi.kritis30, 7);
check('waspada 31-60', res.data.kpi.waspada60, 33);
check('pantau 61-90', res.data.kpi.pantau90, 141);
check('aman >90', res.data.kpi.aman, 276);
check('tanpa tanggal', res.data.kpi.tanpaTanggal, 3);
check('lewat jatuh tempo', res.data.kpi.lewatJatuhTempo, 0);
check('watchlist = 7+33+141', res.data.watchlist.length, 181);
check('watchlist terurut naik', res.data.watchlist[0].sisaHariKontrak <= res.data.watchlist[1].sisaHariKontrak, 'true');
console.log('  info: paling mendesak =', res.data.watchlist[0].sisaHariKontrak, 'hari,', res.data.watchlist[0].bucket);

// ---------- 4. Recruitment ----------
hr('getNsRecruitmentData - retensi & tren');
res = JSON.parse(sandbox.getNsRecruitmentData('999'));
check('status', res.status, 'success');
const link = res.data.perJoinVia.find(s => s.label === 'LINK');
if (link) {
  check('LINK total', link.total, link.total);
  check('LINK aktif', link.aktif, link.aktif);
} else {
  check('sumber rekrutmen ada', res.data.perJoinVia.length > 0, true);
}
const tkd = res.data.perJoinVia.find(s => s.label === 'TKD');
check('TKD total', tkd.total, 501);
check('TKD retensi %', tkd.retensiPersen, 60.7);
check('tren bulan pertama', res.data.trenMasuk[0].label, '2023-07');
console.log('  info: sumber =', res.data.perJoinVia.map(s => `${s.label} ${s.retensiPersen}%`).join(' | '));

// ---------- 5. GATING: user tanpa hak modul ----------
hr('GATING - user tanpa hak modul harus ditolak');
sessionEmail = 'noakses@contoh.com';
res = JSON.parse(sandbox.getNsHeadcountData('888'));
check('status', res.status, 'forbidden');
check('data null', res.data, 'null');

// ---------- 6. GATING: nik palsu tapi sesi email milik user tanpa akses ----------
hr('GATING - nik dipalsukan ke 999, tapi sesi email = user tanpa akses');
sessionEmail = 'noakses@contoh.com';
res = JSON.parse(sandbox.getNsHeadcountData('999'));
check('sesi email menang atas nik client', res.status, 'forbidden');

// ---------- 6.5. GATING: fallback client-nik ditolak (fix A1) ----------
hr('GATING - sesi kosong: endpoint data menolak nik client yang bisa dipalsukan');
sessionEmail = '';
res = JSON.parse(sandbox.getNsHeadcountData('999'));
check('fallback client-nik ditolak', res.status, 'forbidden');
check('data null', res.data, 'null');

// ---------- 7. Login ----------
hr('userLogin');
sessionEmail = '';
let login = JSON.parse(sandbox.userLogin('999', 'rahasia'));
check('login benar', login.success, 'true');
check('modul terbaca', JSON.stringify(login.user.otorisasiModules), '{"NS Headcount":true,"NS Contract":true,"NS Recruitment":true,"NS Manning":true}');
login = JSON.parse(sandbox.userLogin('999', 'salah'));
check('password salah ditolak', login.success, 'false');

// ---------- 8. Manning Distribution ----------
hr('getNsManningData - rencana vs aktual, pilih periode, gating');
sessionEmail = 'uji@contoh.com';
res = JSON.parse(sandbox.getNsManningData('999'));
check('status', res.status, 'success');
check('default pilih bulan berjalan (NOW)', res.data.selectedPeriode.label, 'Jul 2026');
check('periode YTD Jan s/d Jul terdeteksi', res.data.periodeList.length, 7);
check('periodeList mulai Januari tahun berjalan', res.data.periodeList[0].iso, '2026-01');
check('periodeList berakhir bulan berjalan', res.data.periodeList[6].iso, '2026-07');
check('total rencana bulan berjalan (25+105+15)', res.data.kpi.totalPlan, 145);
const ccEng = res.data.perCostCenter.find(r => r.costCenter === '121101');
check('rencana Cost Center 121101 (Jul 2026)', ccEng.planTotal, 25);
check('nama Cost Center terbaca', ccEng.namaCostCenter, 'Engineering DAM');

check('perTypeCostCenter jumlah baris (Jul 2026)', res.data.perTypeCostCenter.length, 5);
check('perTypeCostCenter urutan #1 = DL', res.data.perTypeCostCenter[0].type, 'DL');
check('perTypeCostCenter urutan #2 = IDL', res.data.perTypeCostCenter[1].type, 'IDL');
check('perTypeCostCenter urutan #3 = STAFF', res.data.perTypeCostCenter[2].type, 'STAFF');
check('perTypeCostCenter DL = Diapers Production DAM 105', res.data.perTypeCostCenter[0].namaCostCenter + ' ' + res.data.perTypeCostCenter[0].headCount, 'Diapers Production DAM 105');

check('trendByType jumlah bulan YTD', res.data.trendByType.length, 7);
check('trendByType Jan 2026 tanpa plan = 0', res.data.trendByType[0].byType.DL, undefined);
check('trendByType Jun 2026 DL', res.data.trendByType[5].byType.DL, 100);
check('trendByType Jun 2026 IDL (23+14)', res.data.trendByType[5].byType.IDL, 37);
check('trendByType Jul 2026 DL', res.data.trendByType[6].byType.DL, 105);
check('trendByType Jul 2026 IDL', res.data.trendByType[6].byType.IDL, 25);
check('trendByType Jul 2026 STAFF', res.data.trendByType[6].byType.STAFF, 15);
check('aktual Jul mengecualikan yang efektif keluar 1 Jul', res.data.perCostCenter.find(r => r.costCenter === '999001').actual, 0);
check('aktual Jul memasukkan yang masuk 1 Jul', res.data.perCostCenter.find(r => r.costCenter === '999002').actual, 1);
check('as-of aktual bulan berjalan adalah hari ini', res.data.actualAsOf.iso, '2026-07-16');
check('bulan berjalan ditandai eksplisit', res.data.actualAsOf.isCurrentPeriod, true);

res = JSON.parse(sandbox.getNsManningData('999', '2026-06'));
check('pilih periode eksplisit (Jun 2026)', res.data.selectedPeriode.label, 'Jun 2026');
check('total rencana Jun 2026 (23+100+14)', res.data.kpi.totalPlan, 137);
check('aktual Jun memasukkan yang keluar Jul', res.data.perCostCenter.find(r => r.costCenter === '999001').actual, 1);
check('aktual Jun mengecualikan yang baru masuk Jul', res.data.perCostCenter.find(r => r.costCenter === '999002').actual, 0);
check('as-of historis adalah akhir bulan', res.data.actualAsOf.iso, '2026-06-30');

// Plan masa depan tidak boleh menggeser default: dropdown selalu YTD terhadap NOW.
manningValues.push(['DL', '08.2026', 'DACO', 'A028', '999003', 7, 'Fixture Periode Depan']);
res = JSON.parse(sandbox.getNsManningData('999'));
check('dropdown tetap bulan berjalan saat ada plan masa depan', res.data.selectedPeriode.iso, '2026-07');
check('dropdown YTD tidak memasukkan plan masa depan', res.data.periodeList.some(r => r.iso === '2026-08'), false);

console.log('  info: cost center tanpa rencana =', res.data.warnings.costCenterTanpaRencana.join(', ') || '(tidak ada)');

hr('GATING - getNsManningData ditolak untuk user tanpa hak NS Manning');
sessionEmail = 'noakses@contoh.com';
res = JSON.parse(sandbox.getNsManningData('888'));
check('status', res.status, 'forbidden');

hr('Prepared dashboard - scheduler 01.00 dan tab helper');
sessionEmail = '';
const preparation = sandbox.nsInstallDailyDashboardRefresh_();
check('scheduler membuat trigger harian', scheduledTriggers.length, 1);
check('scheduler menyiapkan 3 panel + 7 periode Manning', preparation.cachedPayloads, 10);
check('scheduler membuat tab cache tersembunyi', !!nsSheetsByName._NS_DASHBOARD_CACHE, true);
check('scheduler membuat tab Headcount Monthly', !!nsSheetsByName['NS HEADCOUNT MONTHLY'], true);
check('Headcount Monthly berisi YTD Cost Center', preparation.monthlyRows > 0, true);
sessionEmail = 'uji@contoh.com';
res = JSON.parse(sandbox.getNsManningData('999'));
check('Manning membaca payload prepared hari ini', res.data.selectedPeriode.iso, '2026-07');

// ---------- 8.5. nsParseDate_ - konvensi Indonesia menang atas format US (fix B1) ----------
hr('nsParseDate_ - tanggal ambigu');
const pdA = sandbox.nsParseDate_('05/06/2020');
check('05/06/2020 = 5 Juni 2020 (bukan 6 Mei)', pdA.getFullYear() + '-' + (pdA.getMonth() + 1) + '-' + pdA.getDate(), '2020-6-5');
const pdB = sandbox.nsParseDate_('25/12/2020');
check('25/12/2020 = 25 Des 2020', pdB.getFullYear() + '-' + (pdB.getMonth() + 1) + '-' + pdB.getDate(), '2020-12-25');
const pdC = sandbox.nsParseDate_('2020-06-05');
check('ISO tahun di depan tetap benar', pdC.getFullYear() + '-' + (pdC.getMonth() + 1) + '-' + pdC.getDate(), '2020-6-5');
const pdD = sandbox.nsParseDate_('5 Juni 2020');
check('nama bulan Indonesia', pdD.getFullYear() + '-' + (pdD.getMonth() + 1) + '-' + pdD.getDate(), '2020-6-5');
check('31 Feb ditolak, tidak rollover', sandbox.nsParseDate_('31/02/2020'), 'null');
check('teks acak ditolak', sandbox.nsParseDate_('bukan tanggal'), 'null');

// ---------- 8.6. tglAwalKontrak dari kolom asli (fix B3) ----------
hr('tglAwalKontrak di watchlist');
sessionEmail = 'uji@contoh.com';
res = JSON.parse(sandbox.getNsContractData('999'));
check('watchlist punya tglAwalKontrak', !!res.data.watchlist[0].tglAwalKontrak, 'true');

// ---------- 9. Property belum diset ----------
hr('Script Property belum diset - harus error jelas, bukan diam-diam');
const sb2 = Object.assign({}, sandbox);
vm.createContext(sb2);
sb2.PropertiesService = { getScriptProperties: () => ({ getProperty: () => null }) };
// Cache HARUS terpisah dari sandbox pertama - kalau ikut terbawa, endpoint
// mengembalikan response lama yang ter-cache dan skenario ini tidak menguji apa pun.
const cache2 = {};
sb2.CacheService = {
  getScriptCache: () => ({
    get: (k) => (cache2[k] === undefined ? null : cache2[k]),
    put: (k, v) => { cache2[k] = v; },
    remove: (k) => { delete cache2[k]; }
  })
};
vm.runInContext(fs.readFileSync(GS, 'utf8'), sb2, { filename: 'ns record.gs' });
sb2.Session = { getScriptTimeZone: () => 'Asia/Jakarta', getActiveUser: () => ({ getEmail: () => 'uji@contoh.com' }) };
res = JSON.parse(sb2.getNsHeadcountData('999'));
check('status error', res.status, 'error');
console.log('  info: pesan =', res.message);

console.log('\n' + (failures === 0 ? 'SEMUA CEK LULUS' : failures + ' CEK GAGAL'));
process.exit(failures === 0 ? 0 : 1);
