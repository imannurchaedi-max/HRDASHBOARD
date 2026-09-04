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
  //  [domain PT DAM]". JANGAN PERNAH mode "Anyone". Sejak 28 Agu 2026 endpoint
  //  data FAIL-CLOSED: fallback nik kiriman client (bisa dipalsukan dari console
  //  browser) DITOLAK - identitas wajib dari Session.getActiveUser().getEmail().
  //  Deploy salah = aplikasi menolak semua request data, bukan membocorkan data.
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
  const NS_ACCESS_MODULES = ['NS Headcount', 'NS Contract', 'NS Recruitment', 'NS Manning'];

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

  // Cache dua lapis untuk sheet KARYAWAN (fix C1, 28 Agu 2026): sebelumnya TIAP
  // endpoint membaca sheet ini 2x (resolveRequestUserProfile_ + hasModuleAccess_)
  // tanpa cache - boros kuota & latency. Memo per-invocation menjamin 1 baca per
  // request; CacheService 5 menit menghemat lintas request. Konsekuensi diterima:
  // perubahan akses/password di sheet baru efektif maksimal 5 menit.
  const KARYAWAN_CACHE_KEY = 'nsrecord:karyawan:v1';
  const KARYAWAN_CACHE_TTL_SECONDS = 300;
  let karyawanMemo_ = null; // GAS = 1 invocation per request, memo aman

  function getKaryawanData_() {
    if (karyawanMemo_) return karyawanMemo_;
    const cached = nsCacheGet_(KARYAWAN_CACHE_KEY);
    if (cached) {
      karyawanMemo_ = cached;
      return cached;
    }
    const data = nsWithRetry_('Baca data KARYAWAN', function() {
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
    nsCachePut_(KARYAWAN_CACHE_KEY, data, KARYAWAN_CACHE_TTL_SECONDS); // skip diam-diam kalau >95KB - memo tetap melindungi request ini
    karyawanMemo_ = data;
    return data;
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
  //
  // FAIL-CLOSED (fix A1, 28 Agu 2026): fallback client-nik DITOLAK untuk endpoint
  // data karena bisa dipalsukan dari console browser. Identitas wajib dari email
  // sesi Google. Deploy salah (bukan "Anyone within domain") = aplikasi menolak
  // semua request data, bukan membocorkan data pribadi 745 karyawan.
  function requireModuleAccess_(requesterNik, moduleName) {
    const resolved = resolveRequestUserProfile_(requesterNik);
    if (!resolved.ok || !resolved.profile || !resolved.profile.nik) {
      return { ok: false, response: nsForbidden_(resolved.message || 'Akses ditolak.') };
    }
    if (resolved.authSource !== 'session-email') {
      return {
        ok: false,
        response: nsForbidden_(
          'Sesi Google tidak terdeteksi di server. Endpoint data wajib identitas sesi Google - ' +
          'pastikan deploy "Anyone within domain" dan browser sedang login akun Google perusahaan.'
        )
      };
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
    costCenter: ['COST CENTER', 'Cost Center', 'CC'],
    group: ['GROUP', 'Group', 'Grup'],
    tanggalMasuk: ['TANGGAL KONTRAK', 'Tanggal Kontrak', 'Tgl Kontrak', 'TANGGAL MASUK', 'Tanggal Masuk', 'Tgl Masuk'],
    tahun: ['TAHUN', 'Tahun'],
    bulan: ['BULAN', 'Bulan'],
    hari: ['HARI', 'Hari'],
    urutanKontrak: ['URUTAN KONTRAK', 'Urutan Kontrak', 'Keterangan Kontrak', 'Kontrak Ke'],
    keteranganKontrak: ['URUTAN KONTRAK', 'Urutan Kontrak', 'Keterangan Kontrak', 'Kontrak Ke'],
    tglAkhirKontrak: ['TANGGAL AKHIR KONTRAK', 'Tgl Akhir Kontrak', 'Tanggal Akhir Kontrak', 'Tgl. Akhir Kontrak'],
    tglAwalKontrak: ['TANGGAL AWAL KONTRAK', 'Tgl Awal Kontrak', 'Tanggal Awal Kontrak'],
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
    pendidikan: [
      'PENDIDIKAN', 'Pendidikan', 'PENDIDIKAN TERAKHIR', 'Pendidikan Terakhir',
      'PEND. TERAKHIR', 'Pend. Terakhir', 'Tingkat Pendidikan', 'TK PENDIDIKAN',
      'Tk. Pendidikan', 'JENJANG PENDIDIKAN', 'Jenjang Pendidikan', 'PEND',
      'Pendidikan/Lulusan', 'LULUSAN', 'Lutusan'
    ]
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

  function nsNormalizeTag_(str) {
    if (!str) return '';
    return str.toString().toLowerCase().replace(/[^a-z0-9]/g, '');
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
  //
  // Urutan parse PENTING (fix B1, 28 Agu 2026): string angka ber-pemisah WAJIB
  // di-parse manual dulu dengan konvensi Indonesia (hari-bulan-tahun). new Date()
  // membaca format US (bulan-hari-tahun) sehingga tanggal dengan hari <= 12
  // sebelumnya bergeser diam-diam. new Date() hanya fallback terakhir.
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

    const parts = s.split(/[\s\/\-\.]+/);
    if (parts.length >= 3) {
      const months = {
        january:0, jan:0, januari:0,
        february:1, feb:1, februari:1,
        march:2, mar:2, maret:2,
        april:3, apr:3,
        may:4, mei:4,
        june:5, jun:5, juni:5,
        july:6, jul:6, juli:6,
        august:7, aug:7, agustus:7, ags:7,
        september:8, sep:8, sept:8,
        october:9, oct:9, oktober:9, okt:9,
        november:10, nov:10,
        december:11, dec:11, desember:11, des:11
      };
      let day, monStr, year;
      if (/^\d{4}$/.test(parts[0])) {
        // ISO-style, tahun di depan: 2020-06-05
        year = parseInt(parts[0], 10);
        monStr = parts[1].toLowerCase();
        day = parseInt(parts[2], 10);
      } else {
        // Konvensi Indonesia, hari di depan: 05/06/2020 = 5 Juni 2020
        day = parseInt(parts[0], 10);
        monStr = parts[1].toLowerCase();
        year = parseInt(parts[2], 10);
      }
      const month = months[monStr] !== undefined ? months[monStr] : parseInt(parts[1], 10) - 1;
      if (!isNaN(day) && !isNaN(month) && !isNaN(year)) {
        if (year < 100) year += 2000;
        const d = new Date(year, month, day);
        // Verifikasi komponen - menolak rollover senyap (mis. 31 Feb -> 2 Mar).
        if (!isNaN(d.getTime()) && d.getFullYear() === year && d.getMonth() === month && d.getDate() === day) {
          return d;
        }
      }
    }

    // Fallback terakhir untuk bentuk yang tidak dikenali parser manual.
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d;
    return null;
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

      // C. Dynamic Substring Tag Matching fallback (tahan pergeseran / variasi nama kolom di sheet)
      if (found === -1) {
        for (let i = 0; i < headerRow.length; i++) {
          const hTag = nsNormalizeTag_(headerRow[i]);
          if (!hTag) continue;
          for (let k = 0; k < aliasList.length; k++) {
            const aliasTag = nsNormalizeTag_(aliasList[k]);
            if (aliasTag && (hTag.indexOf(aliasTag) !== -1 || aliasTag.indexOf(hTag) !== -1)) {
              found = i;
              break;
            }
          }
          if (found !== -1) break;
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
      const startContract = nsParseDate_(nsCell_(row, index, 'tglAwalKontrak'));
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
        costCenter: nsTrim_(nsCell_(row, index, 'costCenter')),
        group: nsNormalizeSimple_(nsCell_(row, index, 'group')),
        tanggalMasuk: nsToIsoDate_(joinDate),
        tglAwalKontrak: nsToIsoDate_(startContract),
        masaKerjaBulan: tenure ? tenure.totalMonths : null,
        masaKerjaText: tenure ? (tenure.years + ' Thn ' + tenure.months + ' Bln') : null,
        bucketMasaKerja: tenure ? (tenure.years < 1 ? '< 1 Tahun' : (tenure.years < 3 ? '1-3 Tahun' : (tenure.years < 5 ? '3-5 Tahun' : '> 5 Tahun'))) : NSRECORD_UNKNOWN,
        bucketTahunKontrak: tenure ? (
          tenure.years < 1 ? '0 - 1 Thn' :
          tenure.years < 2 ? '1 - 2 Thn' :
          tenure.years < 3 ? '2 - 3 Thn' :
          tenure.years < 4 ? '3 - 4 Thn' :
          tenure.years < 5 ? '4 - 5 Thn' : '> 5 Thn'
        ) : NSRECORD_UNKNOWN,
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

  function nsCountBySegment_(records, fieldExtractor) {
    const counts = {};
    const totalPop = records.length;
    records.forEach(function(rec) {
      let key = typeof fieldExtractor === 'function' ? fieldExtractor(rec) : rec[fieldExtractor];
      key = key || NSRECORD_UNKNOWN;
      if (!counts[key]) {
        counts[key] = { label: key, value: 0, aktif: 0, nonAktif: 0, total: 0, percent: 0 };
      }
      if (rec.isActive) {
        counts[key].aktif++;
      } else {
        counts[key].nonAktif++;
      }
      counts[key].total++;
      counts[key].value = counts[key].aktif;
    });

    return Object.keys(counts).map(function(k) {
      const item = counts[k];
      item.percent = totalPop > 0 ? Math.round((item.total / totalPop) * 1000) / 10 : 0;
      return item;
    }).sort(function(a, b) { return b.total - a.total; });
  }

  function nsAgeBucket_(usia) {
    if (usia === null || usia === undefined) return NSRECORD_UNKNOWN;
    if (usia < 20) return '< 20';
    if (usia <= 23) return '20 - 23';
    if (usia <= 25) return '23 - 25';
    if (usia <= 27) return '25 - 27';
    if (usia <= 30) return '27 - 30';
    return '> 30';
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

  function nsCachePut_(key, obj, ttlSeconds) {
    try {
      const raw = JSON.stringify(obj);
      // ttlSeconds opsional (fix C1, 28 Agu 2026) - default tetap TTL lama.
      if (raw.length <= 95000) CacheService.getScriptCache().put(key, raw, ttlSeconds || NSRECORD_CACHE_TTL_SECONDS);
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

      function buildDrilldown_(records) {
        const bagianToSection = {};
        const sectionToJabatan = {};

        records.forEach(function(r) {
          const bg = r.bagian || NSRECORD_UNKNOWN;
          const sec = r.bagianRaw || bg;
          const jab = r.jabatan || NSRECORD_UNKNOWN;

          if (!bagianToSection[bg]) bagianToSection[bg] = {};
          bagianToSection[bg][sec] = (bagianToSection[bg][sec] || 0) + 1;

          if (!sectionToJabatan[sec]) sectionToJabatan[sec] = {};
          sectionToJabatan[sec][jab] = (sectionToJabatan[sec][jab] || 0) + 1;
        });

        const formatCounts = function(dict, totalRecords) {
          const res = {};
          Object.keys(dict).forEach(function(parentKey) {
            const subMap = dict[parentKey];
            const arr = Object.keys(subMap).map(function(childKey) {
              const cnt = subMap[childKey];
              return {
                label: childKey,
                value: cnt,
                total: cnt,
                percent: totalRecords > 0 ? Math.round((cnt / totalRecords) * 1000) / 10 : 0
              };
            }).sort(function(a, b) { return b.value - a.value; });
            res[parentKey] = arr;
          });
          return res;
        };

        return {
          bagianToSection: formatCounts(bagianToSection, records.length),
          sectionToJabatan: formatCounts(sectionToJabatan, records.length)
        };
      }

      function buildSegmentPayload(records) {
        return {
          perDepartement: nsCountBySegment_(records, 'bagian'),
          perBagian: nsCountBySegment_(records, 'bagian'),
          perSection: nsCountBySegment_(records, 'bagianRaw'),
          perJabatan: nsCountBySegment_(records, 'jabatan'),
          perGroup: nsCountBySegment_(records, 'group'),
          perGender: nsCountBySegment_(records, 'gender'),
          perRing: nsCountBySegment_(records, 'ring'),
          perUsia: nsCountBySegment_(records, function(r) { return nsAgeBucket_(r.usia); }),
          perPendidikan: nsCountBySegment_(records, 'pendidikan'),
          perMasaKerja: nsCountBySegment_(records, 'bucketMasaKerja'),
          drilldown: buildDrilldown_(records)
        };
      }

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
          aktifData: buildSegmentPayload(aktif),
          nonAktifData: buildSegmentPayload(nonAktif),
          allData: buildSegmentPayload(all),
          perDepartement: nsCountBySegment_(aktif, 'bagian'),
          perBagian: nsCountBySegment_(aktif, 'bagian'),
          perSection: nsCountBySegment_(aktif, 'bagianRaw'),
          perJabatan: nsCountBySegment_(aktif, 'jabatan'),
          perGroup: nsCountBySegment_(aktif, 'group'),
          perGender: nsCountBySegment_(aktif, 'gender'),
          perRing: nsCountBySegment_(aktif, 'ring'),
          perUsia: nsCountBySegment_(aktif, function(r) { return nsAgeBucket_(r.usia); }),
          perPendidikan: nsCountBySegment_(aktif, 'pendidikan'),
          perMasaKerja: nsCountBySegment_(aktif, 'bucketMasaKerja'),
          drilldown: buildDrilldown_(aktif),
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
      const all = built.records;
      const aktif = all.filter(function(r) { return r.isActive; });
      const nonAktif = all.filter(function(r) { return !r.isActive; });

      function buildContractTenureBreakdown_(records) {
        const byTahun = {};
        records.forEach(function(r) {
          const b = r.bucketTahunKontrak || NSRECORD_UNKNOWN;
          const sec = r.bagianRaw || r.bagian || NSRECORD_UNKNOWN;
          const jab = r.jabatan || NSRECORD_UNKNOWN;

          if (!byTahun[b]) {
            byTahun[b] = { sectionMap: {}, jabatanMap: {} };
          }
          byTahun[b].sectionMap[sec] = (byTahun[b].sectionMap[sec] || 0) + 1;
          byTahun[b].jabatanMap[jab] = (byTahun[b].jabatanMap[jab] || 0) + 1;
        });

        const res = {};
        Object.keys(byTahun).forEach(function(bKey) {
          const secMap = byTahun[bKey].sectionMap;
          const jabMap = byTahun[bKey].jabatanMap;

          const perSection = Object.keys(secMap).map(function(k) {
            return { label: k, value: secMap[k] };
          }).sort(function(a, b) { return b.value - a.value; });

          const perJabatan = Object.keys(jabMap).map(function(k) {
            return { label: k, value: jabMap[k] };
          }).sort(function(a, b) { return b.value - a.value; });

          res[bKey] = {
            perSection: perSection,
            perJabatan: perJabatan
          };
        });
        return res;
      }

      function buildWatchlist(list) {
        return list
          .filter(function(r) { return r.sisaHariKontrak !== null && r.sisaHariKontrak <= NS_CONTRACT_WATCH_DAYS; })
          .sort(function(a, b) { return a.sisaHariKontrak - b.sisaHariKontrak; })
          .map(function(r) {
            return {
              rowNumber: r.rowNumber, nik: r.nik, nama: r.nama,
              bagian: r.bagian, bagianRaw: r.bagianRaw, jabatan: r.jabatan, group: r.group,
              keteranganKontrak: r.keteranganKontrak,
              tanggalMasuk: r.tanggalMasuk,
              // Fix B3 (28 Agu 2026): pakai kolom TANGGAL AWAL KONTRAK yang asli;
              // fallback tanggalMasuk hanya kalau kolom itu kosong/tidak ada.
              tglAwalKontrak: r.tglAwalKontrak || r.tanggalMasuk,
              tglAkhirKontrak: r.tglAkhirKontrak,
              sisaHariKontrak: r.sisaHariKontrak, bucket: r.bucketKontrak,
              bucketTahunKontrak: r.bucketTahunKontrak,
              masaKerjaText: r.masaKerjaText
            };
          });
      }

      const countBucket = function(list, name) {
        return list.filter(function(r) { return r.bucketKontrak === name; }).length;
      };

      const response = {
        status: 'success',
        data: {
          kpi: {
            lewatJatuhTempo: countBucket(aktif, 'Lewat Jatuh Tempo'),
            kritis30: countBucket(aktif, '0-30 Hari'),
            waspada60: countBucket(aktif, '31-60 Hari'),
            pantau90: countBucket(aktif, '61-90 Hari'),
            aman: countBucket(aktif, 'Di Atas 90 Hari'),
            tanpaTanggal: countBucket(aktif, 'Tanpa Tanggal'),
            totalAktif: aktif.length,
            totalNonAktif: nonAktif.length,
            total: all.length
          },
          aktifData: {
            perBucket: nsCountBy_(aktif, 'bucketKontrak'),
            perTahunKontrak: nsCountBy_(aktif, 'bucketTahunKontrak'),
            tenureBreakdown: buildContractTenureBreakdown_(aktif),
            watchlist: buildWatchlist(aktif)
          },
          nonAktifData: {
            perBucket: nsCountBy_(nonAktif, 'bucketKontrak'),
            perTahunKontrak: nsCountBy_(nonAktif, 'bucketTahunKontrak'),
            tenureBreakdown: buildContractTenureBreakdown_(nonAktif),
            watchlist: buildWatchlist(nonAktif)
          },
          allData: {
            perBucket: nsCountBy_(all, 'bucketKontrak'),
            perTahunKontrak: nsCountBy_(all, 'bucketTahunKontrak'),
            tenureBreakdown: buildContractTenureBreakdown_(all),
            watchlist: buildWatchlist(all)
          },
          perBucket: nsCountBy_(aktif, 'bucketKontrak'),
          perTahunKontrak: nsCountBy_(aktif, 'bucketTahunKontrak'),
          tenureBreakdown: buildContractTenureBreakdown_(aktif),
          watchlist: buildWatchlist(aktif),
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

      function buildRecData(records) {
        const sources = {};
        const referensiByJoinVia = {};
        records.forEach(function(r) {
          const key = r.joinVia || NSRECORD_UNKNOWN;
          const ref = r.referensi || NSRECORD_UNKNOWN;

          if (!sources[key]) sources[key] = { label: key, total: 0, aktif: 0 };
          sources[key].total++;
          if (r.isActive) sources[key].aktif++;

          if (!referensiByJoinVia[key]) referensiByJoinVia[key] = {};
          referensiByJoinVia[key][ref] = (referensiByJoinVia[key][ref] || 0) + 1;
        });

        const perJoinVia = Object.keys(sources).map(function(k) {
          const s = sources[k];
          return {
            label: s.label, value: s.total, total: s.total, aktif: s.aktif, keluar: s.total - s.aktif,
            retensiPersen: s.total ? Math.round((s.aktif / s.total) * 1000) / 10 : 0
          };
        }).sort(function(a, b) { return b.total - a.total; });

        const referensiMapByJoinVia = {};
        Object.keys(referensiByJoinVia).forEach(function(jv) {
          referensiMapByJoinVia[jv] = Object.keys(referensiByJoinVia[jv]).map(function(ref) {
            return { label: ref, value: referensiByJoinVia[jv][ref] };
          }).sort(function(a, b) { return b.value - a.value; });
        });

        const byMonth = {};
        records.forEach(function(r) {
          if (!r.tanggalMasuk) return;
          const ym = r.tanggalMasuk.slice(0, 7);
          byMonth[ym] = (byMonth[ym] || 0) + 1;
        });
        const trenMasuk = Object.keys(byMonth).sort().map(function(k) {
          return { label: k, value: byMonth[k] };
        });

        return {
          perJoinVia: perJoinVia,
          perReferensi: nsCountBy_(records, 'referensi'),
          referensiMapByJoinVia: referensiMapByJoinVia,
          perReasonKeluar: nsCountBy_(records.filter(function(r) { return r.reasonKeluar; }), 'reasonKeluar'),
          perRing: nsCountBy_(records, 'ring'),
          perKecamatan: nsCountBy_(records, 'kecamatan').slice(0, 15),
          trenMasuk: trenMasuk
        };
      }

      const response = {
        status: 'success',
        data: {
          kpi: {
            total: all.length,
            totalAktif: aktif.length,
            totalNonAktif: nonAktif.length,
            jumlahSumber: nsCountBy_(all, 'joinVia').length,
            jumlahReferensi: nsCountBy_(all, 'referensi').length
          },
          aktifData: buildRecData(aktif),
          nonAktifData: buildRecData(nonAktif),
          allData: buildRecData(all),
          perJoinVia: buildRecData(all).perJoinVia,
          perReferensi: nsCountBy_(all, 'referensi'),
          referensiMapByJoinVia: buildRecData(all).referensiMapByJoinVia,
          perReasonKeluar: nsCountBy_(nonAktif.filter(function(r) { return r.reasonKeluar; }), 'reasonKeluar'),
          perRing: nsCountBy_(aktif, 'ring'),
          perKecamatan: nsCountBy_(aktif, 'kecamatan').slice(0, 15),
          trenMasuk: buildRecData(all).trenMasuk,
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

  // =============================================================================
  // MODUL: MANNING DISTRIBUTION (rencana vs aktual per Cost Center/Departemen)
  // =============================================================================
  // Tab 'MANNING DISTRIBUTION' ada di spreadsheet NS Record yang sama (bukan
  // spreadsheet terpisah). Kolom: Type, Periode, Comp, Comp Code, Cost Center,
  // Head count, Nama Cost Center. Data ini adalah RENCANA (plan) headcount per
  // Cost Center per bulan - dibandingkan dengan AKTUAL yang dihitung dari
  // nsBuildRecords_ (join lewat kolom Cost Center yang sama di MASTER KARYAWAN).

  const NS_MANNING_SHEET_NAME = 'MANNING DISTRIBUTION';

  const NS_MANNING_COLUMN_ALIASES = {
    type: ['Type'],
    periode: ['Periode'],
    comp: ['Comp'],
    compCode: ['Comp Code'],
    costCenter: ['Cost Center'],
    headCount: ['Head Count', 'Head count', 'Headcount'],
    namaCostCenter: ['Nama Cost Center']
  };

  const NS_MONTH_LABELS_ID = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

  // Urutan tampil tabel "per Tipe" - DL (Direct Labor) dulu karena porsinya
  // terbesar & paling fluktuatif, baru IDL, baru STAFF. Tipe di luar 3 ini
  // (kalau ada data baru di masa depan) ditaruh paling akhir.
  const NS_MANNING_TYPE_ORDER = ['DL', 'IDL', 'STAFF'];

  function nsFindColumn_(headerRow, aliasList) {
    for (let i = 0; i < headerRow.length; i++) {
      const h = nsTrim_(headerRow[i]).toLowerCase();
      if (h && aliasList.some(function(a) { return a.toLowerCase() === h; })) return i;
    }
    const tagList = aliasList.map(nsNormalizeTag_);
    for (let i = 0; i < headerRow.length; i++) {
      const hTag = nsNormalizeTag_(headerRow[i]);
      if (hTag && tagList.indexOf(hTag) !== -1) return i;
    }
    return -1;
  }

  function nsBuildManningColumnIndex_(headerRow) {
    const index = {};
    Object.keys(NS_MANNING_COLUMN_ALIASES).forEach(function(field) {
      index[field] = nsFindColumn_(headerRow, NS_MANNING_COLUMN_ALIASES[field]);
    });
    return index;
  }

  // Periode di sheet campur format: '04.2026' (string MM.YYYY) dan angka
  // seperti 112025 / 22026 (M(M)YYYY tanpa leading zero pada bulan). Diverifikasi
  // 6 Agu 2026 dari ref/EMPLOYEE DATA.xlsx via openpyxl - kedua bentuk itu yang
  // benar-benar muncul di sheet, jadi keduanya WAJIB didukung.
  function nsParsePeriode_(raw) {
    const s = nsTrim_(raw);
    if (!s) return null;
    let month, year;
    if (s.indexOf('.') !== -1) {
      const parts = s.split('.');
      month = parseInt(parts[0], 10);
      year = parseInt(parts[1], 10);
    } else if (/^\d{5,6}$/.test(s)) {
      year = parseInt(s.slice(-4), 10);
      month = parseInt(s.slice(0, s.length - 4), 10);
    } else {
      return null;
    }
    if (!month || !year || month < 1 || month > 12) return null;
    const mm = (month < 10 ? '0' : '') + month;
    return {
      iso: year + '-' + mm,
      label: NS_MONTH_LABELS_ID[month - 1] + ' ' + year,
      sortKey: year * 100 + month
    };
  }

  function nsGetManningSheet_(ss) {
    let sheet = ss.getSheetByName(NS_MANNING_SHEET_NAME);
    if (!sheet) {
      sheet = ss.getSheets().filter(function(s) {
        return s.getName().trim().toUpperCase() === NS_MANNING_SHEET_NAME.toUpperCase();
      })[0] || null;
    }
    if (!sheet) {
      throw new Error("Sheet '" + NS_MANNING_SHEET_NAME + "' tidak ditemukan di spreadsheet NS Record.");
    }
    return sheet;
  }

  function nsBuildManningRecords_() {
    const ss = nsGetSpreadsheet_();
    const sheet = nsGetManningSheet_(ss);
    const values = sheet.getDataRange().getValues();
    if (!values || values.length < 2) {
      return { records: [], periodeList: [] };
    }

    const index = nsBuildManningColumnIndex_(values[0]);
    const records = [];
    const periodeSeen = {};

    for (let r = 1; r < values.length; r++) {
      const row = values[r];
      const costCenter = nsTrim_(index.costCenter !== -1 ? row[index.costCenter] : null);
      const periode = nsParsePeriode_(index.periode !== -1 ? row[index.periode] : null);
      if (!costCenter || !periode) continue;

      const headCount = Number(index.headCount !== -1 ? row[index.headCount] : 0) || 0;
      records.push({
        type: nsTrim_(index.type !== -1 ? row[index.type] : ''),
        periodeIso: periode.iso,
        periodeLabel: periode.label,
        periodeSortKey: periode.sortKey,
        costCenter: costCenter,
        namaCostCenter: nsTrim_(index.namaCostCenter !== -1 ? row[index.namaCostCenter] : '') || costCenter,
        headCount: headCount
      });

      if (!periodeSeen[periode.iso]) {
        periodeSeen[periode.iso] = { iso: periode.iso, label: periode.label, sortKey: periode.sortKey };
      }
    }

    const periodeList = Object.keys(periodeSeen).map(function(k) { return periodeSeen[k]; })
      .sort(function(a, b) { return b.sortKey - a.sortKey; });

    return { records: records, periodeList: periodeList };
  }

  // Sheet MANNING DISTRIBUTION tidak punya kolom Departemen - hanya Cost Center +
  // Nama Cost Center (nama section, lebih rinci dari Departemen/bagian). Supaya
  // bisa agregasi "per Departemen", petakan tiap Cost Center ke bagian yang
  // PALING BANYAK dipakai karyawan aktual di Cost Center itu (majority vote) -
  // bukan sumber independen, karena sheet manning sendiri tidak mendefinisikannya.
  function nsBuildCostCenterBagianMap_(allRecords) {
    const counts = {};
    allRecords.forEach(function(r) {
      if (!r.costCenter) return;
      if (!counts[r.costCenter]) counts[r.costCenter] = {};
      const b = r.bagian || NSRECORD_UNKNOWN;
      counts[r.costCenter][b] = (counts[r.costCenter][b] || 0) + 1;
    });
    const map = {};
    Object.keys(counts).forEach(function(cc) {
      let best = null, bestCount = -1;
      Object.keys(counts[cc]).forEach(function(b) {
        if (counts[cc][b] > bestCount) { best = b; bestCount = counts[cc][b]; }
      });
      map[cc] = best || NSRECORD_UNKNOWN;
    });
    return map;
  }

  // Aktual Manning harus dibaca sebagai snapshot pada AKHIR periode yang dipilih,
  // bukan status AKTIF saat endpoint dipanggil. Ini membuat histori tetap benar:
  // - masuk pada/ sebelum akhir periode => dihitung;
  // - Tanggal Efektif Non Aktif pada/ sebelum akhir periode => tidak dihitung.
  function nsEndOfPeriode_(periodeIso) {
    const match = /^([0-9]{4})-([0-9]{2})$/.exec(nsTrim_(periodeIso));
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (!year || month < 1 || month > 12) return null;
    return nsStartOfDay_(new Date(year, month, 0));
  }

  function nsBuildAktualManningPadaPeriode_(records, asOfDate) {
    const aktif = [];
    let tanpaTanggalMasuk = 0;
    let nonAktifTanpaTanggalKeluar = 0;

    records.forEach(function(r) {
      const joinDate = nsParseDate_(r.tanggalMasuk);
      const exitDate = nsParseDate_(r.tanggalNonAktif);

      // Tanpa tanggal masuk, record tidak bisa ditempatkan ke histori periode
      // secara jujur. Jangan diam-diam menghitungnya sebagai tenaga lampau.
      if (!joinDate) {
        tanpaTanggalMasuk++;
        return;
      }
      if (joinDate.getTime() > asOfDate.getTime()) return;

      // Tanggal efektif keluar adalah hari pertama status NON AKTIF.
      if (exitDate && exitDate.getTime() <= asOfDate.getTime()) return;

      // Fallback konservatif untuk data lama yang sudah NON AKTIF tetapi belum
      // memiliki tanggal keluar: jangan masukkan ke headcount historis.
      if (!exitDate && !r.isActive) {
        nonAktifTanpaTanggalKeluar++;
        return;
      }
      aktif.push(r);
    });

    return {
      records: aktif,
      tanpaTanggalMasuk: tanpaTanggalMasuk,
      nonAktifTanpaTanggalKeluar: nonAktifTanpaTanggalKeluar
    };
  }

  function getNsManningData(nik, periodeIso) {
    const gate = requireModuleAccess_(nik, 'NS Manning');
    if (!gate.ok) return gate.response;
    try {
      const manning = nsBuildManningRecords_();
      if (!manning.periodeList.length) {
        return JSON.stringify({
          status: 'error',
          message: "Tidak ada data periode yang valid di sheet 'MANNING DISTRIBUTION'.",
          data: null
        });
      }

      const selectedIso = (periodeIso && manning.periodeList.some(function(p) { return p.iso === periodeIso; }))
        ? periodeIso
        : manning.periodeList[0].iso; // periodeList terurut turun -> [0] = terbaru

      const selectedLabel = manning.periodeList.filter(function(p) { return p.iso === selectedIso; })[0].label;
      const asOfDate = nsEndOfPeriode_(selectedIso);
      if (!asOfDate) {
        return JSON.stringify({ status: 'error', message: 'Periode Manning tidak valid: ' + selectedIso, data: null });
      }

      const built = nsBuildRecords_();
      const aktualPadaPeriode = nsBuildAktualManningPadaPeriode_(built.records, asOfDate);
      const aktif = aktualPadaPeriode.records;
      const ccBagianMap = nsBuildCostCenterBagianMap_(aktif);

      const actualByCC = {};
      aktif.forEach(function(r) {
        const cc = r.costCenter || NSRECORD_UNKNOWN;
        actualByCC[cc] = (actualByCC[cc] || 0) + 1;
      });

      const planByCC = {};
      manning.records.filter(function(m) { return m.periodeIso === selectedIso; }).forEach(function(m) {
        if (!planByCC[m.costCenter]) {
          planByCC[m.costCenter] = { costCenter: m.costCenter, namaCostCenter: m.namaCostCenter, total: 0, byType: {} };
        }
        planByCC[m.costCenter].total += m.headCount;
        planByCC[m.costCenter].byType[m.type] = (planByCC[m.costCenter].byType[m.type] || 0) + m.headCount;
        if (m.namaCostCenter) planByCC[m.costCenter].namaCostCenter = m.namaCostCenter;
      });

      const ccSet = {};
      Object.keys(planByCC).forEach(function(cc) { ccSet[cc] = true; });
      Object.keys(actualByCC).forEach(function(cc) { ccSet[cc] = true; });

      const perCostCenter = Object.keys(ccSet).map(function(cc) {
        const plan = planByCC[cc];
        const actual = actualByCC[cc] || 0;
        const planTotal = plan ? plan.total : 0;
        return {
          costCenter: cc,
          namaCostCenter: (plan && plan.namaCostCenter) || cc,
          bagian: ccBagianMap[cc] || NSRECORD_UNKNOWN,
          planTotal: planTotal,
          planByType: plan ? plan.byType : {},
          actual: actual,
          gap: actual - planTotal,
          fulfillmentPercent: planTotal > 0 ? Math.round((actual / planTotal) * 1000) / 10 : null
        };
      }).sort(function(a, b) { return b.planTotal - a.planTotal; });

      const perDepMap = {};
      perCostCenter.forEach(function(row) {
        const b = row.bagian || NSRECORD_UNKNOWN;
        if (!perDepMap[b]) perDepMap[b] = { bagian: b, planTotal: 0, actual: 0 };
        perDepMap[b].planTotal += row.planTotal;
        perDepMap[b].actual += row.actual;
      });
      const perDepartemen = Object.keys(perDepMap).map(function(b) {
        const row = perDepMap[b];
        row.gap = row.actual - row.planTotal;
        row.fulfillmentPercent = row.planTotal > 0 ? Math.round((row.actual / row.planTotal) * 1000) / 10 : null;
        return row;
      }).sort(function(a, b) { return b.planTotal - a.planTotal; });

      // Tren rencana bulanan lintas SEMUA Cost Center. Catatan: sisi aktual TIDAK
      // punya riwayat bulanan (MASTER KARYAWAN hanya snapshot kondisi terkini),
      // jadi tren ini murni rencana - bukan perbandingan aktual vs rencana per bulan.
      const trendMap = {};
      manning.records.forEach(function(m) {
        if (!trendMap[m.periodeIso]) {
          trendMap[m.periodeIso] = { periodeIso: m.periodeIso, label: m.periodeLabel, sortKey: m.periodeSortKey, planTotal: 0 };
        }
        trendMap[m.periodeIso].planTotal += m.headCount;
      });
      const trend = Object.keys(trendMap).map(function(k) { return trendMap[k]; })
        .sort(function(a, b) { return a.sortKey - b.sortKey; });

      // Sama seperti trend di atas, tapi pecah per Tipe (DL/IDL/STAFF) - untuk
      // stacked chart & tabel breakdown bulanan per tipe.
      const trendByTypeMap = {};
      manning.records.forEach(function(m) {
        if (!trendByTypeMap[m.periodeIso]) {
          trendByTypeMap[m.periodeIso] = { periodeIso: m.periodeIso, label: m.periodeLabel, sortKey: m.periodeSortKey, byType: {} };
        }
        trendByTypeMap[m.periodeIso].byType[m.type] = (trendByTypeMap[m.periodeIso].byType[m.type] || 0) + m.headCount;
      });
      const trendByType = Object.keys(trendByTypeMap).map(function(k) { return trendByTypeMap[k]; })
        .sort(function(a, b) { return a.sortKey - b.sortKey; });

      const totalPlan = perCostCenter.reduce(function(s, r) { return s + r.planTotal; }, 0);
      const totalActual = perCostCenter.reduce(function(s, r) { return s + r.actual; }, 0);
      const unmapped = Object.keys(actualByCC).filter(function(cc) { return !planByCC[cc]; });

      // Rencana per Tipe (DL/IDL/STAFF), lalu per Cost Center di dalamnya - urutan
      // grup ikut NS_MANNING_TYPE_ORDER, dalam grup diurutkan headCount terbesar.
      // Tidak ada sisi aktual di sini: MASTER KARYAWAN tidak punya klasifikasi
      // DL/IDL/STAFF per karyawan, jadi tabel ini murni sisi rencana.
      const perTypeCostCenter = manning.records
        .filter(function(m) { return m.periodeIso === selectedIso; })
        .map(function(m) {
          return { type: m.type, costCenter: m.costCenter, namaCostCenter: m.namaCostCenter, headCount: m.headCount };
        })
        .sort(function(a, b) {
          var ta = NS_MANNING_TYPE_ORDER.indexOf(a.type); if (ta === -1) ta = 99;
          var tb = NS_MANNING_TYPE_ORDER.indexOf(b.type); if (tb === -1) tb = 99;
          if (ta !== tb) return ta - tb;
          return b.headCount - a.headCount;
        });

      const response = {
        status: 'success',
        data: {
          periodeList: manning.periodeList,
          selectedPeriode: { iso: selectedIso, label: selectedLabel },
          actualAsOf: {
            iso: nsToIsoDate_(asOfDate),
            label: Utilities.formatDate(asOfDate, Session.getScriptTimeZone(), 'dd MMM yyyy')
          },
          kpi: {
            totalPlan: totalPlan,
            totalActual: totalActual,
            gap: totalActual - totalPlan,
            fulfillmentPercent: totalPlan > 0 ? Math.round((totalActual / totalPlan) * 1000) / 10 : null
          },
          perCostCenter: perCostCenter,
          perDepartemen: perDepartemen,
          perTypeCostCenter: perTypeCostCenter,
          trend: trend,
          trendByType: trendByType,
          warnings: {
            duplicateNiks: built.duplicateNiks,
            missingColumns: built.missingColumns,
            costCenterTanpaRencana: unmapped,
            tanpaTanggalMasuk: aktualPadaPeriode.tanpaTanggalMasuk,
            nonAktifTanpaTanggalKeluar: aktualPadaPeriode.nonAktifTanpaTanggalKeluar
          }
        }
      };
      // Jangan CacheService di endpoint ini. Daftar periode, Pareto, dan
      // headcount historis harus langsung mengikuti perubahan Google Sheet;
      // cache per-periode sebelumnya membuat Refresh/dropdown menampilkan data
      // lama sampai TTL berakhir.
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
