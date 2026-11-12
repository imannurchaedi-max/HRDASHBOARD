/**
 * =============================================================================
 * ns record.gs - Backend standalone HR DASHBOARD v2 (Non Staff Record)
 * =============================================================================
 * Hasil "extract balik" dari DAM PORTAL (0. DT SUMMARY) per 12 Nov 2026,
 * direvisi setelah code review independen.
 *
 * ASAL MUASAL (jejak porting, jangan dihapus):
 *   Portal     : active trial/trial_hr_domain.gs   (1.636 baris)
 *   Standalone : ACTIVE/ns record.gs               (1.897 baris, Sep 2026)
 *   Commit integrasi pertama: 05bbebc (2 Okt 2026, rilis v182)
 *
 * ISI FOLDER ACTIVE-v2:
 *   ns domain.gs         <- salinan portal + PATCH KEAMANAN (lihat daftar di header file itu)
 *   ns record.gs         <- file ini: jembatan auth SSO, cache, admin, doGet
 *   index.html           <- shell standalone (nav, tema, loader, bootstrap sesi)
 *   TrialFrontendHr.html <- SALINAN VERBATIM partial portal (self-contained)
 *
 * KONTRAK YANG DIPAKAI ns domain.gs (jangan diubah namanya):
 *   requireModuleAccess_(nik, modul)   -> gerbang 4 endpoint HR
 *   getKaryawanProfileByEmail_(email)  -> resolver identitas
 *   getKaryawanSpreadsheetId_()        -> dipakai patch nsInspectSpreadsheetLive_
 *   nsAssertAdmin_(konteks)            -> dipakai patch fungsi administrasi
 *
 * =============================================================================
 * AUTENTIKASI: SSO (email Google). Login NIK/password standalone DIHAPUS.
 * =============================================================================
 * Identitas diambil dari Session.getActiveUser().getEmail(), BUKAN dari
 * parameter NIK di browser. `requesterNik` dari client diabaikan sepenuhnya.
 *
 * KOREKSI PENTING soal Session (sempat salah ditulis di revisi pertama):
 *   - getActiveUser()   = user yang sedang mengakses. Email bisa KOSONG bila
 *                         identitas tidak tersedia (mis. eksekusi trigger yang
 *                         tidak punya user aktif).
 *   - getEffectiveUser()= akun yang otoritasnya dipakai untuk eksekusi
 *                         (deployer pada mode "Execute as: Me").
 *   Jadi "USER_DEPLOYING membuat getActiveUser() selalu = email pemilik" itu
 *   TIDAK benar sebagai aturan umum. Perilaku nyata bergantung domain dan harus
 *   diuji empiris (lihat README-DEPLOY.md bagian 4-5).
 *
 * Mode yang dipakai: `executeAs: USER_ACCESSING`.
 *   Alasan: identitas per-pengguna deterministik.
 *   Biaya : script berjalan dengan otoritas pengunjung, sehingga user HARUS
 *           punya akses baca ke spreadsheet HR + autentikasi. Artinya izin
 *           modul di aplikasi ini bersifat tingkat-API, BUKAN isolasi data:
 *           yang bisa membuka spreadsheet langsung tetap bisa membaca semua.
 *           Bila isolasi data wajib, pakai arsitektur portal (USER_DEPLOYING),
 *           bukan aplikasi standalone ini. Lihat README bagian 4.
 *
 * KONSEKUENSI OPERASIONAL: scheduler harian berjalan tanpa user aktif, jadi
 * jalurnya diberi pengecualian sempit - hanya menerima NIK yang tercatat di
 * Script Property NS_DASHBOARD_REFRESH_NIK (dikelola admin), tidak menerima
 * identitas lain. Lihat requireModuleAccess_().
 * =============================================================================
 */

// -----------------------------------------------------------------------------
// KONFIGURASI
// -----------------------------------------------------------------------------
const NS_APP_TITLE = 'HR DASHBOARD - Non Staff';

const NS_AUTH_PROPERTY_KARYAWAN = 'KARYAWAN_SPREADSHEET_ID';
const NS_AUTH_PROPERTY_HR = 'NSRECORD_SPREADSHEET_ID';
const NS_AUTH_PROPERTY_ADMIN_NIKS = 'NS_ADMIN_NIKS';
const NS_AUTH_PROPERTY_ADMIN_EMAILS = 'NS_ADMIN_EMAILS';
const NS_AUTH_PROPERTY_SCHEDULER_NIK = 'NS_DASHBOARD_REFRESH_NIK';

// Fallback sama dengan yang dipakai portal & standalone lama.
const NS_AUTH_FALLBACK_KARYAWAN_SS = '14OTl9xYINyRIqnJ2AEaCJFD_D9tNRRueNgFby6FjY9o';
const NS_AUTH_FALLBACK_HR_SS = '1qSTpi6OwUOBoORIALBCdwWehH-R0L8az4vwuaOV3shU';

const NS_KARYAWAN_SHEET_NAME = 'KARYAWAN';

// Hanya 4 modul HR. PORTAL_ACCESS_MODULES penuh sengaja TIDAK dibawa karena
// modul portal lain (OEE, Quality, TPP, dst.) tidak ada di aplikasi standalone ini.
const HR_ACCESS_MODULES = ['NS Headcount', 'NS Contract', 'NS Recruitment', 'NS Manning'];

// Cache baca sheet KARYAWAN.
// TTL sengaja pendek: pencabutan izin di sheet baru berlaku setelah cache
// kedaluwarsa. Semakin pendek, semakin cepat pencabutan efektif, semakin mahal
// pembacaan sheet. 120 detik = kompromi; dokumentasikan SLA ke user.
const NS_AUTH_CACHE_PREFIX = 'NS_KARYAWAN_V2';
const NS_AUTH_CACHE_TTL_SECONDS = 120;
const NS_AUTH_CACHE_MAX_CHUNK_BYTES = 90000; // batas aman di bawah 100 KB/key
const NS_AUTH_CACHE_MAX_CHUNKS = 25;

// -----------------------------------------------------------------------------
// CACHE SHEET KARYAWAN
// -----------------------------------------------------------------------------
// Desain: setiap penulisan memakai "generasi" unik. Key chunk diberi nama
// generasi, dan metadata (gen + jumlah chunk + panjang total) ditulis TERAKHIR.
// Pembaca hanya merakit chunk dari generasi yang disebut metadata, lalu
// memverifikasi panjang hasil rakit. Ini mencegah dua masalah:
//   1. chunk lintas generasi tercampur menjadi JSON valid tapi salah
//   2. sisa chunk generasi lama ikut terpakai
// Cache juga diberi namespace per spreadsheet, agar mengganti ID spreadsheet
// tidak menyajikan data file lama.

function nsAuthCacheKeyPrefix_(spreadsheetId) {
  return NS_AUTH_CACHE_PREFIX + ':' + String(spreadsheetId || '-');
}

function nsAuthCacheMetaKey_(spreadsheetId) {
  return nsAuthCacheKeyPrefix_(spreadsheetId) + ':meta';
}

/**
 * Pecah string menjadi potongan yang aman secara BYTE (bukan karakter).
 * CacheService membatasi ~100 KB per key dalam byte; teks Unicode multi-byte
 * bisa jauh melebihi batas bila dihitung sebagai karakter.
 */
function nsSplitByBytes_(text, maxBytes) {
  const chunks = [];
  let index = 0;
  while (index < text.length) {
    let take = Math.min(4000, text.length - index);
    let piece = text.substr(index, take);
    let bytes = Utilities.newBlob(piece).getBytes().length;

    if (bytes > maxBytes) {
      // perkecil sampai masuk batas
      while (take > 1) {
        take = Math.ceil(take / 2);
        piece = text.substr(index, take);
        bytes = Utilities.newBlob(piece).getBytes().length;
        if (bytes <= maxBytes) break;
      }
      if (bytes > maxBytes) return null; // satu karakter pun tidak muat
    } else {
      // perbesar selama masih muat (hemat jumlah chunk)
      while (take < text.length - index) {
        const nextTake = Math.min(take + 4000, text.length - index);
        const nextPiece = text.substr(index, nextTake);
        if (Utilities.newBlob(nextPiece).getBytes().length > maxBytes) break;
        take = nextTake;
        piece = nextPiece;
      }
    }

    chunks.push(piece);
    index += take;
    if (chunks.length > NS_AUTH_CACHE_MAX_CHUNKS) return null;
  }
  return chunks;
}

function nsAuthCacheGet_(spreadsheetId) {
  try {
    const cache = CacheService.getScriptCache();
    const metaRaw = cache.get(nsAuthCacheMetaKey_(spreadsheetId));
    if (!metaRaw) return null;

    let meta;
    try { meta = JSON.parse(metaRaw); } catch (e) { return null; }
    if (!meta || !meta.gen || !meta.total || !meta.length) return null;
    if (meta.spreadsheetId && meta.spreadsheetId !== String(spreadsheetId)) return null;
    if (meta.total < 1 || meta.total > NS_AUTH_CACHE_MAX_CHUNKS) return null;

    const prefix = nsAuthCacheKeyPrefix_(spreadsheetId) + ':' + meta.gen + ':';
    const keys = [];
    for (let i = 0; i < meta.total; i++) keys.push(prefix + i);

    const parts = cache.getAll(keys);
    let json = '';
    for (let i = 0; i < meta.total; i++) {
      const chunk = parts[keys[i]];
      if (chunk === null || chunk === undefined) return null; // cache miss
      json += chunk;
    }

    if (json.length !== meta.length) return null; // integritas gagal -> anggap miss
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}

function nsAuthCachePut_(spreadsheetId, data) {
  try {
    const json = JSON.stringify(data || []);
    if (!json) return;

    const chunks = nsSplitByBytes_(json, NS_AUTH_CACHE_MAX_CHUNK_BYTES);
    if (!chunks || !chunks.length) return; // terlalu besar: lewati cache

    const gen = String(new Date().getTime()) + '-' + Math.random().toString(36).slice(2, 8);
    const prefix = nsAuthCacheKeyPrefix_(spreadsheetId) + ':' + gen + ':';

    const entries = {};
    chunks.forEach(function (chunk, i) { entries[prefix + i] = chunk; });

    const cache = CacheService.getScriptCache();
    cache.putAll(entries, NS_AUTH_CACHE_TTL_SECONDS);

    // Metadata ditulis TERAKHIR: pembaca tidak akan melihat metadata untuk
    // generasi yang chunk-nya belum lengkap.
    cache.put(nsAuthCacheMetaKey_(spreadsheetId), JSON.stringify({
      gen: gen,
      total: chunks.length,
      length: json.length,
      spreadsheetId: String(spreadsheetId),
      writtenAt: new Date().getTime()
    }), NS_AUTH_CACHE_TTL_SECONDS);

    // Bersihkan generasi sebelumnya (best effort). Kunci generasi lama akan
    // kedaluwarsa sendiri bila pembersihan gagal.
    if (nsAuthCacheGet_LastGen_(spreadsheetId) && nsAuthCacheGet_LastGen_(spreadsheetId) !== gen) {
      const oldPrefix = nsAuthCacheKeyPrefix_(spreadsheetId) + ':' + nsAuthCacheGet_LastGen_(spreadsheetId) + ':';
      const oldKeys = [];
      for (let i = 0; i < NS_AUTH_CACHE_MAX_CHUNKS; i++) oldKeys.push(oldPrefix + i);
      cache.removeAll(oldKeys);
    }
    nsAuthCacheSet_LastGen_(spreadsheetId, gen);
  } catch (e) {
    // Gagal cache bukan error fatal.
  }
}

// Penanda generasi terakhir disimpan singkat di cache (bukan Script Property)
// agar tidak menulis property pada setiap request.
function nsAuthCacheGet_LastGen_(spreadsheetId) {
  try {
    return CacheService.getScriptCache().get(nsAuthCacheKeyPrefix_(spreadsheetId) + ':lastgen') || null;
  } catch (e) { return null; }
}
function nsAuthCacheSet_LastGen_(spreadsheetId, gen) {
  try {
    CacheService.getScriptCache().put(nsAuthCacheKeyPrefix_(spreadsheetId) + ':lastgen', gen, NS_AUTH_CACHE_TTL_SECONDS);
  } catch (e) {}
}

function nsAuthInvalidateCache_(spreadsheetId) {
  try {
    const cache = CacheService.getScriptCache();
    const keys = [nsAuthCacheMetaKey_(spreadsheetId), nsAuthCacheKeyPrefix_(spreadsheetId) + ':lastgen'];
    const lastGen = nsAuthCacheGet_LastGen_(spreadsheetId);
    for (let i = 0; i < NS_AUTH_CACHE_MAX_CHUNKS; i++) {
      if (lastGen) keys.push(nsAuthCacheKeyPrefix_(spreadsheetId) + ':' + lastGen + ':' + i);
    }
    cache.removeAll(keys);
  } catch (e) {}
}

// -----------------------------------------------------------------------------
// AKSES SPREADSHEET AUTENTIKASI (KARYAWAN)
// -----------------------------------------------------------------------------
function nsAuthGetProperty_(name, fallback) {
  try {
    const value = PropertiesService.getScriptProperties().getProperty(name);
    if (value && String(value).trim()) return String(value).trim();
  } catch (e) {}
  return fallback;
}

function getKaryawanSpreadsheetId_() {
  return nsAuthGetProperty_(NS_AUTH_PROPERTY_KARYAWAN, NS_AUTH_FALLBACK_KARYAWAN_SS);
}

function getHrSpreadsheetId_() {
  return nsAuthGetProperty_(NS_AUTH_PROPERTY_HR, NS_AUTH_FALLBACK_HR_SS);
}

/**
 * Membaca sheet KARYAWAN. Melempar Error bila gagal (akses ditolak / layanan
 * gangguan) supaya pemanggil bisa membedakan "profil tidak ditemukan" dari
 * "tidak bisa membaca spreadsheet". Versi pertama menelan error ini dan
 * melaporkan semua kegagalan sebagai "email tidak terdaftar" - menyesatkan.
 */
function getKaryawanData_() {
  const spreadsheetId = getKaryawanSpreadsheetId_();

  const cached = nsAuthCacheGet_(spreadsheetId);
  if (cached) return cached;

  const ss = SpreadsheetApp.openById(spreadsheetId);
  let sheet = ss.getSheetByName(NS_KARYAWAN_SHEET_NAME);
  if (!sheet) {
    sheet = ss.getSheets().filter(function (candidate) {
      return candidate.getName().trim().toUpperCase() === NS_KARYAWAN_SHEET_NAME;
    })[0] || null;
  }
  if (!sheet) {
    throw new Error("Sheet 'KARYAWAN' tidak ditemukan di spreadsheet autentikasi (" + spreadsheetId + ").");
  }

  const data = sheet.getDataRange().getValues();
  nsAuthCachePut_(spreadsheetId, data);
  return data;
}

// Porting apa adanya dari portal (trial_auth_domain.gs / dt qdash.gs).
function getKaryawanColIndexMap_(headerRow) {
  const map = {
    nik: 0,
    nama: 1,
    departemen: 2,
    jabatan: 3,
    level: -1,
    otorisasi: 4,
    password: 5,
    email: 6
  };
  if (!headerRow || !headerRow.length) return map;
  for (let i = 0; i < headerRow.length; i++) {
    const h = (headerRow[i] || '').toString().trim().toLowerCase();
    if (h === 'nik') map.nik = i;
    else if (h === 'nama') map.nama = i;
    else if (h === 'departemen') map.departemen = i;
    else if (h === 'jabatan') map.jabatan = i;
    else if (h === 'level') map.level = i;
    else if (h === 'otorisasi') map.otorisasi = i;
    else if (h === 'password') map.password = i;
    else if (h === 'email') map.email = i;
  }
  return map;
}

/**
 * Pencocokan header toleran spasi - porting perbaikan produksi v214 (22 Okt 2026).
 * Header sheet KARYAWAN sering terbungkus text-wrap vertikal atau berspasi
 * renggang sehingga pencocokan persis gagal. Normalisasi spasi + fallback
 * bentuk kompak menutup kasus itu.
 */
function getModuleAccessMapFromRow_(headerRow, dataRow, moduleNames) {
  const map = {};
  (moduleNames || []).forEach(function (name) {
    let colIndex = -1;
    const targetNorm = (name || '').toString().trim().toLowerCase().replace(/\s+/g, ' ');
    const targetCompact = targetNorm.replace(/\s+/g, '');
    for (let i = 0; i < headerRow.length; i++) {
      if (!headerRow[i]) continue;
      const hNorm = headerRow[i].toString().trim().toLowerCase().replace(/\s+/g, ' ');
      const hCompact = hNorm.replace(/\s+/g, '');
      if (hNorm === targetNorm || hCompact === targetCompact) {
        colIndex = i;
        break;
      }
    }
    map[name] = colIndex !== -1 && Number(dataRow[colIndex]) === 1;
  });
  return map;
}

function getSignatureFromRow_(headerRow, dataRow) {
  let idx = -1;
  for (let i = 0; i < headerRow.length; i++) {
    if (headerRow[i] && headerRow[i].toString().trim().toLowerCase() === 'tanda tangan') {
      idx = i;
      break;
    }
  }
  if (idx === -1) return '';
  return dataRow[idx] !== undefined ? dataRow[idx].toString().trim() : '';
}

function nsBuildProfileFromRow_(headerRow, dataRow, email) {
  const colMap = getKaryawanColIndexMap_(headerRow);
  return {
    nik: dataRow[colMap.nik] || '',
    nama: dataRow[colMap.nama] || '',
    departemen: dataRow[colMap.departemen] || '',
    jabatan: dataRow[colMap.jabatan] || '',
    level: (colMap.level !== -1 && dataRow[colMap.level] !== undefined) ? dataRow[colMap.level].toString().trim() : '',
    email: email || '',
    signature: getSignatureFromRow_(headerRow, dataRow)
  };
}

/**
 * Cari profil berdasarkan email. Mengembalikan null bila memang TIDAK ADA,
 * dan MELEMPAR bila spreadsheet tidak bisa dibaca (supaya tidak salah lapor).
 */
function getKaryawanProfileByEmail_(email) {
  const emailNorm = (email || '').toString().trim().toLowerCase();
  if (!emailNorm) return null;

  const data = getKaryawanData_(); // boleh melempar
  if (!data || data.length < 2) return null;

  const headerRow = data[0];
  const colMap = getKaryawanColIndexMap_(headerRow);
  const emailCol = colMap.email !== -1 ? colMap.email : 6;

  for (let i = 1; i < data.length; i++) {
    const rowEmail = (data[i][emailCol] || '').toString().trim().toLowerCase();
    if (rowEmail && rowEmail === emailNorm) {
      return nsBuildProfileFromRow_(headerRow, data[i], emailNorm);
    }
  }
  return null;
}

function getKaryawanProfileByNik_(nik) {
  const nikTrim = (nik || '').toString().trim();
  if (!nikTrim) return null;

  const data = getKaryawanData_(); // boleh melempar
  if (!data || data.length < 2) return null;

  const headerRow = data[0];
  const colMap = getKaryawanColIndexMap_(headerRow);

  for (let i = 1; i < data.length; i++) {
    if (data[i][colMap.nik] && data[i][colMap.nik].toString().trim() === nikTrim) {
      return nsBuildProfileFromRow_(headerRow, data[i], (data[i][colMap.email] || '').toString().trim().toLowerCase());
    }
  }
  return null;
}

function hasModuleAccess_(nik, moduleName) {
  try {
    const data = getKaryawanData_();
    if (!data || data.length < 2) return false;
    const nikTrim = nik ? nik.toString().trim() : '';
    if (!nikTrim) return false;

    for (let i = 1; i < data.length; i++) {
      if (data[i][0] && data[i][0].toString().trim() === nikTrim) {
        const accessMap = getModuleAccessMapFromRow_(data[0], data[i], HR_ACCESS_MODULES);
        return !!accessMap[moduleName];
      }
    }
    return false;
  } catch (e) {
    return false;
  }
}

// -----------------------------------------------------------------------------
// IDENTITAS: SSO + pengecualian sempit untuk scheduler
// -----------------------------------------------------------------------------
function nsAdminNikList_() {
  return (nsAuthGetProperty_(NS_AUTH_PROPERTY_ADMIN_NIKS, '') || '')
    .split(',').map(function (v) { return v.trim(); }).filter(Boolean);
}

function nsAdminEmailList_() {
  return (nsAuthGetProperty_(NS_AUTH_PROPERTY_ADMIN_EMAILS, '') || '')
    .split(',').map(function (v) { return v.trim().toLowerCase(); }).filter(Boolean);
}

function nsIsAdminProfile_(profile, email) {
  const niks = nsAdminNikList_();
  const emails = nsAdminEmailList_();
  if (!niks.length && !emails.length) return false; // fail closed
  const nik = (profile && profile.nik ? profile.nik : '').toString().trim();
  const mail = (email || '').toString().trim().toLowerCase();
  if (nik && niks.indexOf(nik) !== -1) return true;
  if (mail && emails.indexOf(mail) !== -1) return true;
  return false;
}

/**
 * Resolver identitas utama.
 * Urutan:
 *   1. email sesi Google (jalur normal, termasuk semua request browser)
 *   2. pengecualian scheduler: TIDAK ada user aktif + requesterNik sama dengan
 *      Script Property NS_DASHBOARD_REFRESH_NIK. Hanya jalur trigger yang
 *      memenuhi syarat ini; request browser selalu punya email sesi.
 */
function resolveIdentity_(requesterNik) {
  let email = '';
  try {
    email = (Session.getActiveUser().getEmail() || '').toString().trim().toLowerCase();
  } catch (e) {
    email = '';
  }

  if (email) {
    let profile = null;
    try {
      profile = getKaryawanProfileByEmail_(email);
    } catch (readError) {
      return {
        ok: false,
        code: 'spreadsheet',
        message: 'Gagal membaca spreadsheet autentikasi (akses ditolak atau gangguan layanan): '
          + (readError && readError.message ? readError.message : readError)
      };
    }
    if (!profile || !profile.nik) {
      return {
        ok: false,
        code: 'not-registered',
        message: 'Email ' + email + ' tidak terdaftar pada sheet KARYAWAN. Hubungi admin HR untuk didaftarkan.'
      };
    }
    return { ok: true, profile: profile, email: email, authSource: 'session-email' };
  }

  // Tidak ada user aktif (mis. eksekusi trigger terjadwal).
  const schedulersNik = nsAuthGetProperty_(NS_AUTH_PROPERTY_SCHEDULER_NIK, '');
  const requested = (requesterNik || '').toString().trim();
  if (schedulersNik && requested && requested === schedulersNik) {
    let profile = null;
    try {
      profile = getKaryawanProfileByNik_(requested);
    } catch (readError) {
      return {
        ok: false,
        code: 'spreadsheet',
        message: 'Scheduler tidak dapat membaca spreadsheet autentikasi: '
          + (readError && readError.message ? readError.message : readError)
      };
    }
    if (profile && profile.nik) {
      return { ok: true, profile: profile, email: profile.email || '', authSource: 'scheduler-trigger' };
    }
    return {
      ok: false,
      code: 'not-registered',
      message: 'NIK scheduler ' + requested + ' tidak ditemukan di sheet KARYAWAN.'
    };
  }

  return {
    ok: false,
    code: 'no-identity',
    message: 'Identitas tidak terbaca dan bukan pemanggilan scheduler. Pastikan web app dibuka '
      + 'oleh pengguna yang login Google, dan/atau Script Property NS_DASHBOARD_REFRESH_NIK sudah diatur untuk refresh terjadwal.'
  };
}

/**
 * Kontrak SAMA PERSIS dengan portal (WebApp.gs):
 *   sukses -> { ok: true, profile, module, authSource }
 *   gagal  -> { ok: false, response: <JSON string status=forbidden|error> }
 * ns domain.gs memanggil fungsi ini di 4 endpoint (baris 642, 762, 918, 1190).
 */
function requireModuleAccess_(requesterNik, allowedModules) {
  const modules = Array.isArray(allowedModules)
    ? allowedModules.filter(Boolean)
    : [allowedModules].filter(Boolean);

  const resolved = resolveIdentity_(requesterNik);
  if (!resolved.ok || !resolved.profile || !resolved.profile.nik) {
    return {
      ok: false,
      response: JSON.stringify({
        status: resolved.code === 'spreadsheet' ? 'error' : 'forbidden',
        message: resolved.message || 'Akses ditolak.',
        data: null
      })
    };
  }

  for (let i = 0; i < modules.length; i++) {
    if (hasModuleAccess_(resolved.profile.nik, modules[i])) {
      return {
        ok: true,
        profile: resolved.profile,
        module: modules[i],
        authSource: resolved.authSource
      };
    }
  }

  const moduleLabel = modules.length > 1 ? modules.join(' / ') : (modules[0] || 'modul ini');
  return {
    ok: false,
    response: JSON.stringify({
      status: 'forbidden',
      message: 'Anda tidak memiliki akses ke modul ' + moduleLabel + '. Hubungi admin jika ini seharusnya terbuka untuk Anda.',
      data: null
    })
  };
}

/**
 * Gerbang administrasi untuk fungsi yang punya efek samping / diagnostik.
 * Dipakai oleh patch di ns domain.gs. Fail closed bila daftar admin kosong.
 */
function nsAssertAdmin_(context) {
  const resolved = resolveIdentity_('');
  if (!resolved.ok) {
    throw new Error('Akses admin ditolak untuk ' + (context || 'operasi ini') + ': ' + (resolved.message || 'identitas tidak terverifikasi.'));
  }
  if (!nsIsAdminProfile_(resolved.profile, resolved.email)) {
    throw new Error('Akses admin ditolak untuk ' + (context || 'operasi ini') + '. Akun '
      + (resolved.email || resolved.profile.nik || 'ini') + ' tidak ada di NS_ADMIN_NIKS / NS_ADMIN_EMAILS.');
  }
  return { profile: resolved.profile, email: resolved.email, authSource: resolved.authSource };
}

function nsIsAdmin_() {
  try {
    const resolved = resolveIdentity_('');
    return resolved.ok && nsIsAdminProfile_(resolved.profile, resolved.email);
  } catch (e) {
    return false;
  }
}

// -----------------------------------------------------------------------------
// RPC UNTUK SHELL
// -----------------------------------------------------------------------------
function getSessionUserInfo() {
  try {
    const resolved = resolveIdentity_('');
    if (!resolved.ok) {
      return JSON.stringify({
        status: resolved.code === 'spreadsheet' ? 'error' : 'forbidden',
        message: resolved.message,
        data: null
      });
    }

    const profile = resolved.profile;
    const modules = HR_ACCESS_MODULES.map(function (name) {
      return { name: name, allowed: hasModuleAccess_(profile.nik, name) };
    });

    // Perhatian: jangan menambah PII di luar kebutuhan tampilan (nama/jabatan).
    // Password & signature TIDAK pernah dikirim ke client.
    return JSON.stringify({
      status: 'success',
      message: '',
      data: {
        nik: profile.nik,
        nama: profile.nama,
        departemen: profile.departemen,
        jabatan: profile.jabatan,
        email: resolved.email,
        isAdmin: nsIsAdminProfile_(profile, resolved.email),
        modules: modules
      }
    });
  } catch (e) {
    return JSON.stringify({
      status: 'error',
      message: 'Gagal memuat sesi: ' + (e && e.message ? e.message : e),
      data: null
    });
  }
}

/**
 * Diagnostik. Publik di google.script.run, tetapi digerbangi admin.
 * Tidak menampilkan isi karyawan - hanya struktur & status.
 */
function nsSelfCheck() {
  try {
    nsAssertAdmin_('diagnostik nsSelfCheck');
  } catch (e) {
    return JSON.stringify({ status: 'forbidden', message: e.message, data: null });
  }

  const spreadsheetAuth = getKaryawanSpreadsheetId_();
  const spreadsheetHr = getHrSpreadsheetId_();
  const out = {
    spreadsheetAuth: spreadsheetAuth,
    spreadsheetHr: spreadsheetHr,
    cacheTtlSeconds: NS_AUTH_CACHE_TTL_SECONDS,
    revision: 'v2.1 (post-review)'
  };

  let activeEmail = '';
  let effectiveEmail = '';
  try { activeEmail = (Session.getActiveUser().getEmail() || '').toString().trim(); } catch (e) {}
  try { effectiveEmail = (Session.getEffectiveUser().getEmail() || '').toString().trim(); } catch (e) {}
  out.session = { activeEmail: activeEmail, effectiveEmail: effectiveEmail };

  const resolved = resolveIdentity_('');
  out.identity = resolved.ok
    ? { ok: true, nik: resolved.profile.nik, nama: resolved.profile.nama, source: resolved.authSource }
    : { ok: false, code: resolved.code, message: resolved.message };

  if (resolved.ok) {
    out.modules = HR_ACCESS_MODULES.map(function (name) {
      return name + ': ' + (hasModuleAccess_(resolved.profile.nik, name) ? 'boleh' : 'tidak');
    });
    out.isAdmin = nsIsAdminProfile_(resolved.profile, resolved.email);
  }

  try {
    const hr = SpreadsheetApp.openById(spreadsheetHr);
    out.hrSheets = hr.getSheets().map(function (s) { return s.getName(); });
  } catch (e) {
    out.hrSheets = 'ERROR: ' + String(e && e.message ? e.message : e);
  }

  return JSON.stringify({ status: 'success', message: '', data: out }, null, 2);
}

function nsClearAuthCache() {
  try {
    nsAssertAdmin_('bersihkan cache autentikasi');
  } catch (e) {
    return JSON.stringify({ status: 'forbidden', message: e.message, data: null });
  }
  nsAuthInvalidateCache_(getKaryawanSpreadsheetId_());
  return JSON.stringify({ status: 'success', message: 'Cache sheet KARYAWAN dibersihkan.', data: null });
}

// -----------------------------------------------------------------------------
// PENYAJI SHELL
// -----------------------------------------------------------------------------
function doGet() {
  const template = HtmlService.createTemplateFromFile('index');
  template.appTitle = NS_APP_TITLE;
  return template.evaluate()
    .setTitle(NS_APP_TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setFaviconUrl('https://ssl.gstatic.com/docs/spreadsheets/favicon3.ico');
}

function includeHtml_(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}
