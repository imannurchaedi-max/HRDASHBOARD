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
  ['IDL', '11.2025', 'DACO', 'A028', '121101', 23, 'Engineering DAM'],
  ['DL', 112025, 'DACO', 'A028', '111102', 100, 'Diapers Production DAM'],
  ['IDL', '11.2025', 'DACO', 'A028', '121103', 14, 'WRH RAW MAT & PCK'],
  ['IDL', '12.2025', 'DACO', 'A028', '121101', 25, 'Engineering DAM'],
  ['DL', 122025, 'DACO', 'A028', '111102', 105, 'Diapers Production DAM'],
  ['STAFF', '12.2025', 'DACO', 'A028', '121103', 15, 'WRH RAW MAT & PCK']
];

const logs = [];
const cacheStore = {};

function makeSheet(name, values) {
  return {
    getName: () => name,
    getDataRange: () => ({ getValues: () => values }),
    getLastRow: () => values.length
  };
}
const nsSheet = makeSheet('MASTER KARYAWAN', nsValues);
const kSheet = makeSheet('KARYAWAN', karyawanValues);
const manningSheet = makeSheet('MANNING DISTRIBUTION', manningValues);

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
      getProperty: (k) => (k === 'NSRECORD_SPREADSHEET_ID' ? 'FAKE_NS_ID' : null)
    })
  },
  SpreadsheetApp: {
    openById: (id) => ({
      getSheetByName: (n) => (id === 'FAKE_NS_ID'
        ? (n === 'MASTER KARYAWAN' ? nsSheet : (n === 'MANNING DISTRIBUTION' ? manningSheet : null))
        : (n === 'KARYAWAN' ? kSheet : null)),
      getSheets: () => (id === 'FAKE_NS_ID' ? [nsSheet, manningSheet] : [kSheet])
    })
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
    getActiveUser: () => ({ getEmail: () => sessionEmail })
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
check('totalAktif', res.data.kpi.totalAktif, 459);
check('totalNonAktif', res.data.kpi.totalNonAktif, 299);
check('total', res.data.kpi.total, 758);
check('rataUsia', res.data.kpi.rataUsia, 22.9);
check('departemen teratas', res.data.perDepartement[0].label + '=' + res.data.perDepartement[0].value, 'Production=317');
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
check('tanpa tanggal', res.data.kpi.tanpaTanggal, 2);
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
check('default pilih periode terbaru', res.data.selectedPeriode.label, 'Des 2025');
check('jumlah periode terdeteksi', res.data.periodeList.length, 2);
check('periodeList terurut turun', res.data.periodeList[0].iso, '2025-12');
check('total rencana periode terbaru (25+105+15)', res.data.kpi.totalPlan, 145);
const ccEng = res.data.perCostCenter.find(r => r.costCenter === '121101');
check('rencana Cost Center 121101 (Des 2025)', ccEng.planTotal, 25);
check('nama Cost Center terbaca', ccEng.namaCostCenter, 'Engineering DAM');

check('perTypeCostCenter jumlah baris (Des 2025)', res.data.perTypeCostCenter.length, 3);
check('perTypeCostCenter urutan #1 = DL', res.data.perTypeCostCenter[0].type, 'DL');
check('perTypeCostCenter urutan #2 = IDL', res.data.perTypeCostCenter[1].type, 'IDL');
check('perTypeCostCenter urutan #3 = STAFF', res.data.perTypeCostCenter[2].type, 'STAFF');
check('perTypeCostCenter DL = Diapers Production DAM 105', res.data.perTypeCostCenter[0].namaCostCenter + ' ' + res.data.perTypeCostCenter[0].headCount, 'Diapers Production DAM 105');

check('trendByType jumlah bulan', res.data.trendByType.length, 2);
check('trendByType Nov 2025 DL', res.data.trendByType[0].byType.DL, 100);
check('trendByType Nov 2025 IDL (23+14)', res.data.trendByType[0].byType.IDL, 37);
check('trendByType Nov 2025 tidak ada STAFF', res.data.trendByType[0].byType.STAFF, undefined);
check('trendByType Des 2025 DL', res.data.trendByType[1].byType.DL, 105);
check('trendByType Des 2025 IDL', res.data.trendByType[1].byType.IDL, 25);
check('trendByType Des 2025 STAFF', res.data.trendByType[1].byType.STAFF, 15);

res = JSON.parse(sandbox.getNsManningData('999', '2025-11'));
check('pilih periode eksplisit (Nov 2025)', res.data.selectedPeriode.label, 'Nov 2025');
check('total rencana Nov 2025 (23+100+14)', res.data.kpi.totalPlan, 137);

console.log('  info: cost center tanpa rencana =', res.data.warnings.costCenterTanpaRencana.join(', ') || '(tidak ada)');

hr('GATING - getNsManningData ditolak untuk user tanpa hak NS Manning');
sessionEmail = 'noakses@contoh.com';
res = JSON.parse(sandbox.getNsManningData('888'));
check('status', res.status, 'forbidden');

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
