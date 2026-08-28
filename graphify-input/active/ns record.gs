// =============================================================================
// ns record.gs - Aplikasi NS RECORD (Non Staff Record)
// =============================================================================
// Web app MANDIRI (standalone), project GAS "NS RECORD" - TERPISAH dari DAM
// PORTAL / DT VAL SUM 26. Keputusan user 16 Jul 2026 (sebelumnya direncanakan
// jadi modul di dalam DAM PORTAL). Konsekuensinya: file ini tidak boleh
// bergantung pada fungsi apa pun milik WebApp.gs / dt qdash.gs - seluruh
// lapisan autentikasi disalin ke sini supaya berdiri sendiri.
//
// NS = Non Staff (karyawan level floor). Seluruh isi sheet MASTER KARYAWAN
// adalah Non Staff - tidak ada filter level di aplikasi ini.
//
// ATURAN YANG MENGIKAT (mengikuti standar project DT SUMMARY):
//  - WAJIB openById(), JANGAN getActiveSpreadsheet() (project ini standalone).
//  - Semua endpoint: parameter nik di posisi PERTAMA + return JSON.stringify(...).
//  - Executable code WAJIB 100% ASCII.
//
// PERINGATAN DEPLOYMENT - WAJIB DIPATUHI:
//  Deploy Web App HARUS "Execute as: Me" + "Who has access: Anyone within
//  [domain PT DAM]". JANGAN PERNAH mode "Anyone". Pembatasan domain adalah satu-
//  satunya jaminan Session.getActiveUser().getEmail() terisi. Tanpa itu,
//  resolveRequestUserProfile_ jatuh ke fallback nik kiriman client yang bisa
//  dipalsukan dari console browser - siapa pun bisa menarik data pribadi
//  (nama, tanggal lahir, alamat, kontrak) 745 karyawan. Sama seperti aturan
//  di dt_summary_architecture.md section 8.
// =============================================================================

// Spreadsheet sumber NS Record. Pola sama dengan KARYAWAN_SPREADSHEET_ID di
// DAM PORTAL: fallback hardcode supaya app tetap hidup tanpa setup tambahan,
// tapi bisa dioverride lewat Script Properties TANPA edit kode (mis. saat ganti
// file tahunan). Kalau dua-duanya kosong, endpoint gagal dengan pesan jelas -
// bukan diam-diam membaca spreadsheet yang salah.
const NSRECORD_SPREADSHEET_ID =
  PropertiesService.getScriptProperties().getProperty('NSRECORD_SPREADSHEET_ID') ||
  '1qSTpi6OwUOBoORIALBCdwWehH-R0L8az4vwuaOV3shU';

// Spreadsheet autentikasi terpusat (sheet KARYAWAN) - sama dengan yang dipakai
// DAM PORTAL dan EWO. Struktur: A=NIK, B=Nama, C=Departemen, D=Jabatan,
// E=Otorisasi, F=Password, G=Email. Kolom modul dicari BY NAMA HEADER.
// Akun yang men-deploy web app ini WAJIB punya akses baca ke file itu -
// tanpa itu semua login gagal.
const KARYAWAN_SPREADSHEET_ID =
  PropertiesService.getScriptProperties().getProperty('KARYAWAN_SPREADSHEET_ID') ||
  '14OTl9xYINyRIqnJ2AEaCJFD_D9tNRRueNgFby6FjY9o';

const NSRECORD_SHEET_NAME = 'MASTER KARYAWAN';
const NSRECORD_CACHE_TTL_SECONDS = 600;
const NSRECORD_UNKNOWN = '(Tidak Diketahui)';

// Nama modul ini HARUS sama persis (case-insensitive) dengan header kolom di
// sheet KARYAWAN dan atribut data-module di index.html - lookup by header name,
// bukan huruf kolom, jadi aman kalau kolom baru disisipkan di tengah.
const NS_ACCESS_MODULES = ['NS Headcount', 'NS Contract', 'NS Recruitment'];

// Ambang batas watchlist kontrak (hari menuju Tgl Akhir Kontrak).
const NS_CONTRACT_CRITICAL_DAYS = 30;
const NS_CONTRACT_WARNING_DAYS = 60;
const NS_CONTRACT_WATCH_DAYS = 90;

// Ambang throttle login gagal per NIK - menutup brute-force password lewat
// google.script.run dari console browser.
const LOGIN_THROTTLE_MAX_ATTEMPTS = 5;
const LOGIN_THROTTLE_WINDOW_SEC = 900; // 15 menit

// =============================================================================
// ENTRY POINT
// =============================================================================

function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('NS RECORD')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// =============================================================================
// AUTENTIKASI - disalin dari WebApp.gs (DAM PORTAL) supaya app ini mandiri.
// Kalau logika auth di DAM PORTAL berubah, bagian ini TIDAK ikut berubah
// otomatis - itu harga yang dibayar untuk berdiri sendiri.
// =============================================================================

function nsWithRetry_(label, fn) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return fn();
    } catch (e) {
      lastErr = e;
      if (attempt < 3) Utilities.sleep(500 * attempt);
    }
  }
  throw new Error(label + ' gagal setelah 3 percobaan: ' + lastErr);
}

function getKaryawanData_() {
  return nsWithRetry_('Baca data KARYAWAN', function() {
    const ss = SpreadsheetApp.openById(KARYAWAN_SPREADSHEET_ID);
    // getSheetByName case-sensitive - terima variasi 'KARYAWAN'/'Karyawan'.
    let sheet = ss.getSheetByName('KARYAWAN');
    if (!sheet) {
      sheet = ss.getSheets().filter(function(s) {
        return s.getName().trim().toUpperCase() === 'KARYAWAN';
      })[0] || null;
    }
    if (!sheet) throw new Error("Sheet 'KARYAWAN' tidak ditemukan di file autentikasi.");
    return sheet.getDataRange().getValues();
  });
}

// Lookup hak modul BY NAMA HEADER (bukan huruf kolom hardcode) - sama persis
// dengan getModuleAccessMapFromRow_ di dt qdash.gs.
function getModuleAccessMapFromRow_(headerRow, dataRow, moduleNames) {
  const map = {};
  (moduleNames || []).forEach(function(name) {
    let colIndex = -1;
    for (let i = 0; i < headerRow.length; i++) {
      if (headerRow[i] && headerRow[i].toString().trim().toLowerCase() === name.toLowerCase()) {
        colIndex = i;
        break;
      }
    }
    map[name] = colIndex !== -1 && Number(dataRow[colIndex]) === 1;
  });
  return map;
}

function hasModuleAccess_(nik, moduleName) {
  try {
    const data = getKaryawanData_();
    if (!data || data.length < 2) return false;
    const nikTrim = nik ? nik.toString().trim() : '';
    if (!nikTrim) return false;
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] && data[i][0].toString().trim() === nikTrim) {
        return !!getModuleAccessMapFromRow_(data[0], data[i], [moduleName])[moduleName];
      }
    }
    return false;
  } catch (e) {
    return false;
  }
}

function nsBuildProfile_(row) {
  return {
    nik: row[0] || '',
    nama: row[1] || '',
    departemen: row[2] || '',
    jabatan: row[3] || ''
  };
}

function getKaryawanProfileByEmail_(email) {
  try {
    const emailNorm = (email || '').toString().trim().toLowerCase();
    if (!emailNorm) return null;
    const data = getKaryawanData_();
    if (!data || data.length < 2) return null;
    for (let i = 1; i < data.length; i++) {
      const rowEmail = (data[i][6] || '').toString().trim().toLowerCase(); // kolom G = Email
      if (rowEmail && rowEmail === emailNorm) return nsBuildProfile_(data[i]);
    }
  } catch (e) {}
  return null;
}

function getKaryawanProfileByNik_(nik) {
  try {
    const nikNorm = (nik || '').toString().trim();
    if (!nikNorm) return null;
    const data = getKaryawanData_();
    if (!data || data.length < 2) return null;
    for (let i = 1; i < data.length; i++) {
      const rowNik = (data[i][0] || '').toString().trim();
      if (rowNik && rowNik === nikNorm) return nsBuildProfile_(data[i]);
    }
  } catch (e) {}
  return null;
}

// Email sesi Google adalah identitas yang lebih kuat daripada nik yang dikirim
// client. Fallback ke nik client HANYA aman kalau deploy dibatasi domain -
// lihat peringatan deployment di header file.
function resolveRequestUserProfile_(requesterNik) {
  const requestedNik = (requesterNik || '').toString().trim();
  const sessionEmail = (Session.getActiveUser().getEmail() || '').toString().trim().toLowerCase();
  if (sessionEmail) {
    const sessionProfile = getKaryawanProfileByEmail_(sessionEmail);
    if (!sessionProfile) {
      return { ok: false, message: 'Email sesi Google tidak terdaftar di KARYAWAN.' };
    }
    return { ok: true, profile: sessionProfile, authSource: 'session-email' };
  }
  const nikProfile = getKaryawanProfileByNik_(requestedNik);
  if (nikProfile) return { ok: true, profile: nikProfile, authSource: 'client-nik' };
  return { ok: false, message: 'Identitas user tidak dapat diverifikasi.' };
}

function nsForbidden_(message) {
  return JSON.stringify({ status: 'forbidden', message: message, data: null });
}

// Guard server-side untuk semua endpoint data. Sengaja memakai pola
// requireModuleAccess_ (verifikasi email sesi dulu), BUKAN hasModuleAccess_
// polos yang langsung percaya nik client - data di app ini adalah data pribadi
// karyawan (tanggal lahir, alamat, kontrak), jadi pakai guard yang lebih kuat.
function requireModuleAccess_(requesterNik, moduleName) {
  const resolved = resolveRequestUserProfile_(requesterNik);
  if (!resolved.ok || !resolved.profile || !resolved.profile.nik) {
    return { ok: false, response: nsForbidden_(resolved.message || 'Akses ditolak.') };
  }
  if (hasModuleAccess_(resolved.profile.nik, moduleName)) {
    return { ok: true, profile: resolved.profile, authSource: resolved.authSource };
  }
  return {
    ok: false,
    response: nsForbidden_(
      'Anda tidak memiliki akses ke modul ' + moduleName +
      '. Hubungi admin jika ini seharusnya terbuka untuk Anda.'
    )
  };
}

// =============================================================================
// LOGIN & SESSION
// =============================================================================

function checkLoginThrottle_(nik) {
  if (!nik) return { ok: true };
  const raw = CacheService.getScriptCache().get('nsloginfail_' + nik);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= LOGIN_THROTTLE_MAX_ATTEMPTS) {
    return { ok: false, message: 'Terlalu banyak percobaan login gagal untuk NIK ini. Coba lagi dalam beberapa menit.' };
  }
  return { ok: true };
}

function recordLoginFailure_(nik) {
  if (!nik) return;
  const cache = CacheService.getScriptCache();
  const raw = cache.get('nsloginfail_' + nik);
  const count = (raw ? parseInt(raw, 10) : 0) + 1;
  cache.put('nsloginfail_' + nik, count.toString(), LOGIN_THROTTLE_WINDOW_SEC);
}

function clearLoginThrottle_(nik) {
  if (!nik) return;
  CacheService.getScriptCache().remove('nsloginfail_' + nik);
}

function nsUserResponse_(headerRow, row) {
  return {
    nik: row[0],
    nama: row[1],
    departemen: row[2],
    jabatan: row[3],
    otorisasi: (row[4] || '').toString().toLowerCase(),
    otorisasiModules: getModuleAccessMapFromRow_(headerRow, row, NS_ACCESS_MODULES)
  };
}

function userLogin(nik, password) {
  try {
    const nikNorm = (nik || '').toString().trim();
    const throttle = checkLoginThrottle_(nikNorm);
    if (!throttle.ok) return JSON.stringify({ success: false, message: throttle.message });

    const data = getKaryawanData_();
    for (let i = 1; i < data.length; i++) {
      if (data[i][0].toString().trim() === nikNorm &&
          data[i][5].toString().trim() === (password || '').toString().trim()) {
        clearLoginThrottle_(nikNorm);
        return JSON.stringify({ success: true, user: nsUserResponse_(data[0], data[i]) });
      }
    }
    recordLoginFailure_(nikNorm);
    return JSON.stringify({ success: false, message: 'NIK atau Password salah.' });
  } catch (error) {
    return JSON.stringify({ success: false, message: 'Terjadi error: ' + error.message });
  }
}

// Auto-login via akun Google (SSO). Hanya aktif kalau deploy "Anyone within
// domain" DAN kolom G (Email) di KARYAWAN terisi. Kalau gagal, client jatuh
// ke form login NIK.
function getSessionUser() {
  try {
    const email = (Session.getActiveUser().getEmail() || '').toString().trim().toLowerCase();
    if (!email) return JSON.stringify({ success: false, message: 'Email sesi Google tidak terdeteksi.' });
    const data = getKaryawanData_();
    for (let i = 1; i < data.length; i++) {
      const rowEmail = (data[i][6] || '').toString().trim().toLowerCase();
      if (rowEmail && rowEmail === email) {
        return JSON.stringify({ success: true, user: nsUserResponse_(data[0], data[i]) });
      }
    }
    return JSON.stringify({ success: false, message: 'Email ' + email + ' belum terdaftar di kolom G sheet KARYAWAN.' });
  } catch (e) {
    return JSON.stringify({ success: false, message: e.message });
  }
}

// Validasi ulang sesi tersimpan di browser. Identitas WAJIB lewat
// resolveRequestUserProfile_ - kalau ada sesi Google, nik hasil resolusi email
// menimpa nik kiriman client, supaya client tidak bisa memalsukan nik dari
// console browser untuk menarik profil user lain.
function revalidateUser(nik) {
  try {
    const resolved = resolveRequestUserProfile_(nik);
    if (!resolved.ok || !resolved.profile || !resolved.profile.nik) {
      return JSON.stringify({ success: false, message: resolved.message || 'User tidak ditemukan.' });
    }
    const verifiedNik = resolved.profile.nik.toString().trim();
    const data = getKaryawanData_();
    for (let i = 1; i < data.length; i++) {
      if (data[i][0].toString().trim() === verifiedNik) {
        return JSON.stringify({ success: true, user: nsUserResponse_(data[0], data[i]) });
      }
    }
    return JSON.stringify({ success: false, message: 'User tidak ditemukan.' });
  } catch (e) {
    return JSON.stringify({ success: false, message: e.message });
  }
}

// Ping ringan tiap 20 menit dari client - menjaga token OAuth GAS tetap hidup
// selama dashboard terbuka. Tidak membaca data apa pun.
function keepSessionAlive() {
  return true;
}

// =============================================================================
// PETA NORMALISASI
// =============================================================================
// Data sumber diisi manual oleh HR selama bertahun-tahun sehingga satu nilai
// bisa punya banyak ejaan. Peta di bawah dipakai SAAT BACA saja - sheet tidak
// pernah ditulis ulang, jadi input baru yang berantakan tetap tertangkap.
// Diverifikasi 16 Jul 2026 dari ref/EMPLOYEE DATA.xlsx via openpyxl (745 baris).

const NS_JABATAN_MAP = {
  'qc': 'QC',
  'quality control': 'QC',
  'quality patrol': 'QC Patrol',
  'qc patrol': 'QC Patrol',
  'qc produksi': 'QC Produksi',
  'qc lab': 'QC Lab',
  'qc incoming': 'QC Incoming',
  'qc line': 'QC Line',
  'engineerimg': 'Engineering',
  'teknisi': 'Technician',
  'forklift': 'Operator Forklift',
  'operator': 'Operator Production',
  '#n/a': NSRECORD_UNKNOWN
};

const NS_BAGIAN_MAP = {
  'production': 'Production',
  'produksi': 'Production',
  'logistic': 'Logistic',
  'hr & ga': 'HR & GA',
  'quality and research & development': 'Quality & RnD',
  '#n/a': NSRECORD_UNKNOWN
};

const NS_REFERENSI_MAP = {
  'karang taruna hegarmanag': 'Karang Taruna Hegarmanah',
  'pt karya manunggal jati': 'PT Karya Manunggal Jati',
  'smk negeri 1 purwakarta': 'SMK Negeri 1 Purwakarta',
  'pt mos': 'PT MOS',
  'ormas gmbi': 'Ormas GMBI',
  'ormas lmp': 'Ormas LMP',
  'ormas nkri': 'Ormas NKRI',
  'ormas grib': 'Ormas Grib',
  'h misja': 'H Misja'
};

function nsNormalizeTag_(str) {
  if (str === null || str === undefined) return '';
  return str.toString().toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Kolom yang dipakai modul ini -> daftar kemungkinan nama header di sheet.
// Dynamic Column Tagging: Lookup by header name & tag (bukan huruf kolom) supaya
// sisipan/perubahan kolom di tengah tidak merusak modul.
const NS_COLUMN_ALIASES = {
  no: ['NO', 'No', 'No.'],
  nik: ['NIK', 'Nik', 'No NIK'],
  noKtp: ['NO KTP', 'No KTP', 'KTP', 'No. KTP'],
  nama: ['NAMA', 'Nama', 'Nama Karyawan'],
  tempatLahir: ['TEMPAT', 'Tempat', 'Tempat Lahir'],
  tanggalLahir: ['TANGGAL LAHIR', 'Tanggal Lahir', 'Tanggal', 'Tgl Lahir'],
  usiaText: ['USIA', 'Usia'],
  gender: ['JENIS KELAMIN', 'Jenis Kelamin', 'Gender', 'JK'],
  bagian: ['DEPARTEMEN', 'Departement', 'Departemen', 'Dept', 'Bagian'],
  section: ['SECTION', 'Section', 'Bagian', 'Bagian / Section'],
  jabatan: ['JABATAN', 'Jabatan', 'Job Title'],
  mesin: ['MESIN', 'Mesin'],
  group: ['GROUP', 'Group', 'Grup'],
  tanggalMasuk: ['TANGGAL MASUK', 'Tanggal Masuk', 'Tgl Masuk'],
  tahun: ['TAHUN', 'Tahun'],
  bulan: ['BULAN', 'Bulan'],
  hari: ['HARI', 'Hari'],
  urutanKontrak: ['URUTAN KONTRAK', 'Urutan Kontrak', 'Keterangan Kontrak', 'Kontrak Ke'],
  keteranganKontrak: ['Keterangan Kontrak', 'URUTAN KONTRAK', 'Urutan Kontrak', 'Kontrak Ke'],
  tglAkhirKontrak: ['TANGGAL AKHIR KONTRAK', 'Tgl Akhir Kontrak', 'Tanggal Akhir Kontrak', 'Tgl. Akhir Kontrak'],
  alamatLengkap: ['ALAMAT LENGKAP', 'Alamat Lengkap', 'Alamat'],
  desa: ['DESA', 'Desa'],
  rt: ['RT', 'Rt'],
  rw: ['RW', 'Rw'],
  kelurahan: ['KELURAHAN', 'Kelurahan', 'Kp'],
  kecamatan: ['KECAMATAN', 'Kecamatan'],
  kota: ['KOTA/KABUPATEN', 'Kota/Kabupaten', 'Kota / Kabupaten', 'Kabupaten'],
  provinsi: ['PROVINSI', 'Provinsi'],
  ring: ['RING', 'Ring'],
  joinVia: ['JOIN VIA', 'Join Via'],
  jalurJoin: ['JALUR JOIN', 'Jalur Join'],
  referensi: ['REFERENSI JOIN', 'Referensi', 'Referensi Join'],
  referensiJoin: ['REFERENSI JOIN', 'Referensi Join'],
  status: ['STATUS', 'Status'],
  tanggalNonAktif: ['TANGGAL EFEKTIF NON AKTIF', 'Tanggal Efektif Non Aktif', 'Tanggal Efektifk Non Aktif', 'Tgl Non Aktif'],
  reasonKeluar: ['ALASAN KELUAR', 'Reason Keluar', 'Alasan Keluar'],
  alasanKeluar: ['ALASAN KELUAR', 'Alasan Keluar'],
  pendidikan: ['PENDIDIKAN', 'Pendidikan']
};

// Daftar field utama yang jika tidak ada sama sekali di header akan memicu warning missingColumns
const NS_REQUIRED_FIELDS = [
  'nik', 'nama', 'tanggalLahir', 'gender', 'bagian', 'tanggalMasuk',
  'keteranganKontrak', 'tglAkhirKontrak', 'status'
];

// =============================================================================
// HELPER NORMALISASI
// =============================================================================

function nsTrim_(value) {
  return value === null || value === undefined ? '' : value.toString().trim();
}

function nsTitleCase_(value) {
  const s = nsTrim_(value);
  if (!s) return '';
  return s.toLowerCase().split(/\s+/).map(function(word) {
    return word.charAt(0).toUpperCase() + word.slice(1);
  }).join(' ');
}

function nsLookupMap_(map, value, fallbackToTitleCase) {
  const s = nsTrim_(value);
  if (!s) return NSRECORD_UNKNOWN;
  const key = s.toLowerCase();
  if (map[key]) return map[key];
  return fallbackToTitleCase ? nsTitleCase_(s) : s;
}

function nsNormalizeJabatan_(value) {
  return nsLookupMap_(NS_JABATAN_MAP, value, true);
}

// Reclass by Jabatan: kolom Departement di sheet tidak bisa dipercaya - ada
// orang QC dan Engineering yang departemennya tertulis "Produksi". Fungsi
// jabatan lebih dekat ke kenyataan, jadi dipakai sebagai penentu.
// Keputusan user 16 Jul 2026.
//
// Efek nyata (diukur atas 745 baris ref/EMPLOYEE DATA.xlsx, 16 Jul 2026):
// 53 orang pindah dari Production -> Quality & RnD (33) / Engineering (20),
// dan SELURUHNYA berstatus NON AKTIF. Untuk karyawan AKTIF reclass tidak
// mengubah apa pun - data aktif sudah bersih. Jadi fungsi ini hanya berdampak
// pada panel Recruitment (memakai semua record), bukan panel Headcount.
function nsClassifyBagian_(bagianRaw, jabatanCanon) {
  const b = nsTrim_(jabatanCanon).toLowerCase();
  if (b.indexOf('qc') === 0) return 'Quality & RnD';
  if (b.indexOf('engineering') >= 0) return 'Engineering';
  if (b.indexOf('maintenance') >= 0) return 'Engineering';
  if (b.indexOf('teknisi') === 0) return 'Engineering';
  if (b === 'technician') return 'Engineering';
  if (b.indexOf('ehs') === 0) return 'Engineering';
  return nsLookupMap_(NS_BAGIAN_MAP, bagianRaw, true);
}

function nsNormalizeGender_(value) {
  const s = nsTrim_(value).toUpperCase();
  if (s === 'L') return 'L';
  if (s === 'P') return 'P';
  return NSRECORD_UNKNOWN;
}

function nsNormalizeJoinVia_(value) {
  const s = nsTrim_(value).toUpperCase();
  if (!s || s === '#N/A') return NSRECORD_UNKNOWN;
  return s;
}

function nsNormalizeReferensi_(value) {
  return nsLookupMap_(NS_REFERENSI_MAP, value, true);
}

function nsNormalizeSimple_(value) {
  const s = nsTrim_(value);
  if (!s || s === '#N/A') return NSRECORD_UNKNOWN;
  return s;
}

// Terima Date, string, dan angka serial Sheets (hasil paste-values) - pola yang
// sama dipakai normalizeDateOnly() di WebApp.gs / parseDateValue_() di dt summary.gs.
function nsParseDate_(value) {
  if (!value && value !== 0) return null;
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'number' && isFinite(value)) {
    const epoch = new Date(Date.UTC(1899, 11, 30));
    const d = new Date(epoch.getTime() + Math.round(value) * 86400000);
    return isNaN(d.getTime()) ? null : d;
  }
  const s = nsTrim_(value);
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function nsStartOfDay_(date) {
  const d = new Date(date.getTime());
  d.setHours(0, 0, 0, 0);
  return d;
}

function nsDiffDays_(fromDate, toDate) {
  const a = nsStartOfDay_(fromDate).getTime();
  const b = nsStartOfDay_(toDate).getTime();
  return Math.round((b - a) / 86400000);
}

function nsToIsoDate_(date) {
  return date ? Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd') : null;
}

// Usia dan masa kerja DIHITUNG ulang dari tanggal lahir / tanggal masuk, bukan
// dibaca dari kolom Usia / TAHUN / BULAN / HARI di sheet. Kolom-kolom itu diisi
// statis sekali saat entry dan sudah basi (mis. "24 Tahun" tidak ikut bertambah).
function nsCalcAge_(birthDate, refDate) {
  if (!birthDate) return null;
  let age = refDate.getFullYear() - birthDate.getFullYear();
  const monthDiff = refDate.getMonth() - birthDate.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && refDate.getDate() < birthDate.getDate())) age--;
  return age >= 0 && age < 120 ? age : null;
}

function nsCalcTenure_(joinDate, endDate) {
  if (!joinDate) return null;
  const ref = endDate || new Date();
  let months = (ref.getFullYear() - joinDate.getFullYear()) * 12 + (ref.getMonth() - joinDate.getMonth());
  if (ref.getDate() < joinDate.getDate()) months--;
  if (months < 0) return null;
  return { years: Math.floor(months / 12), months: months % 12, totalMonths: months };
}

function nsContractBucket_(daysLeft) {
  if (daysLeft === null) return 'Tanpa Tanggal';
  if (daysLeft < 0) return 'Lewat Jatuh Tempo';
  if (daysLeft <= NS_CONTRACT_CRITICAL_DAYS) return '0-30 Hari';
  if (daysLeft <= NS_CONTRACT_WARNING_DAYS) return '31-60 Hari';
  if (daysLeft <= NS_CONTRACT_WATCH_DAYS) return '61-90 Hari';
  return 'Di Atas 90 Hari';
}

// =============================================================================
// BACA & BANGUN RECORD
// =============================================================================

function nsGetSpreadsheet_() {
  if (!NSRECORD_SPREADSHEET_ID) {
    throw new Error(
      'NSRECORD_SPREADSHEET_ID belum diset. Buka GAS Editor project NS RECORD -> ' +
      'Project Settings -> Script Properties -> Add script property -> nama ' +
      'NSRECORD_SPREADSHEET_ID, isi dengan ID spreadsheet NS Record.'
    );
  }
  return SpreadsheetApp.openById(NSRECORD_SPREADSHEET_ID);
}

function nsGetSheet_(ss) {
  let sheet = ss.getSheetByName(NSRECORD_SHEET_NAME);
  if (!sheet) {
    // getSheetByName case-sensitive - terima variasi penulisan nama tab.
    sheet = ss.getSheets().filter(function(s) {
      return s.getName().trim().toUpperCase() === NSRECORD_SHEET_NAME.toUpperCase();
    })[0] || null;
  }
  if (!sheet) {
    throw new Error("Sheet '" + NSRECORD_SHEET_NAME + "' tidak ditemukan di spreadsheet NS Record.");
  }
  return sheet;
}

function nsBuildColumnIndex_(headerRow) {
  const index = { _tagMap: {} };
  
  // 1. Dynamic Tag Map: index every header in the sheet by normalized tag
  for (let i = 0; i < headerRow.length; i++) {
    const rawHeader = nsTrim_(headerRow[i]);
    const tag = nsNormalizeTag_(rawHeader);
    if (tag && index._tagMap[tag] === undefined) {
      index._tagMap[tag] = i;
    }
  }

  const missing = [];
  Object.keys(NS_COLUMN_ALIASES).forEach(function(field) {
    const aliasList = NS_COLUMN_ALIASES[field];
    let found = -1;

    // A. Match persis (case insensitive)
    for (let i = 0; i < headerRow.length; i++) {
      const h = nsTrim_(headerRow[i]).toLowerCase();
      if (h && aliasList.some(function(a) { return a.toLowerCase() === h; })) {
        found = i;
        break;
      }
    }

    // B. Dynamic Tag Matching fallback
    if (found === -1) {
      for (let k = 0; k < aliasList.length; k++) {
        const aliasTag = nsNormalizeTag_(aliasList[k]);
        if (aliasTag && index._tagMap[aliasTag] !== undefined) {
          found = index._tagMap[aliasTag];
          break;
        }
      }
    }

    index[field] = found;
    if (found === -1 && NS_REQUIRED_FIELDS.indexOf(field) !== -1) {
      missing.push(aliasList[0]);
    }
  });

  index._missing = missing;
  return index;
}

function nsCell_(row, index, field) {
  let i = index ? index[field] : undefined;
  if ((i === undefined || i === -1) && index && index._tagMap) {
    const fieldTag = nsNormalizeTag_(field);
    if (index._tagMap[fieldTag] !== undefined) {
      i = index._tagMap[fieldTag];
    }
  }
  return (i === undefined || i === -1) ? null : row[i];
}

// Membangun daftar record bersih. Baris yang seluruh kolom kuncinya kosong
// dilewati - sheet sumber punya ~1000 baris berisi empty string (sisa formula
// dan formatting), bukan data.
function nsBuildRecords_() {
  const ss = nsGetSpreadsheet_();
  const sheet = nsGetSheet_(ss);
  const values = sheet.getDataRange().getValues();
  if (!values || values.length < 2) {
    return { records: [], missingColumns: [], duplicateNiks: [] };
  }

  const index = nsBuildColumnIndex_(values[0]);
  const today = nsStartOfDay_(new Date());
  const records = [];
  const nikSeen = {};
  const duplicateNiks = {};

  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const nik = nsTrim_(nsCell_(row, index, 'nik'));
    const nama = nsTrim_(nsCell_(row, index, 'nama'));
    if (!nik && !nama) continue;

    const jabatan = nsNormalizeJabatan_(nsCell_(row, index, 'jabatan'));
    const deptRaw = nsCell_(row, index, 'bagian');
    const sectionRaw = nsCell_(row, index, 'section');
    const bagian = nsClassifyBagian_(deptRaw, jabatan);
    const birthDate = nsParseDate_(nsCell_(row, index, 'tanggalLahir'));
    const joinDate = nsParseDate_(nsCell_(row, index, 'tanggalMasuk'));
    const endContract = nsParseDate_(nsCell_(row, index, 'tglAkhirKontrak'));
    const exitDate = nsParseDate_(nsCell_(row, index, 'tanggalNonAktif'));
    const status = nsTrim_(nsCell_(row, index, 'status')).toUpperCase();
    const isActive = status === 'AKTIF';
    const daysLeft = endContract ? nsDiffDays_(today, endContract) : null;
    const tenure = nsCalcTenure_(joinDate, isActive ? null : exitDate);

    if (nik) {
      if (nikSeen[nik]) duplicateNiks[nik] = true;
      nikSeen[nik] = true;
    }

    let usiaVal = nsCalcAge_(birthDate, today);
    if (usiaVal === null) {
      const uText = nsCell_(row, index, 'usiaText');
      if (typeof uText === 'number') usiaVal = Math.floor(uText);
      else if (uText) {
        const p = parseInt(String(uText).replace(/\D/g, ''), 10);
        if (!isNaN(p)) usiaVal = p;
      }
    }

    records.push({
      rowNumber: r + 1,               // kunci internal drill-down - BUKAN nik, karena nik terbukti tidak unik
      nik: nik || NSRECORD_UNKNOWN,
      noKtp: nsTrim_(nsCell_(row, index, 'noKtp')),
      nama: nama,
      gender: nsNormalizeGender_(nsCell_(row, index, 'gender')),
      usia: usiaVal,
      bagian: bagian,
      bagianRaw: nsTrim_(sectionRaw || deptRaw),
      jabatan: jabatan,
      mesin: nsNormalizeSimple_(nsCell_(row, index, 'mesin')),
      group: nsNormalizeSimple_(nsCell_(row, index, 'group')),
      tanggalMasuk: nsToIsoDate_(joinDate),
      masaKerjaBulan: tenure ? tenure.totalMonths : null,
      masaKerjaText: tenure ? (tenure.years + ' Thn ' + tenure.months + ' Bln') : null,
      bucketMasaKerja: tenure ? (tenure.years < 1 ? '< 1 Tahun' : (tenure.years < 3 ? '1-3 Tahun' : (tenure.years < 5 ? '3-5 Tahun' : '> 5 Tahun'))) : NSRECORD_UNKNOWN,
      keteranganKontrak: nsNormalizeSimple_(nsCell_(row, index, 'urutanKontrak') || nsCell_(row, index, 'keteranganKontrak')),
      tglAkhirKontrak: nsToIsoDate_(endContract),
      sisaHariKontrak: daysLeft,
      bucketKontrak: nsContractBucket_(daysLeft),
      alamatLengkap: nsTrim_(nsCell_(row, index, 'alamatLengkap')),
      desa: nsTitleCase_(nsCell_(row, index, 'desa')),
      rt: nsTrim_(nsCell_(row, index, 'rt')),
      rw: nsTrim_(nsCell_(row, index, 'rw')),
      kelurahan: nsTitleCase_(nsCell_(row, index, 'kelurahan')),
      kecamatan: nsTitleCase_(nsCell_(row, index, 'kecamatan')),
      kota: nsTitleCase_(nsCell_(row, index, 'kota')),
      provinsi: nsTitleCase_(nsCell_(row, index, 'provinsi')),
      ring: nsNormalizeSimple_(nsCell_(row, index, 'ring')),
      joinVia: nsNormalizeJoinVia_(nsCell_(row, index, 'joinVia')),
      referensi: nsNormalizeReferensi_(nsCell_(row, index, 'referensiJoin') || nsCell_(row, index, 'referensi')),
      jalurJoin: nsNormalizeSimple_(nsCell_(row, index, 'jalurJoin')),
      status: status || NSRECORD_UNKNOWN,
      isActive: isActive,
      tanggalNonAktif: nsToIsoDate_(exitDate),
      reasonKeluar: nsTrim_(nsCell_(row, index, 'alasanKeluar') || nsCell_(row, index, 'reasonKeluar')).toUpperCase() || null,
      pendidikan: nsNormalizeSimple_(nsCell_(row, index, 'pendidikan'))
    });
  }

  // Bangun daftar bentrok NIK untuk banner warning di UI. Per 16 Jul 2026 ada 2
  // NIK dipakai 2 orang berbeda (328000690, 328000691) - masalah integritas di
  // sheet sumber yang hanya bisa diperbaiki HR, bukan oleh kode ini.
  const dupList = Object.keys(duplicateNiks).map(function(nik) {
    return {
      nik: nik,
      orang: records.filter(function(x) { return x.nik === nik; })
        .map(function(x) {
          return { nama: x.nama, bagian: x.bagian, status: x.status, rowNumber: x.rowNumber };
        })
    };
  });

  return { records: records, missingColumns: index._missing, duplicateNiks: dupList };
}

function nsCountBy_(records, field) {
  const counts = {};
  records.forEach(function(rec) {
    const key = rec[field] || NSRECORD_UNKNOWN;
    counts[key] = (counts[key] || 0) + 1;
  });
  return Object.keys(counts).map(function(k) {
    return { label: k, value: counts[k] };
  }).sort(function(a, b) { return b.value - a.value; });
}

function nsAgeBucket_(usia) {
  if (usia === null) return NSRECORD_UNKNOWN;
  if (usia <= 20) return '<= 20';
  if (usia <= 25) return '21-25';
  if (usia <= 30) return '26-30';
  if (usia <= 35) return '31-35';
  return '> 35';
}

function nsCacheKey_(prefix) {
  return 'nsrecord:' + prefix + ':v1';
}

function nsCacheGet_(key) {
  try {
    const raw = CacheService.getScriptCache().get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function nsCachePut_(key, obj) {
  try {
    const raw = JSON.stringify(obj);
    if (raw.length <= 95000) CacheService.getScriptCache().put(key, raw, NSRECORD_CACHE_TTL_SECONDS);
  } catch (e) {}
}

// =============================================================================
// ENDPOINT - dipanggil index.html via google.script.run
// =============================================================================

function getNsHeadcountData(nik) {
  const gate = requireModuleAccess_(nik, 'NS Headcount');
  if (!gate.ok) return gate.response;
  try {
    const cacheKey = nsCacheKey_('headcount');
    const cached = nsCacheGet_(cacheKey);
    if (cached) return JSON.stringify(cached);

    const built = nsBuildRecords_();
    const all = built.records;
    const aktif = all.filter(function(r) { return r.isActive; });
    const nonAktif = all.filter(function(r) { return !r.isActive; });

    const withAge = aktif.filter(function(r) { return r.usia !== null; });
    const avgAge = withAge.length
      ? Math.round((withAge.reduce(function(s, r) { return s + r.usia; }, 0) / withAge.length) * 10) / 10
      : null;
    const withTenure = aktif.filter(function(r) { return r.masaKerjaBulan !== null; });
    const avgTenure = withTenure.length
      ? Math.round((withTenure.reduce(function(s, r) { return s + r.masaKerjaBulan; }, 0) / withTenure.length) * 10) / 10
      : null;

    const ageRecords = aktif.map(function(r) { return { bucket: nsAgeBucket_(r.usia) }; });

    const response = {
      status: 'success',
      data: {
        kpi: {
          totalAktif: aktif.length,
          totalNonAktif: nonAktif.length,
          total: all.length,
          rataUsia: avgAge,
          rataMasaKerjaBulan: avgTenure
        },
        perDepartement: nsCountBy_(aktif, 'bagian'),
        perBagian: nsCountBy_(aktif, 'bagianRaw'),
        perJabatan: nsCountBy_(aktif, 'jabatan'),
        perGroup: nsCountBy_(aktif, 'group'),
        perGender: nsCountBy_(aktif, 'gender'),
        perRing: nsCountBy_(aktif, 'ring'),
        perUsia: nsCountBy_(ageRecords, 'bucket'),
        perPendidikan: nsCountBy_(aktif, 'pendidikan'),
        perMasaKerja: nsCountBy_(aktif, 'bucketMasaKerja'),
        warnings: {
          duplicateNiks: built.duplicateNiks,
          missingColumns: built.missingColumns
        }
      }
    };
    nsCachePut_(cacheKey, response);
    return JSON.stringify(response);
  } catch (error) {
    return JSON.stringify({ status: 'error', message: error.toString(), data: null });
  }
}

function getNsContractData(nik) {
  const gate = requireModuleAccess_(nik, 'NS Contract');
  if (!gate.ok) return gate.response;
  try {
    const cacheKey = nsCacheKey_('contract');
    const cached = nsCacheGet_(cacheKey);
    if (cached) return JSON.stringify(cached);

    const built = nsBuildRecords_();
    const aktif = built.records.filter(function(r) { return r.isActive; });

    const watchlist = aktif
      .filter(function(r) { return r.sisaHariKontrak !== null && r.sisaHariKontrak <= NS_CONTRACT_WATCH_DAYS; })
      .sort(function(a, b) { return a.sisaHariKontrak - b.sisaHariKontrak; })
      .map(function(r) {
        return {
          rowNumber: r.rowNumber, nik: r.nik, nama: r.nama,
          bagian: r.bagian, jabatan: r.jabatan, group: r.group,
          keteranganKontrak: r.keteranganKontrak, tglAkhirKontrak: r.tglAkhirKontrak,
          sisaHariKontrak: r.sisaHariKontrak, bucket: r.bucketKontrak,
          masaKerjaText: r.masaKerjaText
        };
      });

    const countBucket = function(name) {
      return aktif.filter(function(r) { return r.bucketKontrak === name; }).length;
    };

    const response = {
      status: 'success',
      data: {
        kpi: {
          lewatJatuhTempo: countBucket('Lewat Jatuh Tempo'),
          kritis30: countBucket('0-30 Hari'),
          waspada60: countBucket('31-60 Hari'),
          pantau90: countBucket('61-90 Hari'),
          aman: countBucket('Di Atas 90 Hari'),
          tanpaTanggal: countBucket('Tanpa Tanggal'),
          totalAktif: aktif.length
        },
        perBucket: nsCountBy_(aktif, 'bucketKontrak'),
        perKeteranganKontrak: nsCountBy_(aktif, 'keteranganKontrak'),
        watchlist: watchlist,
        warnings: {
          duplicateNiks: built.duplicateNiks,
          missingColumns: built.missingColumns
        }
      }
    };
    nsCachePut_(cacheKey, response);
    return JSON.stringify(response);
  } catch (error) {
    return JSON.stringify({ status: 'error', message: error.toString(), data: null });
  }
}

function getNsRecruitmentData(nik) {
  const gate = requireModuleAccess_(nik, 'NS Recruitment');
  if (!gate.ok) return gate.response;
  try {
    const cacheKey = nsCacheKey_('recruitment');
    const cached = nsCacheGet_(cacheKey);
    if (cached) return JSON.stringify(cached);

    const built = nsBuildRecords_();
    const all = built.records;
    const aktif = all.filter(function(r) { return r.isActive; });
    const nonAktif = all.filter(function(r) { return !r.isActive; });

    // Retensi per sumber rekrutmen: dari semua orang yang pernah masuk lewat
    // sumber ini, berapa persen yang masih aktif. Ini yang membedakan sumber
    // yang mendatangkan banyak orang dari sumber yang mendatangkan orang bertahan.
    const sources = {};
    all.forEach(function(r) {
      const key = r.joinVia;
      if (!sources[key]) sources[key] = { label: key, total: 0, aktif: 0 };
      sources[key].total++;
      if (r.isActive) sources[key].aktif++;
    });
    const perJoinVia = Object.keys(sources).map(function(k) {
      const s = sources[k];
      return {
        label: s.label, total: s.total, aktif: s.aktif, keluar: s.total - s.aktif,
        retensiPersen: s.total ? Math.round((s.aktif / s.total) * 1000) / 10 : 0
      };
    }).sort(function(a, b) { return b.total - a.total; });

    // Tren rekrutmen per bulan berdasarkan Tanggal Masuk.
    const byMonth = {};
    all.forEach(function(r) {
      if (!r.tanggalMasuk) return;
      const ym = r.tanggalMasuk.slice(0, 7);
      byMonth[ym] = (byMonth[ym] || 0) + 1;
    });
    const trenMasuk = Object.keys(byMonth).sort().map(function(k) {
      return { label: k, value: byMonth[k] };
    });

    const response = {
      status: 'success',
      data: {
        kpi: {
          total: all.length,
          totalAktif: aktif.length,
          jumlahSumber: perJoinVia.length,
          jumlahReferensi: nsCountBy_(all, 'referensi').length
        },
        perJoinVia: perJoinVia,
        perReferensi: nsCountBy_(all, 'referensi'),
        perReasonKeluar: nsCountBy_(nonAktif.filter(function(r) { return r.reasonKeluar; }), 'reasonKeluar'),
        perRing: nsCountBy_(aktif, 'ring'),
        perKecamatan: nsCountBy_(aktif, 'kecamatan').slice(0, 15),
        trenMasuk: trenMasuk,
        warnings: {
          duplicateNiks: built.duplicateNiks,
          missingColumns: built.missingColumns
        }
      }
    };
    nsCachePut_(cacheKey, response);
    return JSON.stringify(response);
  } catch (error) {
    return JSON.stringify({ status: 'error', message: error.toString(), data: null });
  }
}

// Dipanggil manual dari GAS Editor untuk memverifikasi koneksi + struktur kolom
// spreadsheet NS Record tanpa harus lewat UI dashboard.
function nsRecordSelfTest() {
  const built = nsBuildRecords_();
  const aktif = built.records.filter(function(r) { return r.isActive; });
  Logger.log('Total record  : ' + built.records.length);
  Logger.log('Aktif         : ' + aktif.length);
  Logger.log('Non Aktif     : ' + (built.records.length - aktif.length));
  Logger.log('Kolom hilang  : ' + (built.missingColumns.length ? built.missingColumns.join(', ') : 'tidak ada'));
  Logger.log('NIK duplikat  : ' + (built.duplicateNiks.length ? built.duplicateNiks.map(function(d) { return d.nik; }).join(', ') : 'tidak ada'));
  Logger.log('Per bagian: ' + JSON.stringify(nsCountBy_(aktif, 'bagian')));
  return built.records.length;
}
