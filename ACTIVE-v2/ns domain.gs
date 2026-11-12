// =============================================================================
// trial_hr_domain.gs - Domain Modul HR (Non Staff Record)
// =============================================================================
// Terintegrasi ke dalam DAM CONTROL TOWER (DT SUMMARY).
// Mengelola data analitik karyawan Non Staff (NS): Headcount & Demografi,
// Contract Watchlist, Rekrutmen & Sourcing, dan Manning Distribution (Plan vs Actual).
//
// Sumber Data:
//  - Spreadsheet NS Record: NSRECORD_SPREADSHEET_ID
//    Tab: 'MASTER KARYAWAN', 'MANNING DISTRIBUTION', 'NS HEADCOUNT MONTHLY', '_NS_DASHBOARD_CACHE'
//  - Spreadsheet Autentikasi: Menggunakan shared auth DT SUMMARY (KARYAWAN) via requireModuleAccess_
// =============================================================================
//
// =================== PATCH LOKAL (ACTIVE-v2), 12 Nov 2026 ====================
// File ini SALINAN dari 0. DT SUMMARY/active trial/trial_hr_domain.gs.
// Berbeda dari sumber aslinya HANYA pada 4 titik berikut (hasil code review):
//
//   P1. nsRecordSelfTest()            -> ditambah gerbang nsAssertAdmin_()
//   P2. nsInstallDailyDashboardRefresh() -> gerbang diganti nsAssertAdmin_()
//        (aslinya membandingkan activeEmail === effectiveEmail; di mode
//        USER_ACCESSING keduanya sama dengan pengunjung sehingga gerbang itu
//        tidak membatasi siapa pun)
//   P3. nsInspectSpreadsheetLive()    -> ditambah gerbang nsAssertAdmin_()
//   P4. nsInspectSpreadsheetLive()    -> pakai getHrSpreadsheetId_() (menghormati
//        Script Property) bukan ID produksi hardcoded
//
// Saat menyalin ulang file ini dari portal, TERAPKAN ULANG 4 patch di atas.
// Cek cepat: grep -c "PATCH P[0-9]" "ns domain.gs"  -> harus 3
// =============================================================================


const TrialHrDomain = (function () {
  const NSRECORD_SPREADSHEET_ID =
    PropertiesService.getScriptProperties().getProperty('NSRECORD_SPREADSHEET_ID') ||
    '1qSTpi6OwUOBoORIALBCdwWehH-R0L8az4vwuaOV3shU';

  const NSRECORD_SHEET_NAME = 'MASTER KARYAWAN';
  const NS_MANNING_SHEET_NAME = 'MANNING DISTRIBUTION';
  const NSRECORD_CACHE_TTL_SECONDS = 600;
  const NSRECORD_UNKNOWN = '(Tidak Diketahui)';

  // Prepared dashboard cache
  const NS_DASHBOARD_CACHE_SHEET_NAME = '_NS_DASHBOARD_CACHE';
  const NS_HEADCOUNT_MONTHLY_SHEET_NAME = 'NS HEADCOUNT MONTHLY';
  const NS_DASHBOARD_REFRESH_NIK_PROPERTY = 'NS_DASHBOARD_REFRESH_NIK';
  const NS_DASHBOARD_REFRESH_HANDLER = 'nsRefreshDashboardCache_';
  const NS_DASHBOARD_CACHE_CHUNK_SIZE = 45000;
  let nsScheduledPreparation_ = false;

  const NS_ACCESS_MODULES = ['NS Headcount', 'NS Contract', 'NS Recruitment', 'NS Manning'];

  // Ambang batas watchlist kontrak (hari)
  const NS_CONTRACT_CRITICAL_DAYS = 30;
  const NS_CONTRACT_WARNING_DAYS = 60;
  const NS_CONTRACT_WATCH_DAYS = 90;

  // =============================================================================
  // PETA NORMALISASI
  // =============================================================================
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

  const NS_REQUIRED_FIELDS = [
    'nik', 'nama', 'tanggalLahir', 'gender', 'bagian', 'tanggalMasuk',
    'keteranganKontrak', 'tglAkhirKontrak', 'status'
  ];

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
  const NS_MANNING_TYPE_ORDER = ['DL', 'IDL', 'STAFF'];

  // =============================================================================
  // HELPER NORMALISASI & DATE
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
    return s.toLowerCase().split(/\s+/).map(function (word) {
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
        january: 0, jan: 0, januari: 0,
        february: 1, feb: 1, februari: 1,
        march: 2, mar: 2, maret: 2,
        april: 3, apr: 3,
        may: 4, mei: 4,
        june: 5, jun: 5, juni: 5,
        july: 6, jul: 6, juli: 6,
        august: 7, aug: 7, agustus: 7, ags: 7,
        september: 8, sep: 8, sept: 8,
        october: 9, oct: 9, oktober: 9, okt: 9,
        november: 10, nov: 10,
        december: 11, dec: 11, desember: 11, des: 11
      };
      let day, monStr, year;
      if (/^\d{4}$/.test(parts[0])) {
        year = parseInt(parts[0], 10);
        monStr = parts[1].toLowerCase();
        day = parseInt(parts[2], 10);
      } else {
        day = parseInt(parts[0], 10);
        monStr = parts[1].toLowerCase();
        year = parseInt(parts[2], 10);
      }
      const month = months[monStr] !== undefined ? months[monStr] : parseInt(parts[1], 10) - 1;
      if (!isNaN(day) && !isNaN(month) && !isNaN(year)) {
        if (year < 100) year += 2000;
        const d = new Date(year, month, day);
        if (!isNaN(d.getTime()) && d.getFullYear() === year && d.getMonth() === month && d.getDate() === day) {
          return d;
        }
      }
    }

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
      throw new Error('NSRECORD_SPREADSHEET_ID belum diset di Script Properties.');
    }
    return SpreadsheetApp.openById(NSRECORD_SPREADSHEET_ID);
  }

  function nsGetSheet_(ss) {
    let sheet = ss.getSheetByName(NSRECORD_SHEET_NAME);
    if (!sheet) {
      sheet = ss.getSheets().filter(function (s) {
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

    for (let i = 0; i < headerRow.length; i++) {
      const rawHeader = nsTrim_(headerRow[i]);
      const tag = nsNormalizeTag_(rawHeader);
      if (tag && index._tagMap[tag] === undefined) {
        index._tagMap[tag] = i;
      }
    }

    const missing = [];
    Object.keys(NS_COLUMN_ALIASES).forEach(function (field) {
      const aliasList = NS_COLUMN_ALIASES[field];
      let found = -1;

      for (let i = 0; i < headerRow.length; i++) {
        const h = nsTrim_(headerRow[i]).toLowerCase();
        if (h && aliasList.some(function (a) { return a.toLowerCase() === h; })) {
          found = i;
          break;
        }
      }

      if (found === -1) {
        for (let k = 0; k < aliasList.length; k++) {
          const aliasTag = nsNormalizeTag_(aliasList[k]);
          if (aliasTag && index._tagMap[aliasTag] !== undefined) {
            found = index._tagMap[aliasTag];
            break;
          }
        }
      }

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
        rowNumber: r + 1,
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

    const dupList = Object.keys(duplicateNiks).map(function (nik) {
      return {
        nik: nik,
        orang: records.filter(function (x) { return x.nik === nik; })
          .map(function (x) {
            return { nama: x.nama, bagian: x.bagian, status: x.status, rowNumber: x.rowNumber };
          })
      };
    });

    return { records: records, missingColumns: index._missing, duplicateNiks: dupList };
  }

  function nsCountBy_(records, field) {
    const counts = {};
    records.forEach(function (rec) {
      const key = rec[field] || NSRECORD_UNKNOWN;
      counts[key] = (counts[key] || 0) + 1;
    });
    return Object.keys(counts).map(function (k) {
      return { label: k, value: counts[k] };
    }).sort(function (a, b) { return b.value - a.value; });
  }

  function nsCountBySegment_(records, fieldExtractor) {
    const counts = {};
    const totalPop = records.length;
    records.forEach(function (rec) {
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

    return Object.keys(counts).map(function (k) {
      const item = counts[k];
      item.percent = totalPop > 0 ? Math.round((item.total / totalPop) * 1000) / 10 : 0;
      return item;
    }).sort(function (a, b) { return b.total - a.total; });
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

  // =============================================================================
  // CACHE & PREPARATION
  // =============================================================================
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

  function nsCachePut_(key, obj, ttl) {
    try {
      const str = JSON.stringify(obj);
      if (str.length < 95000) {
        CacheService.getScriptCache().put(key, str, ttl || NSRECORD_CACHE_TTL_SECONDS);
      }
    } catch (e) { }
  }

  function nsCacheRemove_(key) {
    try {
      CacheService.getScriptCache().remove(key);
    } catch (e) { }
  }

  function nsGetDashboardCacheSheet_(ss) {
    let sheet = ss.getSheetByName(NS_DASHBOARD_CACHE_SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(NS_DASHBOARD_CACHE_SHEET_NAME);
      sheet.hideSheet();
    }
    return sheet;
  }

  function nsReadPreparedPayload_(cacheKey) {
    if (nsScheduledPreparation_) return null;
    try {
      const ss = nsGetSpreadsheet_();
      const sheet = ss.getSheetByName(NS_DASHBOARD_CACHE_SHEET_NAME);
      if (!sheet || sheet.getLastRow() < 2) return null;

      const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 4).getValues();
      const todayIso = nsToIsoDate_(nsStartOfDay_(new Date()));
      const matching = values.filter(function (row) {
        return row[0] === cacheKey && row[1] === todayIso;
      }).sort(function (a, b) {
        return Number(a[2]) - Number(b[2]);
      });

      if (!matching.length) return null;
      const combined = matching.map(function (row) { return row[3] || ''; }).join('');
      return JSON.parse(combined);
    } catch (e) {
      return null;
    }
  }

  function nsResetPreparedCache_(ss) {
    const sheet = nsGetDashboardCacheSheet_(ss);
    sheet.clearContents();
    sheet.getRange(1, 1, 1, 4).setValues([['Key', 'Date', 'Chunk', 'Payload']]);
    return sheet;
  }

  function nsWritePreparedPayloads_(sheet, payloads, refreshedOn) {
    const rows = [];
    payloads.forEach(function (item) {
      const json = JSON.stringify(item.payload);
      for (let start = 0, chunk = 1; start < json.length; start += NS_DASHBOARD_CACHE_CHUNK_SIZE, chunk++) {
        rows.push([item.key, refreshedOn, chunk, json.slice(start, start + NS_DASHBOARD_CACHE_CHUNK_SIZE)]);
      }
    });
    if (rows.length) sheet.getRange(2, 1, rows.length, 4).setValues(rows);
  }

  // =============================================================================
  // ENDPOINT 1: HEADCOUNT & DEMOGRAFI
  // =============================================================================
  function getNsHeadcountData(requesterNik) {
    const gate = requireModuleAccess_(requesterNik, 'NS Headcount');
    if (!gate.ok) return gate.response;
    try {
      const prepared = nsReadPreparedPayload_('headcount');
      if (prepared) return JSON.stringify(prepared);
      const cacheKey = nsCacheKey_('headcount');
      const cached = nsCacheGet_(cacheKey);
      if (cached) return JSON.stringify(cached);

      const built = nsBuildRecords_();
      const all = built.records;
      const aktif = all.filter(function (r) { return r.isActive; });
      const nonAktif = all.filter(function (r) { return !r.isActive; });

      const withAge = aktif.filter(function (r) { return r.usia !== null; });
      const avgAge = withAge.length
        ? Math.round((withAge.reduce(function (s, r) { return s + r.usia; }, 0) / withAge.length) * 10) / 10
        : null;
      const withTenure = aktif.filter(function (r) { return r.masaKerjaBulan !== null; });
      const avgTenure = withTenure.length
        ? Math.round((withTenure.reduce(function (s, r) { return s + r.masaKerjaBulan; }, 0) / withTenure.length) * 10) / 10
        : null;

      function buildDrilldown_(records) {
        const bagianToSection = {};
        const sectionToJabatan = {};

        records.forEach(function (r) {
          const bg = r.bagian || NSRECORD_UNKNOWN;
          const sec = r.bagianRaw || bg;
          const jab = r.jabatan || NSRECORD_UNKNOWN;

          if (!bagianToSection[bg]) bagianToSection[bg] = {};
          bagianToSection[bg][sec] = (bagianToSection[bg][sec] || 0) + 1;

          if (!sectionToJabatan[sec]) sectionToJabatan[sec] = {};
          sectionToJabatan[sec][jab] = (sectionToJabatan[sec][jab] || 0) + 1;
        });

        const formatCounts = function (dict, totalRecords) {
          const res = {};
          Object.keys(dict).forEach(function (parentKey) {
            const subMap = dict[parentKey];
            const arr = Object.keys(subMap).map(function (childKey) {
              const cnt = subMap[childKey];
              return {
                label: childKey,
                value: cnt,
                total: cnt,
                percent: totalRecords > 0 ? Math.round((cnt / totalRecords) * 1000) / 10 : 0
              };
            }).sort(function (a, b) { return b.value - a.value; });
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
          perUsia: nsCountBySegment_(records, function (r) { return nsAgeBucket_(r.usia); }),
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
          perUsia: nsCountBySegment_(aktif, function (r) { return nsAgeBucket_(r.usia); }),
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

  // =============================================================================
  // ENDPOINT 2: CONTRACT WATCHLIST
  // =============================================================================
  function getNsContractData(requesterNik) {
    const gate = requireModuleAccess_(requesterNik, 'NS Contract');
    if (!gate.ok) return gate.response;
    try {
      const prepared = nsReadPreparedPayload_('contract_v2');
      if (prepared) return JSON.stringify(prepared);
      const cacheKey = nsCacheKey_('contract_v2');
      const cached = nsCacheGet_(cacheKey);
      if (cached) return JSON.stringify(cached);

      const built = nsBuildRecords_();
      const all = built.records;
      const aktif = all.filter(function (r) { return r.isActive; });
      const nonAktif = all.filter(function (r) { return !r.isActive; });

      function buildContractTenureBreakdown_(records) {
        const byTahun = {};
        records.forEach(function (r) {
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
        Object.keys(byTahun).forEach(function (bKey) {
          const secMap = byTahun[bKey].sectionMap;
          const jabMap = byTahun[bKey].jabatanMap;

          const perSection = Object.keys(secMap).map(function (k) {
            return { label: k, value: secMap[k] };
          }).sort(function (a, b) { return b.value - a.value; });

          const perJabatan = Object.keys(jabMap).map(function (k) {
            return { label: k, value: jabMap[k] };
          }).sort(function (a, b) { return b.value - a.value; });

          res[bKey] = {
            perSection: perSection,
            perJabatan: perJabatan
          };
        });
        return res;
      }

      function getActionTier_(daysLeft) {
        if (daysLeft === null || daysLeft === undefined) return 'watch';
        if (daysLeft < 0) return 'expired';
        if (daysLeft <= 14) return 'urgent';
        if (daysLeft <= 30) return 'eval';
        if (daysLeft <= 60) return 'plan';
        return 'watch';
      }

      function getActionRecommendation_(keterangan, daysLeft) {
        if (daysLeft !== null && daysLeft < 0) {
          return 'Lewat Jatuh Tempo: Segera Konfirmasi Perpanjangan / Update Status HR';
        }
        const ket = (keterangan || '').toString().toLowerCase();
        if (ket.includes('pkwt 1') || ket.includes('kontrak 1') || ket === '1') {
          return 'PKWT 1: Evaluasi Perpanjangan ke PKWT 2';
        }
        if (ket.includes('pkwt 2') || ket.includes('kontrak 2') || ket === '2' || ket.includes('pkwt 3')) {
          return 'Batas PKWT: Keputusan Pengangkatan PKWTT (Tetap) atau Selesai Kontrak';
        }
        if (ket.includes('tetap') || ket.includes('pkwtt')) {
          return 'PKWTT: Evaluasi Kinerja Berkala';
        }
        return 'Tinjau Evaluasi Kinerja & Kebutuhan Manpower Lini';
      }

      function buildWatchlist(list) {
        return list
          .filter(function (r) { return r.sisaHariKontrak !== null && r.sisaHariKontrak <= NS_CONTRACT_WATCH_DAYS; })
          .sort(function (a, b) { return a.sisaHariKontrak - b.sisaHariKontrak; })
          .map(function (r) {
            const tier = getActionTier_(r.sisaHariKontrak);
            return {
              rowNumber: r.rowNumber, nik: r.nik, nama: r.nama,
              bagian: r.bagian, bagianRaw: r.bagianRaw, jabatan: r.jabatan, group: r.group,
              mesin: r.mesin || '-', costCenter: r.costCenter || '-',
              keteranganKontrak: r.keteranganKontrak,
              tanggalMasuk: r.tanggalMasuk,
              tglAwalKontrak: r.tglAwalKontrak || r.tanggalMasuk,
              tglAkhirKontrak: r.tglAkhirKontrak,
              sisaHariKontrak: r.sisaHariKontrak,
              bucketKontrak: r.bucketKontrak,
              masaKerjaText: r.masaKerjaText,
              bucketTahunKontrak: r.bucketTahunKontrak,
              status: r.status,
              actionTier: tier,
              actionRecommendation: getActionRecommendation_(r.keteranganKontrak, r.sisaHariKontrak)
            };
          });
      }

      function buildContractSummary(records) {
        return {
          perUrutan: nsCountBySegment_(records, 'keteranganKontrak'),
          perBucket: nsCountBySegment_(records, 'bucketKontrak'),
          perTahunKontrak: nsCountBySegment_(records, 'bucketTahunKontrak'),
          perSection: nsCountBySegment_(records, 'bagianRaw'),
          perJabatan: nsCountBySegment_(records, 'jabatan'),
          tenureBreakdown: buildContractTenureBreakdown_(records),
          watchlist: buildWatchlist(records),
          // Karyawan tanpa tanggal akhir kontrak tidak bisa masuk watchlist; dihitung agar tidak tak terlihat.
          tanpaTanggalKontrak: records.filter(function (r) { return r.sisaHariKontrak === null || r.sisaHariKontrak === undefined; }).length
        };
      }

      const response = {
        status: 'success',
        data: {
          kpi: {
            totalAktif: aktif.length,
            totalNonAktif: nonAktif.length,
            total: all.length,
            urgent14Hari: aktif.filter(function (r) { return r.sisaHariKontrak !== null && r.sisaHariKontrak >= 0 && r.sisaHariKontrak <= 14; }).length,
            eval30Hari: aktif.filter(function (r) { return r.sisaHariKontrak !== null && r.sisaHariKontrak > 14 && r.sisaHariKontrak <= 30; }).length,
            plan60Hari: aktif.filter(function (r) { return r.sisaHariKontrak !== null && r.sisaHariKontrak > 30 && r.sisaHariKontrak <= 60; }).length,
            kritis30Hari: aktif.filter(function (r) { return r.sisaHariKontrak !== null && r.sisaHariKontrak >= 0 && r.sisaHariKontrak <= NS_CONTRACT_CRITICAL_DAYS; }).length,
            warning60Hari: aktif.filter(function (r) { return r.sisaHariKontrak !== null && r.sisaHariKontrak > NS_CONTRACT_CRITICAL_DAYS && r.sisaHariKontrak <= NS_CONTRACT_WARNING_DAYS; }).length,
            watchlist90Hari: aktif.filter(function (r) { return r.sisaHariKontrak !== null && r.sisaHariKontrak >= 0 && r.sisaHariKontrak <= NS_CONTRACT_WATCH_DAYS; }).length,
            lewatJatuhTempo: aktif.filter(function (r) { return r.sisaHariKontrak !== null && r.sisaHariKontrak < 0; }).length
          },
          aktifData: buildContractSummary(aktif),
          nonAktifData: buildContractSummary(nonAktif),
          allData: buildContractSummary(all),
          perUrutan: nsCountBySegment_(aktif, 'keteranganKontrak'),
          perBucket: nsCountBySegment_(aktif, 'bucketKontrak'),
          perTahunKontrak: nsCountBySegment_(aktif, 'bucketTahunKontrak'),
          perSection: nsCountBySegment_(aktif, 'bagianRaw'),
          perJabatan: nsCountBySegment_(aktif, 'jabatan'),
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

  // =============================================================================
  // ENDPOINT 3: REKRUTMEN & SOURCING
  // =============================================================================
  function getNsRecruitmentData(requesterNik) {
    const gate = requireModuleAccess_(requesterNik, 'NS Recruitment');
    if (!gate.ok) return gate.response;
    try {
      const prepared = nsReadPreparedPayload_('recruitment');
      if (prepared) return JSON.stringify(prepared);
      const cacheKey = nsCacheKey_('recruitment');
      const cached = nsCacheGet_(cacheKey);
      if (cached) return JSON.stringify(cached);

      const built = nsBuildRecords_();
      const all = built.records;
      const aktif = all.filter(function (r) { return r.isActive; });
      const nonAktif = all.filter(function (r) { return !r.isActive; });

      function buildRecData(records) {
        const sources = {};
        const referensiByJoinVia = {};
        records.forEach(function (r) {
          const key = r.joinVia || NSRECORD_UNKNOWN;
          const ref = r.referensi || NSRECORD_UNKNOWN;

          if (!sources[key]) sources[key] = { label: key, total: 0, aktif: 0 };
          sources[key].total++;
          if (r.isActive) sources[key].aktif++;

          if (!referensiByJoinVia[key]) referensiByJoinVia[key] = {};
          referensiByJoinVia[key][ref] = (referensiByJoinVia[key][ref] || 0) + 1;
        });

        const perJoinVia = Object.keys(sources).map(function (k) {
          const s = sources[k];
          return {
            label: s.label, value: s.total, total: s.total, aktif: s.aktif, keluar: s.total - s.aktif,
            retensiPersen: s.total ? Math.round((s.aktif / s.total) * 1000) / 10 : 0
          };
        }).sort(function (a, b) { return b.total - a.total; });

        const referensiMapByJoinVia = {};
        Object.keys(referensiByJoinVia).forEach(function (jv) {
          referensiMapByJoinVia[jv] = Object.keys(referensiByJoinVia[jv]).map(function (ref) {
            return { label: ref, value: referensiByJoinVia[jv][ref] };
          }).sort(function (a, b) { return b.value - a.value; });
        });

        const byMonth = {};
        records.forEach(function (r) {
          if (!r.tanggalMasuk) return;
          const ym = r.tanggalMasuk.slice(0, 7);
          byMonth[ym] = (byMonth[ym] || 0) + 1;
        });
        const trenMasuk = Object.keys(byMonth).sort().map(function (k) {
          return { label: k, value: byMonth[k] };
        });

        return {
          total: records.length,
          perJoinVia: perJoinVia,
          perReferensi: nsCountBy_(records, 'referensi'),
          referensiMapByJoinVia: referensiMapByJoinVia,
          perReasonKeluar: nsCountBy_(records.filter(function (r) { return r.reasonKeluar; }), 'reasonKeluar'),
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
          perReasonKeluar: nsCountBy_(nonAktif.filter(function (r) { return r.reasonKeluar; }), 'reasonKeluar'),
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
  // ENDPOINT 4: MANNING DISTRIBUTION
  // =============================================================================
  function nsFindColumn_(headerRow, aliasList) {
    for (let i = 0; i < headerRow.length; i++) {
      const h = nsTrim_(headerRow[i]).toLowerCase();
      if (h && aliasList.some(function (a) { return a.toLowerCase() === h; })) return i;
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
    Object.keys(NS_MANNING_COLUMN_ALIASES).forEach(function (field) {
      index[field] = nsFindColumn_(headerRow, NS_MANNING_COLUMN_ALIASES[field]);
    });
    return index;
  }

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

  function nsBuildYtdPeriodeList_(today) {
    const ref = nsStartOfDay_(today || new Date());
    const year = ref.getFullYear();
    const currentMonth = ref.getMonth() + 1;
    const list = [];
    for (let month = 1; month <= currentMonth; month++) {
      const mm = month < 10 ? '0' + month : String(month);
      list.push({
        iso: year + '-' + mm,
        label: NS_MONTH_LABELS_ID[month - 1] + ' ' + year,
        sortKey: year * 100 + month,
        isCurrent: month === currentMonth,
        asOfDate: month === currentMonth ? ref : nsStartOfDay_(new Date(year, month, 0))
      });
    }
    return list;
  }

  function nsGetYtdPeriode_(periodeIso, today) {
    const list = nsBuildYtdPeriodeList_(today);
    const selected = list.filter(function (p) { return p.iso === periodeIso; })[0];
    return selected || list[list.length - 1];
  }

  function nsGetManningSheet_(ss) {
    let sheet = ss.getSheetByName(NS_MANNING_SHEET_NAME);
    if (!sheet) {
      sheet = ss.getSheets().filter(function (s) {
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

    const periodeList = Object.keys(periodeSeen).map(function (k) { return periodeSeen[k]; })
      .sort(function (a, b) { return b.sortKey - a.sortKey; });

    return { records: records, periodeList: periodeList };
  }

  function nsBuildCostCenterBagianMap_(allRecords) {
    const counts = {};
    allRecords.forEach(function (r) {
      if (!r.costCenter) return;
      if (!counts[r.costCenter]) counts[r.costCenter] = {};
      const b = r.bagian || NSRECORD_UNKNOWN;
      counts[r.costCenter][b] = (counts[r.costCenter][b] || 0) + 1;
    });
    const map = {};
    Object.keys(counts).forEach(function (cc) {
      let best = null, bestCount = -1;
      Object.keys(counts[cc]).forEach(function (b) {
        if (counts[cc][b] > bestCount) { best = b; bestCount = counts[cc][b]; }
      });
      map[cc] = best || NSRECORD_UNKNOWN;
    });
    return map;
  }

  function nsBuildAktualManningPadaPeriode_(records, asOfDate) {
    const aktif = [];
    let tanpaTanggalMasuk = 0;
    let nonAktifTanpaTanggalKeluar = 0;

    records.forEach(function (r) {
      const joinDate = nsParseDate_(r.tanggalMasuk);
      const exitDate = nsParseDate_(r.tanggalNonAktif);

      if (!joinDate) {
        tanpaTanggalMasuk++;
        return;
      }
      if (joinDate.getTime() > asOfDate.getTime()) return;
      if (exitDate && exitDate.getTime() <= asOfDate.getTime()) return;
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

  function getNsManningData(requesterNik, periodeIso) {
    const gate = requireModuleAccess_(requesterNik, 'NS Manning');
    if (!gate.ok) return gate.response;
    try {
      const today = nsStartOfDay_(new Date());
      const periodeList = nsBuildYtdPeriodeList_(today);
      const selectedPeriode = nsGetYtdPeriode_(periodeIso, today);
      const prepared = nsReadPreparedPayload_('manning_v2:' + selectedPeriode.iso);
      if (prepared) return JSON.stringify(prepared);

      const manning = nsBuildManningRecords_();
      const selectedIso = selectedPeriode.iso;
      const selectedLabel = selectedPeriode.label;
      const asOfDate = selectedPeriode.asOfDate;

      const built = nsBuildRecords_();
      const aktualPadaPeriode = nsBuildAktualManningPadaPeriode_(built.records, asOfDate);
      const aktif = aktualPadaPeriode.records;
      const ccBagianMap = nsBuildCostCenterBagianMap_(aktif);

      const actualByCC = {};
      const ccMesinMap = {};
      const ccGroupMap = {};

      aktif.forEach(function (r) {
        const cc = r.costCenter || NSRECORD_UNKNOWN;
        actualByCC[cc] = (actualByCC[cc] || 0) + 1;

        if (r.mesin && r.mesin !== NSRECORD_UNKNOWN) {
          if (!ccMesinMap[cc]) ccMesinMap[cc] = {};
          ccMesinMap[cc][r.mesin] = (ccMesinMap[cc][r.mesin] || 0) + 1;
        }

        if (r.group && r.group !== NSRECORD_UNKNOWN) {
          if (!ccGroupMap[cc]) ccGroupMap[cc] = {};
          ccGroupMap[cc][r.group] = (ccGroupMap[cc][r.group] || 0) + 1;
        }
      });

      const planByCC = {};
      manning.records.filter(function (m) { return m.periodeIso === selectedIso; }).forEach(function (m) {
        if (!planByCC[m.costCenter]) {
          planByCC[m.costCenter] = { costCenter: m.costCenter, namaCostCenter: m.namaCostCenter, total: 0, byType: {} };
        }
        planByCC[m.costCenter].total += m.headCount;
        planByCC[m.costCenter].byType[m.type] = (planByCC[m.costCenter].byType[m.type] || 0) + m.headCount;
        if (m.namaCostCenter) planByCC[m.costCenter].namaCostCenter = m.namaCostCenter;
      });

      const ccSet = {};
      Object.keys(planByCC).forEach(function (cc) { ccSet[cc] = true; });
      Object.keys(actualByCC).forEach(function (cc) { ccSet[cc] = true; });

      const perCostCenter = Object.keys(ccSet).map(function (cc) {
        const plan = planByCC[cc];
        const actual = actualByCC[cc] || 0;
        const planTotal = plan ? plan.total : 0;
        const gap = actual - planTotal;
        const fulfillmentPercent = planTotal > 0 ? Math.round((actual / planTotal) * 1000) / 10 : null;

        let statusTier = 'BALANCED';
        let recommendation = 'Kebutuhan tenaga kerja terpenuhi sesuai kuota rencana.';

        if (planTotal > 0) {
          if (gap <= -3 || fulfillmentPercent < 85) {
            statusTier = 'CRITICAL';
            recommendation = 'DEFISIT KRITIS: Kekurangan ' + Math.abs(gap) + ' operator (' + fulfillmentPercent + '%). Prioritaskan pinjaman shift atau lembur lintas lini.';
          } else if (gap < 0) {
            statusTier = 'WARNING';
            recommendation = 'DEFISIT MODERAT: Kekurangan ' + Math.abs(gap) + ' operator (' + fulfillmentPercent + '%). Pantau presensi dan jadwal shift.';
          } else if (gap > 0) {
            statusTier = 'SURPLUS';
            recommendation = 'SURPLUS POTENSIAL: Kelebihan ' + gap + ' operator (' + fulfillmentPercent + '%). Dapat diperbantukan ke lini defisit saat briefing.';
          } else {
            statusTier = 'BALANCED';
            recommendation = 'OPTIMAL: Alokasi tenaga kerja 100% sesuai kuota rencana.';
          }
        } else if (actual > 0) {
          statusTier = 'UNBUDGETED';
          recommendation = 'UNBUDGETED: Terdapat ' + actual + ' operator aktif tanpa anggaran headcount resmi di sistem.';
        }

        const mesinList = ccMesinMap[cc]
          ? Object.keys(ccMesinMap[cc]).sort().map(function (m) {
              return { name: m, count: ccMesinMap[cc][m] };
            })
          : [];

        const groupList = ccGroupMap[cc]
          ? Object.keys(ccGroupMap[cc]).sort().map(function (g) {
              return { name: g, count: ccGroupMap[cc][g] };
            })
          : [];

        return {
          costCenter: cc,
          namaCostCenter: (plan && plan.namaCostCenter) || cc,
          bagian: ccBagianMap[cc] || NSRECORD_UNKNOWN,
          planTotal: planTotal,
          planByType: plan ? plan.byType : {},
          actual: actual,
          gap: gap,
          fulfillmentPercent: fulfillmentPercent,
          statusTier: statusTier,
          recommendation: recommendation,
          mesinList: mesinList,
          groupList: groupList
        };
      }).sort(function (a, b) {
        // Sort critical deficit first, then warning, then plan total
        const tierOrder = { CRITICAL: 1, WARNING: 2, SURPLUS: 3, BALANCED: 4, UNBUDGETED: 5 };
        const diff = (tierOrder[a.statusTier] || 99) - (tierOrder[b.statusTier] || 99);
        if (diff !== 0) return diff;
        return a.gap - b.gap;
      });

      const perDepMap = {};
      perCostCenter.forEach(function (row) {
        const b = row.bagian || NSRECORD_UNKNOWN;
        if (!perDepMap[b]) perDepMap[b] = { bagian: b, planTotal: 0, actual: 0 };
        perDepMap[b].planTotal += row.planTotal;
        perDepMap[b].actual += row.actual;
      });
      const perDepartemen = Object.keys(perDepMap).map(function (b) {
        const row = perDepMap[b];
        row.gap = row.actual - row.planTotal;
        row.fulfillmentPercent = row.planTotal > 0 ? Math.round((row.actual / row.planTotal) * 1000) / 10 : null;
        return row;
      }).sort(function (a, b) { return b.planTotal - a.planTotal; });

      const trendMap = {};
      periodeList.forEach(function (p) {
        trendMap[p.iso] = { periodeIso: p.iso, label: p.label, sortKey: p.sortKey, planTotal: 0 };
      });
      manning.records.forEach(function (m) {
        if (trendMap[m.periodeIso]) trendMap[m.periodeIso].planTotal += m.headCount;
      });
      const trend = Object.keys(trendMap).map(function (k) { return trendMap[k]; })
        .sort(function (a, b) { return a.sortKey - b.sortKey; });

      const trendByTypeMap = {};
      periodeList.forEach(function (p) {
        trendByTypeMap[p.iso] = { periodeIso: p.iso, label: p.label, sortKey: p.sortKey, byType: {} };
      });
      manning.records.forEach(function (m) {
        if (trendByTypeMap[m.periodeIso]) {
          trendByTypeMap[m.periodeIso].byType[m.type] = (trendByTypeMap[m.periodeIso].byType[m.type] || 0) + m.headCount;
        }
      });
      const trendByType = Object.keys(trendByTypeMap).map(function (k) { return trendByTypeMap[k]; })
        .sort(function (a, b) { return a.sortKey - b.sortKey; });

      const totalPlan = perCostCenter.reduce(function (s, r) { return s + r.planTotal; }, 0);
      const totalActual = perCostCenter.reduce(function (s, r) { return s + r.actual; }, 0);
      const unmapped = Object.keys(actualByCC).filter(function (cc) { return !planByCC[cc]; });

      let totalDeficitUnits = 0;
      let totalShortageHeadcount = 0;
      let criticalDeficitUnits = 0;
      let warningDeficitUnits = 0;
      let totalSurplusUnits = 0;
      let totalSurplusHeadcount = 0;
      let balancedUnits = 0;

      perCostCenter.forEach(function (r) {
        if (r.gap < 0) {
          totalDeficitUnits++;
          totalShortageHeadcount += Math.abs(r.gap);
          if (r.statusTier === 'CRITICAL') criticalDeficitUnits++;
          else warningDeficitUnits++;
        } else if (r.gap > 0) {
          totalSurplusUnits++;
          totalSurplusHeadcount += r.gap;
        } else {
          balancedUnits++;
        }
      });

      const budgetedCCs = perCostCenter.filter(function (r) { return r.planTotal > 0; });
      const readinessScore = budgetedCCs.length > 0
        ? Math.round((budgetedCCs.filter(function (r) { return r.fulfillmentPercent >= 90; }).length / budgetedCCs.length) * 1000) / 10
        : 100;

      const topShortages = perCostCenter
        .filter(function (r) { return r.gap < 0; })
        .sort(function (a, b) { return a.gap - b.gap; })
        .slice(0, 6);

      const topSurpluses = perCostCenter
        .filter(function (r) { return r.gap > 0; })
        .sort(function (a, b) { return b.gap - a.gap; })
        .slice(0, 6);

      const perTypeCostCenter = manning.records
        .filter(function (m) { return m.periodeIso === selectedIso; })
        .map(function (m) {
          return { type: m.type, costCenter: m.costCenter, namaCostCenter: m.namaCostCenter, headCount: m.headCount };
        })
        .sort(function (a, b) {
          var ta = NS_MANNING_TYPE_ORDER.indexOf(a.type); if (ta === -1) ta = 99;
          var tb = NS_MANNING_TYPE_ORDER.indexOf(b.type); if (tb === -1) tb = 99;
          if (ta !== tb) return ta - tb;
          return b.headCount - a.headCount;
        });

      const response = {
        status: 'success',
        data: {
          periodeList: periodeList,
          selectedPeriode: { iso: selectedIso, label: selectedLabel },
          actualAsOf: {
            iso: nsToIsoDate_(asOfDate),
            label: Utilities.formatDate(asOfDate, Session.getScriptTimeZone(), 'dd MMM yyyy'),
            isCurrentPeriod: selectedPeriode.isCurrent
          },
          kpi: {
            totalPlan: totalPlan,
            totalActual: totalActual,
            gap: totalActual - totalPlan,
            fulfillmentPercent: totalPlan > 0 ? Math.round((totalActual / totalPlan) * 1000) / 10 : null,
            totalDeficitUnits: totalDeficitUnits,
            totalShortageHeadcount: totalShortageHeadcount,
            criticalDeficitUnits: criticalDeficitUnits,
            warningDeficitUnits: warningDeficitUnits,
            totalSurplusUnits: totalSurplusUnits,
            totalSurplusHeadcount: totalSurplusHeadcount,
            balancedUnits: balancedUnits,
            readinessScore: readinessScore,
            topShortages: topShortages,
            topSurpluses: topSurpluses
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
      return JSON.stringify(response);
    } catch (error) {
      return JSON.stringify({ status: 'error', message: error.toString(), data: null });
    }
  }

  // =============================================================================
  // REFRESH & AUDIT SCHEDULER
  // =============================================================================
  function nsGetOrCreateHeadcountMonthlySheet_(ss) {
    let sheet = ss.getSheetByName(NS_HEADCOUNT_MONTHLY_SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(NS_HEADCOUNT_MONTHLY_SHEET_NAME);
      sheet.setFrozenRows(1);
    }
    sheet.getRange(1, 1, 1, 6).setValues([[
      'Periode', 'As Of', 'Cost Center', 'Bagian', 'Headcount', 'Refreshed At'
    ]]);
    return sheet;
  }

  function nsWriteHeadcountMonthly_(ss, built, periodeList, refreshedAt) {
    const sheet = nsGetOrCreateHeadcountMonthlySheet_(ss);
    if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, 6).clearContent();

    const rows = [];
    periodeList.forEach(function (periode) {
      const population = nsBuildAktualManningPadaPeriode_(built.records, periode.asOfDate).records;
      const byCostCenter = {};
      population.forEach(function (record) {
        const cc = record.costCenter || NSRECORD_UNKNOWN;
        if (!byCostCenter[cc]) byCostCenter[cc] = { count: 0, bagian: record.bagian || NSRECORD_UNKNOWN };
        byCostCenter[cc].count++;
      });
      Object.keys(byCostCenter).sort().forEach(function (cc) {
        const row = byCostCenter[cc];
        rows.push([periode.label, nsToIsoDate_(periode.asOfDate), cc, row.bagian, row.count, refreshedAt]);
      });
    });
    if (rows.length) sheet.getRange(2, 1, rows.length, 6).setValues(rows);
    sheet.autoResizeColumns(1, 6);
    return rows.length;
  }

  // PATCH P2: gerbang admin eksplisit (lihat daftar patch di header file).
  function nsInstallDailyDashboardRefresh() {
    if (typeof nsAssertAdmin_ === 'function') {
      nsAssertAdmin_('pemasangan scheduler harian');
    } else {
      throw new Error('nsAssertAdmin_ tidak tersedia - pastikan ns record.gs ikut ter-deploy.');
    }
    return nsInstallDailyDashboardRefresh_();
  }

  function nsInstallDailyDashboardRefresh_(adminNik) {
    let nik = nsTrim_(adminNik) || nsTrim_(PropertiesService.getScriptProperties().getProperty(NS_DASHBOARD_REFRESH_NIK_PROPERTY));
    if (!nik) {
      const effectiveEmail = (Session.getEffectiveUser().getEmail() || '').toString().trim();
      const profile = typeof getKaryawanProfileByEmail_ === 'function' ? getKaryawanProfileByEmail_(effectiveEmail) : null;
      nik = profile ? nsTrim_(profile.nik) : '';
    }
    if (!nik) {
      throw new Error('NIK admin scheduler tidak ditemukan. Tambahkan Script Property NS_DASHBOARD_REFRESH_NIK, lalu jalankan kembali.');
    }
    const props = PropertiesService.getScriptProperties();
    props.setProperty(NS_DASHBOARD_REFRESH_NIK_PROPERTY, nik);

    ScriptApp.getProjectTriggers().forEach(function (trigger) {
      if (trigger.getHandlerFunction() === NS_DASHBOARD_REFRESH_HANDLER) ScriptApp.deleteTrigger(trigger);
    });
    ScriptApp.newTrigger(NS_DASHBOARD_REFRESH_HANDLER)
      .timeBased()
      .atHour(1)
      .nearMinute(0)
      .everyDays(1)
      .inTimezone(Session.getScriptTimeZone())
      .create();

    return nsRefreshDashboardCache_();
  }

  function nsRefreshDashboardCache_() {
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      const adminNik = nsTrim_(PropertiesService.getScriptProperties().getProperty(NS_DASHBOARD_REFRESH_NIK_PROPERTY));
      if (!adminNik) {
        throw new Error('NS_DASHBOARD_REFRESH_NIK belum diatur. Jalankan nsInstallDailyDashboardRefresh dari GAS Editor.');
      }

      nsScheduledPreparation_ = true;
      const ss = nsGetSpreadsheet_();
      const refreshedOn = nsToIsoDate_(nsStartOfDay_(new Date()));
      const refreshedAt = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
      const cacheSheet = nsResetPreparedCache_(ss);

      ['headcount', 'contract', 'recruitment'].forEach(function (name) {
        nsCacheRemove_(nsCacheKey_(name));
      });

      const payloads = [];
      [
        { key: 'headcount', call: function () { return getNsHeadcountData(adminNik); } },
        { key: 'contract', call: function () { return getNsContractData(adminNik); } },
        { key: 'recruitment', call: function () { return getNsRecruitmentData(adminNik); } }
      ].forEach(function (item) {
        const response = JSON.parse(item.call());
        if (response.status !== 'success') throw new Error('Gagal menyiapkan ' + item.key + ': ' + (response.message || response.status));
        response.data.preparedAt = refreshedAt;
        payloads.push({ key: item.key, payload: response });
      });

      const periodeList = nsBuildYtdPeriodeList_(new Date());
      periodeList.forEach(function (periode) {
        const response = JSON.parse(getNsManningData(adminNik, periode.iso));
        if (response.status !== 'success') throw new Error('Gagal menyiapkan Manning ' + periode.iso + ': ' + (response.message || response.status));
        response.data.preparedAt = refreshedAt;
        payloads.push({ key: 'manning_v2:' + periode.iso, payload: response });
      });

      nsWritePreparedPayloads_(cacheSheet, payloads, refreshedOn);
      const built = nsBuildRecords_();
      const monthlyRows = nsWriteHeadcountMonthly_(ss, built, periodeList, refreshedAt);
      SpreadsheetApp.flush();
      return { ok: true, refreshedAt: refreshedAt, cachedPayloads: payloads.length, monthlyRows: monthlyRows };
    } finally {
      nsScheduledPreparation_ = false;
      lock.releaseLock();
    }
  }

  function nsRecordSelfTest() {
    const built = nsBuildRecords_();
    const aktif = built.records.filter(function (r) { return r.isActive; });
    Logger.log('Total record  : ' + built.records.length);
    Logger.log('Aktif         : ' + aktif.length);
    Logger.log('Non Aktif     : ' + (built.records.length - aktif.length));
    Logger.log('Kolom hilang  : ' + (built.missingColumns.length ? built.missingColumns.join(', ') : 'tidak ada'));
    Logger.log('NIK duplikat  : ' + (built.duplicateNiks.length ? built.duplicateNiks.map(function (d) { return d.nik; }).join(', ') : 'tidak ada'));
    Logger.log('Per bagian: ' + JSON.stringify(nsCountBy_(aktif, 'bagian')));
    return built.records.length;
  }

  return {
    getNsHeadcountData: getNsHeadcountData,
    getNsContractData: getNsContractData,
    getNsRecruitmentData: getNsRecruitmentData,
    getNsManningData: getNsManningData,
    nsRecordSelfTest: nsRecordSelfTest,
    nsInstallDailyDashboardRefresh: nsInstallDailyDashboardRefresh,
    nsRefreshDashboardCache_: nsRefreshDashboardCache_
  };
})();

// =============================================================================
// TOP-LEVEL GAS EXPORTED ENDPOINTS
// =============================================================================
function getNsHeadcountData(requesterNik) {
  return TrialHrDomain.getNsHeadcountData(requesterNik);
}

function getNsContractData(requesterNik) {
  return TrialHrDomain.getNsContractData(requesterNik);
}

function getNsRecruitmentData(requesterNik) {
  return TrialHrDomain.getNsRecruitmentData(requesterNik);
}

function getNsManningData(requesterNik, periodeIso) {
  return TrialHrDomain.getNsManningData(requesterNik, periodeIso);
}

// PATCH P1: gerbang admin (lihat daftar patch di header file).
function nsRecordSelfTest() {
  if (typeof nsAssertAdmin_ === 'function') {
    nsAssertAdmin_('self test modul HR');
  } else {
    throw new Error('nsAssertAdmin_ tidak tersedia - pastikan ns record.gs ikut ter-deploy.');
  }
  return TrialHrDomain.nsRecordSelfTest();
}

function nsInstallDailyDashboardRefresh() {
  return TrialHrDomain.nsInstallDailyDashboardRefresh();
}

function nsRefreshDashboardCache_() {
  return TrialHrDomain.nsRefreshDashboardCache_();
}

// PATCH P3 + P4: gerbang admin, dan resolusi ID spreadsheet yang menghormati
// Script Property (lihat daftar patch di header file).
function nsInspectSpreadsheetLive() {
  if (typeof nsAssertAdmin_ === 'function') {
    nsAssertAdmin_('inspeksi struktur spreadsheet HR');
  } else {
    throw new Error('nsAssertAdmin_ tidak tersedia - pastikan ns record.gs ikut ter-deploy.');
  }

  const nsInspectSpreadsheetId = (typeof getHrSpreadsheetId_ === 'function')
    ? getHrSpreadsheetId_()
    : '1qSTpi6OwUOBoORIALBCdwWehH-R0L8az4vwuaOV3shU';
  const ss = SpreadsheetApp.openById(nsInspectSpreadsheetId);
  const sheets = ss.getSheets();
  const info = sheets.map(function(s) {
    const lastRow = s.getLastRow();
    const lastCol = s.getLastColumn();
    let headers = [];
    if (lastRow > 0 && lastCol > 0) {
      headers = s.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) { return String(h || '').trim(); });
    }
    return {
      name: s.getName(),
      rows: lastRow,
      cols: lastCol,
      headers: headers
    };
  });
  return JSON.stringify(info);
}
