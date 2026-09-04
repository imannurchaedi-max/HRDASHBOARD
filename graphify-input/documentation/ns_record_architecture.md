# Arsitektur HR DASHBOARD (NS RECORD)

Aplikasi web pencatatan & pelaporan karyawan **Non Staff (NS)** PT DAM berbasis Google Apps Script. Update terakhir: **7 Agu 2026**.

> **NS = Non Staff** (karyawan level floor). Seluruh isi sheet `MASTER KARYAWAN` adalah Non Staff — tidak ada filter level di aplikasi ini.

> **Web app MANDIRI, terpisah dari DAM PORTAL.** Keputusan user 16 Jul 2026. Rencana awal adalah menjadikan NS Record modul di dalam DAM PORTAL (project DT VAL SUM 26), tapi diubah menjadi project GAS standalone bernama **HR DASHBOARD (NS RECORD)** dengan login dan `index.html` sendiri.

---

## 1. Ikhtisar

```
+---------------------------------------------------------------+
|  HR DASHBOARD (project GAS standalone)                         |
|  +-------------+  +------------------------------------------+ |
|  | index.html  |  | ns record.gs                             | |
|  | login       |  |  doGet() -> render index.html            | |
|  | shell+4 tab |--|  userLogin / getSessionUser /            | |
|  |             |  |  revalidateUser / keepSessionAlive       | |
|  +-------------+  |  getNsHeadcountData(nik)                 | |
|                   |  getNsContractData(nik)                  | |
|                   |  getNsRecruitmentData(nik)               | |
|                   |  getNsManningData(nik, periodeIso)       | |
|                   +------------------+-----------------------+ |
+--------------------------------------|-------------------------+
                                       |
              +------------------------+------------------------+
              |                                                 |
   +----------v-----------+                      +--------------v-------------+
   | Spreadsheet "HR       |                      | Spreadsheet "DATA KARYAWAN"|
   | DASHBOARD"            |                      | (auth terpusat)            |
   | ID 1qSTpi6Ow...OV3shU |                      | ID 14OTl9xY...NgFby6FjY9o  |
   | tab: MASTER KARYAWAN, |                      | tab: KARYAWAN              |
   |  MANNING DISTRIBUTION,|                      | (dipakai bersama DAM PORTAL|
   |  CONFIG, TRAINING     |                      |  dan EWO/aplikasi lain -   |
   |  (kosong/rusak, lihat |                      |  banyak kolom di luar NS   |
   |  §3.2), Design        |                      |  Record: OEE Dashboard,   |
   |  Dashboard, MOM,      |                      |  Downtime Dashboard, TPP,  |
   |  STSP Karyawan, LIB   |                      |  MOM, dst.)                |
   | (=NSRECORD_SPREADSHEET|                      | (=KARYAWAN_SPREADSHEET_ID) |
   |  _ID, Script Property |                      +----------------------------+
   |  WAJIB diisi)         |
   +----------------------+
```

Kedua ID di atas adalah **fallback hardcode** di kode (`NSRECORD_SPREADSHEET_ID` di `ns record.gs:33-35`, `KARYAWAN_SPREADSHEET_ID` di `ns record.gs:42-44`) — bisa dioverride lewat Script Properties dengan nama yang sama, tapi hardcode inilah yang dipakai selama Script Property belum diset. **Judul file spreadsheet** ("HR DASHBOARD" / "DATA KARYAWAN") murni kosmetik dan tidak memengaruhi apa pun — GAS membuka spreadsheet lewat ID (`openById`), bukan lewat judul; sheet-sheet di dalamnya juga dicari by nama tab, independen dari judul file induknya.

**File:**

| File | Isi |
|---|---|
| `ACTIVE/ShellWebApp.gs` | **Thin Redirector Shell (1-Link Permanent)**: Dipasang sekali sebagai Web App publik; membaca URL `/exec` deployment backend aktif dari sel `CONFIG!A2` di Spreadsheet HR DASHBOARD lalu melakukan instant redirect. Set title Web App ke `HR DASHBOARD`. |
| `ACTIVE/ns record.gs` | Backend: entry point, auth, login, normalisasi (35+ kolom), 4 endpoint data + payload breakdown masa kerja (`tenureBreakdown`) dan rencana vs aktual Manning. |
| `ACTIVE/index.html` | Frontend: halaman login + sidebar fixed (`position: fixed`) + topbar + 4 panel (Chart.js), branding **HR DASHBOARD**, multi-level drill-down filter (Masa Kerja ➔ Section ➔ Jabatan ➔ Table), dual Y-axis scaling 1-to-1, datalabel pastel amber, dan sorting header tabel Watchlist. |

---

### 1.1 Shell Redirector (Permanent 1-Link Deployment)
Aplikasi mengadopsi arsitektur **Shell WebApp** persis seperti `0. DT SUMMARY`. Di sheet `CONFIG` (spreadsheet HR DASHBOARD), layout aktualnya (diverifikasi 7 Agu 2026):

| Sel | Isi |
|---|---|
| A1 | label `Link App` |
| A2 | URL `/exec` deployment **backend** (`ns record.gs`) yang sedang aktif — **inilah yang dibaca `ShellWebApp.gs`** |
| A4 | label `Link Shell` |
| A5 | URL `/exec` deployment **ShellWebApp.gs sendiri** — ini yang dibagikan ke user sebagai link permanen. Baris ini murni catatan/referensi manual, tidak dibaca oleh kode manapun. |

Alurnya:
1. Pengguna hanya perlu menyimpan **1 URL Shell tetap** (nilai di `CONFIG!A5`, deployment `ShellWebApp.gs`).
2. Setiap kali ada pembaruan & deployment baru untuk backend (`ACTIVE/ns record.gs`), URL `/exec` yang baru cukup di-paste ke `CONFIG!A2`.
3. `ShellWebApp.gs` membaca `CONFIG!A2`, memvalidasi format URL, set judul browser tab ke `HR DASHBOARD`, dan otomatis mengarahkan user ke backend aktif tanpa perlu membagikan link baru ke user.
4. Deep link / query string (`?tab=...`) otomatis diteruskan.

**Jebakan operasional (ketahuan 6-7 Agu 2026, butuh sesi debug panjang):** setiap `Deploy > New deployment` (atau `Manage deployments > New version`) di GAS Editor mengambil **snapshot beku** dari kode yang tersimpan di detik itu juga. Kalau ADA edit/paste lagi ke `ns record.gs` atau `index.html` setelah sebuah deployment dibuat — walau cuma satu file yang kelewat — URL `/exec` deployment itu **tetap menyajikan kode lama** sampai deployment/version BARU dibuat lagi. Ini bukan soal cache browser atau CDN; ini perilaku GAS sendiri. Checklist tiap kali update kode:
1. Pastikan **kedua** file (`ns record.gs` DAN `index.html`) sudah di-paste ulang & tersimpan.
2. Baru setelah itu buat deployment/version baru.
3. Test langsung di URL `/exec` backend (bukan lewat Shell dulu) untuk isolasi — kalau masih salah di situ, deploymentnya yang bermasalah, bukan `CONFIG!A2`/Shell.

---

### 1.2 Keselarasan UI/UX & Fitur Modern HR DASHBOARD
Untuk memberikan pengalaman analisis data HR yang intuitif dan cepat:
1. **Branding & Branding Visual**: Menggunakan nama resmi **HR DASHBOARD** pada `<title>`, logo topbar/sidebar (`HR HR DASHBOARD`), dan launcher `ShellWebApp.gs`.
2. **Fixed Navigation Sidebar**: Sidebar menggunakan `position: fixed` agar navigasi modul tidak ikut tergulung saat melakukan scroll pada tabel data yang panjang.
3. **Pastel Amber Percentage Datalabel Pill**: Label persentase pada grafik menggunakan desain frosted pastel amber (`rgba(254, 243, 199, 0.95)`) dengan teks deep amber (`#92400e`) dan border tipis emas (`#fcd34d`) untuk keterbacaan maksimal tanpa kesan mencolok/hitam pekat.
4. **1-to-1 Dual Y-Axis Pareto Scale Synchronization**: Skala Sumbu Y Kiri (Jumlah Karyawan) dan Sumbu Y Kanan (% Populasi) disinkronkan secara matematis (`leftMax = Math.ceil(maxCount * 1.28)` & `rightMax = Math.ceil((leftMax / totalPop) * 100)`) sehingga titik grafik garis persentase jatuh tepat sejajar di atas batang diagram tanpa saling bertabrakan.
5. **Multi-Level Drill-Down & Mother-Daughter Filters**:
   - **Sebaran Masa Kerja (`cTahunKontrak`)**: Klik batang masa kerja (mis. `0 - 1 Thn`) menampilkan breakdown Section & Jabatan serta menyaring tabel Watchlist.
   - **Distribusi Section (`cTahunSection`)**: Klik departemen/section (mis. `Production Diapers`) menyaring grafik Jabatan dan tabel Watchlist hanya untuk section tersebut.
   - **Distribusi Jabatan (`cTahunJabatan`)**: Klik posisi/jabatan (mis. `Packer`) menyaring tabel Watchlist khusus untuk jabatan tersebut.
   - **Indikator Filter Komposit**: Menampilkan chip filter aktif (`Masa Kerja: 0 - 1 Thn`, `Section: Production Diapers`, `Jabatan: Packer`) dengan opsi reset individu maupun reset total.
6. **Interactive Column Header Sorting pada Tabel Watchlist**:
   - Seluruh 11 header tabel (`NIK`, `Nama`, `Bagian`, `Jabatan`, `Urutan Kontrak`, `Tanggal Masuk`, `Tanggal Awal Kontrak`, `Tanggal Akhir Kontrak`, `Sisa`, `Total Masa Kerja`, `Status`) mendukung pengurutan **Small to Big (Ascending)** / **Big to Small (Descending)** via klik header.
   - Indikator panah visual `▲` (Ascending) & `▼` (Descending) beserta hover icon `⇅`.

---

## 2. Fungsi Utama (`ns record.gs`)

**Entry point:** `doGet()` → render `index.html`

| Fungsi | Deskripsi |
|---|---|
| `userLogin(nik, password)` | Autentikasi NIK+password via sheet KARYAWAN (kolom A & F). Ada throttle 5x gagal / 15 menit per NIK (`checkLoginThrottle_`) untuk menutup brute-force lewat `google.script.run` dari console browser. |
| `getSessionUser()` | Auto-login (SSO) via email sesi Google, cocokkan ke kolom G KARYAWAN. Hanya aktif di deploy "Anyone within domain". |
| `revalidateUser(nik)` | Validasi ulang sesi tersimpan di `sessionStorage`. Wajib lewat `resolveRequestUserProfile_` — kalau ada sesi Google, nik hasil resolusi email **menimpa** nik kiriman client. |
| `keepSessionAlive()` | Ping ringan tiap 20 menit dari client, menjaga token OAuth GAS tetap hidup. Tidak membaca data. |
| `requireModuleAccess_(nik, modul)` | **Guard server-side semua endpoint data.** Verifikasi email sesi Google dulu, fallback ke nik client. Sengaja dipakai menggantikan `hasModuleAccess_` polos — data di app ini adalah data pribadi karyawan. |
| `getNsHeadcountData(nik)` | Panel Headcount & Demografi: KPI, per departemen/bagian/group/gender/ring/usia. |
| `getNsContractData(nik)` | Panel Contract Watchlist: KPI bucket jatuh tempo, watchlist 90 hari terurut, breakdown masa kerja per section & jabatan (`buildContractTenureBreakdown_`). |
| `getNsRecruitmentData(nik)` | Panel Rekrutmen: retensi per sumber, tren bulanan, referensi, domisili. |
| `getNsManningData(nik, periodeIso)` | Panel Manning Distribution: periode selalu **Jan sampai bulan berjalan** (YTD terhadap `NOW()`), default bulan berjalan. Bulan berjalan dihitung sampai hari ini; bulan lampau ditutup pada akhir bulan. Plan dari `MANNING DISTRIBUTION`, aktual dari `Tanggal Masuk <= as-of` dan `Tanggal Efektif Non Aktif > as-of`. Payload harian siap-baca diprioritaskan agar UI tidak mengolah raw table saat pagi hari. |
| `nsInstallDailyDashboardRefresh()` | **Dijalankan sekali dari dropdown Run GAS Editor setelah deploy.** Mengambil NIK dari email owner (atau Script Property `NS_DASHBOARD_REFRESH_NIK` bila perlu), membuat/mereset installable trigger harian sekitar 01.00 Asia/Jakarta, lalu langsung menjalankan refresh pertama. Hanya akun pemilik script yang diizinkan menjalankannya. |
| `nsRefreshDashboardCache_()` | Target trigger privat: menghitung 4 panel dari raw source, menyimpan payload siap-baca ke `_NS_DASHBOARD_CACHE`, lalu menulis audit trail YTD Cost Center ke `NS HEADCOUNT MONTHLY`. |
| `nsRecordSelfTest()` | **Dijalankan manual dari GAS Editor.** Verifikasi koneksi + struktur kolom tanpa lewat UI. Log jumlah record, kolom hilang, NIK duplikat, headcount per departemen. Tidak butuh hak modul. |

**Konvensi endpoint (semua 4 endpoint data):** parameter `nik` di posisi **pertama**, `return JSON.stringify(...)`, digerbangi `requireModuleAccess_`, cache `CacheService` 10 menit.

**Helper khusus modul Manning** (dipanggil dari `getNsManningData`, tidak dipanggil langsung dari client):

| Fungsi | Deskripsi |
|---|---|
| `nsBuildManningRecords_()` | Baca sheet `MANNING DISTRIBUTION`, parse tiap baris jadi `{type, periodeIso, periodeLabel, periodeSortKey, costCenter, namaCostCenter, headCount}`. Baris dengan `costCenter`/`periode` kosong atau tidak valid dilewati. Periode UI sendiri dibentuk oleh kalender YTD, bukan oleh periode terakhir yang tersedia di plan. |
| `nsBuildYtdPeriodeList_(today)` | Bentuk Jan sampai bulan `today`; memastikan dropdown tetap memiliki bulan berjalan meskipun plan bulan itu belum diisi. |
| `nsBuildManningColumnIndex_(headerRow)` / `nsFindColumn_(headerRow, aliasList)` | Cari indeks kolom sheet Manning by nama header (exact match lalu fallback tag), independen dari `nsBuildColumnIndex_` milik MASTER KARYAWAN. |
| `nsParsePeriode_(raw)` | Normalisasi kolom `Periode` yang formatnya campur: string `"MM.YYYY"` (mis. `"04.2026"`) atau angka `M(M)YYYY` tanpa leading zero (mis. `112025` = Nov 2025, `22026` = Feb 2026). Mengembalikan `{iso, label, sortKey}` atau `null` kalau tidak bisa di-parse. |
| `nsBuildCostCenterBagianMap_(allRecords)` | Petakan tiap `costCenter` ke `bagian` (Departemen) berdasarkan **mayoritas** karyawan aktual di Cost Center itu — sheet Manning sendiri tidak punya kolom Departemen, jadi ini bukan sumber independen. Cost Center tanpa karyawan aktual sama sekali jatuh ke `(Tidak Diketahui)`. |

---

## 3. Struktur Data — tab `MASTER KARYAWAN`

Header **baris 1**, data mulai **baris 2**.

**35 kolom (A:AI)** dengan sistem **Dynamic Column Tagging**.

| Col | Header Terbaru | Alias / Legacy Header | Dipakai |
|---|---|---|---|
| A | `No` | `No.` | — |
| B | `NIK` | `Nik`, `No NIK` | identitas (**tidak unik**, lihat §4) |
| C | `No KTP` | `KTP`, `No. KTP` | dibaca (`noKtp`) |
| D | `Nama` | `Nama Karyawan` | identitas, watchlist |
| E | `TEMPAT` | `Tempat`, `Tempat Lahir` | tempat lahir |
| F | `TANGGAL LAHIR` | `Tanggal Lahir`, `Tanggal` | tanggal lahir → **sumber usia** |
| G | `USIA` | `Usia` | **TIDAK dibaca** — string statis, dihitung ulang dari F |
| H | `JENIS KELAMIN` | `Jenis Kelamin`, `Gender`, `JK` | donut gender (normalisasi `L`/`P`) |
| I | `DEPARTEMEN` | `Departement`, `Departemen`, `Dept` | headcount (**di-reclass**, lihat §4) |
| J | `SECTION` | `Section`, `Bagian` | headcount section + penentu reclass |
| K | `JABATAN` | `Jabatan`, `Job Title` | penentu reclass departemen |
| L | `MESIN` | `Mesin` | dibaca (`mesin`) |
| — | `COST CENTER` | `Cost Center`, `CC` | **dipakai sejak 6 Agu 2026** — join key ke sheet `MANNING DISTRIBUTION` (`costCenter`, panel Manning). Posisi kolom aktual bergeser-geser antar revisi sheet; ditemukan lewat Dynamic Column Tagging, bukan huruf kolom tetap. |
| M | `GROUP` | `Group`, `Grup` | sebaran group shift |
| N | `TANGGAL MASUK` | `Tanggal Masuk`, `Tgl Masuk` | **sumber masa kerja** + tren rekrutmen |
| O/P/Q | `TAHUN`/`BULAN`/`HARI` | — | **TIDAK dibaca** — statis, basi |
| R | `URUTAN KONTRAK` | `Keterangan Kontrak`, `Urutan Kontrak` | siklus kontrak (`Kontrak ke-1`..`ke-10`) |
| S | `TANGGAL AKHIR KONTRAK`| `Tgl Akhir Kontrak`, `Tanggal Akhir Kontrak` | **watchlist + bucket jatuh tempo** |
| — | `TANGGAL AWAL KONTRAK` | — | dibaca sejak 28 Agu 2026 (tglAwalKontrak) — watchlist memakai kolom ini, fallback tanggalMasuk kalau kosong (fix B3). |
| T | `ALAMAT LENGKAP` | `Alamat Lengkap`, `Alamat` | dibaca (`alamatLengkap`) |
| U | `DESA` | `Desa` | dibaca (`desa`) |
| V | `RT` | `Rt` | dibaca (`rt`) |
| W | `RW` | `Rw` | dibaca (`rw`) |
| X | `KELURAHAN` | `Kelurahan`, `Kp` | dibaca (`kelurahan`) |
| Y | `KECAMATAN` | `Kecamatan` | panel Rekrutmen |
| Z | `KOTA/KABUPATEN` | `Kota/Kabupaten`, `Kota / Kabupaten` | dibaca (`kota`) |
| AA | `PROVINSI` | `Provinsi` | dibaca (`provinsi`) |
| AB | `RING` | `Ring` | domisili (Ring 1–4) |
| AC | `JOIN VIA` | `Join Via` | **retensi per sumber** (TKD/KMJ/LINK) |
| AD | `REFERENSI JOIN` | `Referensi`, `Referensi Join` | panel Rekrutmen |
| AE | `JALUR JOIN` | `Jalur Join` | dibaca (`jalurJoin`) |
| AF | `STATUS` | `Status` | `AKTIF` / `NON AKTIF` — pemisah utama |
| AG | `TANGGAL EFEKTIF NON AKTIF`| `Tanggal Efektif Non Aktif`, `Tanggal Efektifk Non Aktif` | masa kerja saat keluar |
| AH | `ALASAN KELUAR` | `Reason Keluar`, `Alasan Keluar` | dibaca, panel Turnover |
| AI | `PENDIDIKAN` | `Pendidikan` | panel Headcount (`perPendidikan`) |

---

### 3.1 Struktur Data — sheet `KARYAWAN` (auth, spreadsheet DATA KARYAWAN terpisah)

Header baris 1, data mulai baris 2. Kolom inti yang dibaca kode (posisi huruf bisa beda, tetap dicari by index tetap A-G untuk kolom inti — lihat `getKaryawanData_`/`nsUserResponse_`):

| Kolom | Isi | Dipakai |
|---|---|---|
| A | NIK | identitas, login |
| B | Nama | ditampilkan di sidebar user |
| C | Departemen | ditampilkan di sidebar user (`uRl`) |
| D | Jabatan | — |
| E | Otorisasi | `otorisasi` di response, tidak dipakai untuk gating modul |
| F | Password | `userLogin` (plain text, dicocokkan string) |
| G | Email | dicocokkan ke `Session.getActiveUser().getEmail()` untuk SSO & prioritas identitas |

Kolom **modul akses** dicari **by nama header** (bukan huruf tetap) via `NS_ACCESS_MODULES` (`getModuleAccessMapFromRow_`), nilai `1` = akses, selain itu = tidak:
- `NS Headcount`, `NS Contract`, `NS Recruitment`, **`NS Manning`** (ditambahkan 6-7 Agu 2026 bersamaan modul Manning; wajib diisi manual oleh admin untuk NIK yang berhak, tidak ada default akses).

Sheet ini juga punya banyak kolom **di luar cakupan NS Record** (dipakai app lain yang berbagi spreadsheet yang sama — Output Summary, Performance Monitoring, OEE Dashboard, Downtime Dashboard, Reject Rate, Material Balance, TPP, MOM, Berat, Absorb, Rewet, Tanda Tangan, TASKLIST, dll) — NS Record hanya baca 7 kolom inti + kolom modul di atas, tidak menyentuh kolom lain.

---

### 3.2 Struktur Data — sheet `MANNING DISTRIBUTION` (spreadsheet HR DASHBOARD)

Header baris 1, data mulai baris 2, dicari by nama header (`NS_MANNING_COLUMN_ALIASES`):

| Header | Field internal | Catatan |
|---|---|---|
| `Type` | `type` | `STAFF` / `IDL` / `DL` |
| `Periode` | `periode` (parsed) | Format campur `MM.YYYY` atau `M(M)YYYY` — lihat `nsParsePeriode_` di §2 |
| `Comp` | `comp` | dibaca, tidak dipakai di payload response |
| `Comp Code` | `compCode` | dibaca, tidak dipakai di payload response |
| `Cost Center` | `costCenter` | **join key** ke `COST CENTER` di MASTER KARYAWAN |
| `Head count` | `headCount` | angka rencana (plan) |
| `Nama Cost Center` | `namaCostCenter` | label tampilan (lebih rinci dari Departemen, lihat §2 `nsBuildCostCenterBagianMap_`) |

**Catatan penting:** tab `TRAINING` yang ada di spreadsheet yang sama **kosong/rusak** — cuma berisi 1 sel `#REF!` (formula error dari referensi yang sudah terhapus), tidak ada header maupun data. Tidak dibaca oleh kode manapun; kalau suatu saat mau dipakai, sheet sumbernya harus diperbaiki dulu oleh yang punya akses edit.

---

## 4. Normalisasi & Masalah Data Sumber

Sheet diisi manual HR bertahun-tahun. Normalisasi dilakukan **saat baca saja** — sheet tidak pernah ditulis ulang.

---

## 5. Konsekuensi Berdiri Sendiri

Lapisan auth dan endpoint terduplikasi secara independen sehingga aplikasi dapat berjalan cepat tanpa beban dependency eksternal.

---

## 6. Deployment

> Deployment = **copy-paste manual via GAS Editor**. Tidak pakai `clasp`.

| File lokal | Langkah |
|---|---|
| `ACTIVE/ns record.gs` | GAS Editor → file `ns record.gs` → Select All → Paste → Save |
| `ACTIVE/ShellWebApp.gs` | GAS Editor → file `ShellWebApp.gs` → Select All → Paste → Save |
| `ACTIVE/index.html` | GAS Editor → file `index.html` → Select All → Paste → Save |

**Wajib setelah paste:** buat deployment/version baru (`Deploy > New deployment` atau `Manage deployments > New version`) — menyimpan kode di editor **tidak otomatis** memperbarui URL `/exec` yang sudah ada (lihat jebakan operasional di §1.1). Kalau lupa, URL live akan tetap menyajikan kode versi sebelumnya walau file di editor sudah benar.

### 6.1 Menyalakan prepared dashboard (sekali saja)

1. Pastikan akun Google pemilik script terdaftar di sheet `KARYAWAN` dan NIK-nya memiliki nilai `1` untuk keempat modul NS.
2. Setelah `ns record.gs` ter-paste dan disimpan, pilih fungsi `nsInstallDailyDashboardRefresh` di dropdown Run GAS Editor, lalu jalankan dan setujui otorisasi. Jika email owner tidak ada di KARYAWAN, buat Script Property `NS_DASHBOARD_REFRESH_NIK` berisi NIK admin terlebih dahulu.
3. Fungsi tersebut membuat dua tab di spreadsheet HR DASHBOARD: `NS HEADCOUNT MONTHLY` (terlihat, audit trail YTD per Cost Center) dan `_NS_DASHBOARD_CACHE` (tersembunyi, payload UI siap-baca).

Google Apps Script menargetkan pukul 01.00 Asia/Jakarta, namun clock trigger dapat berjalan sekitar ±15 menit. Setelah proses pertama selesai, tiap pagi app membaca cache yang dibuat hari itu; jika cache belum ada/terlambat, endpoint aman melakukan fallback ke perhitungan live.

---

## 7. Gating Akses

- **Client** (`applyModuleGating_` di `index.html`): sembunyikan nav item yang `otorisasiModules`-nya bukan `true` (strict equality, bukan truthy biasa). Ini **kenyamanan UI saja**, bukan lapisan keamanan.
- **Server** (`requireModuleAccess_` di tiap endpoint, termasuk `getNsManningData`): verifikasi email sesi (prioritas) atau NIK client (fallback) → cek kolom modul di sheet `KARYAWAN`. Dipanggil ulang di **setiap** request endpoint data (bukan cuma sekali saat login) — lihat §3.1 untuk daftar kolom modul termasuk `NS Manning`.
- Modul baru **tidak otomatis punya akses untuk siapa pun** — kolom permission-nya harus ditambahkan manual ke sheet `KARYAWAN` dan diisi `1` untuk NIK yang berhak. Tanpa ini, nav item tetap tersembunyi walau kode sudah ter-deploy sempurna (kejadian nyata untuk modul Manning, lihat changelog 7 Agu 2026).

---

## 8. Testing

Diuji menggunakan harness Node dan validator HTML (`node tools/harness.js` dan `node tools/check_html.js`). Fixture `tools/sheet_values.json` di-regenerasi dari `REF/EMPLOYEE DATA.xlsx` via `python tools/dump_sheet.py` (path relatif, 35 kolom A:AI). Pipeline lengkap (mirror `.gs`→`.js` + fixture + kedua test + re-index GitNexus): `powershell -File sync-graphify.ps1`. Impact analysis & verifikasi scope perubahan memakai GitNexus CLI — lihat bagian "Workflow Project" di `AGENTS.md`.

---

## 9. Standar Kode

- **Executable code WAJIB 100% ASCII**.
- Wajib `SpreadsheetApp.openById(...)`.

---

## 10. Belum Dikerjakan

- **Panel Turnover & Reason Keluar** — kolom AF (`Reason Keluar`) sudah dibaca tapi belum ada panel visual khusus.
- **Drill-down profil per orang** — klik baris tabel untuk modal detail profil karyawan.
- **Tren "per Cost Center per bulan" di panel Manning** — saat ini `trend` cuma total rencana gabungan semua Cost Center per bulan (line chart tunggal). Belum ada breakdown per-Cost-Center per-bulan (mis. multi-line, satu garis per Cost Center) walau data mentahnya (`nsBuildManningRecords_`) sudah punya kedua dimensi sekaligus.
- **Password plaintext di sheet KARYAWAN (kolom F)** — tidak bisa diperbaiki dari project ini sendirian: sheet auth dipakai bersama DAM PORTAL & EWO, mengubah isi kolom ke hash akan merusak login aplikasi lain. Perlu keputusan & migrasi lintas-aplikasi.

---

## 11. Changelog

### 28 Agu 2026 (sore) — Perbaikan hasil audit integritas (B1, C1, A1, B3, B5, C5, B2, D5)
- **B1 (kritis)**: `nsParseDate_` — string tanggal angka ber-pemisah kini di-parse manual dengan konvensi Indonesia (hari-bulan-tahun) SEBELUM fallback `new Date()`. Sebelumnya `05/06/2020` terbaca 6 Mei (format US) — tanggal lahir/masuk/akhir kontrak bertipe string dengan hari <= 12 bergeser diam-diam. Rollover senyap (mis. 31 Feb) kini ditolak via verifikasi komponen. Dilindungi 6 test baru di harness.
- **A1 (keamanan)**: endpoint data FAIL-CLOSED — fallback `client-nik` (bisa dipalsukan dari console browser) ditolak di `requireModuleAccess_`; identitas wajib dari email sesi Google. Deploy salah kini = menolak semua request, bukan membocorkan data.
- **C1 (performa)**: sheet KARYAWAN tidak lagi dibaca 2x per request — memo per-invocation + CacheService 5 menit. Konsekuensi: perubahan akses/password efektif maksimal 5 menit.
- **B3**: `tglAwalKontrak` di watchlist kini dibaca dari kolom `TANGGAL AWAL KONTRAK` yang asli (fallback `tanggalMasuk` kalau kosong).
- **B5**: kartu KPI Contract mengikuti segment switcher (dihitung dari `perBucket` payload segmen, bukan `d.kpi` yang selalu AKTIF).
- **C5**: warning NIK duplikat kini tampil di semua panel, bukan hanya Headcount.
- **B2 (digantikan 4 Sep 2026)**: Aktual Manning sekarang direkonstruksi pada akhir periode terpilih memakai Tanggal Masuk dan Tanggal Efektif Non Aktif; bukan lagi snapshot hari ini. Cache server untuk Manning juga dihapus agar dropdown periode dan Pareto selalu membaca perubahan sheet terbaru.
- **D5**: dead payload `perKeteranganKontrak` + fungsi `sortKontrak` + whitelist `cSiklus` di check_html dibuang.
- **A2 (tidak dikerjakan, dicatat di §10)**: password plaintext sheet KARYAWAN perlu keputusan lintas-aplikasi (sheet dipakai bersama DAM PORTAL & EWO).

### 4 Sep 2026 — Prepared dashboard, periode YTD, dan validasi Recruitment
- **Periode Manning:** dropdown otomatis Jan sampai bulan berjalan terhadap `NOW()`. Default selalu bulan berjalan; data aktual bulan berjalan dihitung sampai hari ini dan periode lampau sampai akhir bulan.
- **Prepared dashboard:** trigger installable sekitar 01.00 Asia/Jakarta menyiapkan payload Headcount, Contract, Recruitment, dan setiap periode Manning YTD. `_NS_DASHBOARD_CACHE` dipakai aplikasi agar tidak menghitung raw MASTER KARYAWAN saat user membuka panel; `NS HEADCOUNT MONTHLY` adalah audit trail yang terlihat.
- **UI Manning:** struktur peringatan diperbaiki (penutup DOM lengkap), tabel ditata grid responsif, dan label Cost Center kecil tidak lagi bertumpuk di Pareto.
- **Recruitment:** Retensi sumber, tren perekrutan, dan alasan keluar kini selalu memakai seluruh riwayat; filter AKTIF/NON AKTIF tidak lagi menghasilkan retensi 100% palsu atau chart alasan keluar kosong.

### 28 Agu 2026 — Git repo + GitNexus live + perbaikan tooling & harness
- **Git repo diinisialisasi** (branch `main`, baseline commit) — `detect-changes` GitNexus sekarang berfungsi. `.gitignore` mengecualikan `REF/` & `tools/sheet_values.json` (PII, audit A3), `.gitnexus/`, `graphify-out/cache/`, `node_modules/`.
- **GitNexus analyze dijalankan**: `.gitnexus/run.cjs` + skill project `.claude/skills/gitnexus/` terbuat; index 293 simbol / 564 edges / 25 flows. Perintah dengan `-r` wajib via `npx gitnexus` (bukan `run.cjs`) karena nama repo ber-spasi terpecah oleh wrapper shell — dicatat di `AGENTS.md` bagian "Workflow Project".
- **`tools/dump_sheet.py` diperbaiki**: path absolut basi (folder lama `0. EMPLOYEE NS RECORD`) → relatif ke repo; ekspor 32 → 35 kolom (A:AI) sehingga `TANGGAL EFEKTIF NON AKTIF`, `ALASAN KELUAR`, `PENDIDIKAN` ikut masuk fixture. `openpyxl` ditambahkan ke `requirements.txt` (file sekalian dikonversi UTF-16 → UTF-8).
- **Drift harness (eks-§10) teratasi**: fixture di-regenerasi dari xlsx aktual (758 record / 459 aktif / 299 non-aktif). Investigasi membuktikan 12 assertion gagal murni drift data — sheet sumber berubah (+13 record, 2 NIK duplikat sudah diperbaiki HR di sumber, banyak kontrak diperpanjang → bucket `aman >90` naik 147→276) — BUKAN regresi kode (semua cek struktural/gating/login/manning tetap PASS, agregat konsisten internal). Ekspektasi di-update dengan komentar anti-ubah-tanpa-bukti-output. Harness & check_html hijau.
- **`package.json` name** diperbarui: `0.-employee-ns-record` → `hr-dashboard`.

### 7 Agu 2026 — Modul Manning Distribution live & terverifikasi + klarifikasi arsitektur spreadsheet
- **Modul Manning Distribution resmi berfungsi di produksi.** Root cause link sidebar tidak muncul (dibahas panjang 6-7 Agu): kolom permission `NS Manning` belum ada di sheet `KARYAWAN`. Setelah kolom ditambahkan (header `NS Manning`, nilai `1` untuk NIK berhak), modul langsung tampil tanpa perlu deploy ulang apa pun (murni perubahan data, bukan kode).
- **Klarifikasi identitas 2 spreadsheet yang dipakai app ini** (sempat jadi sumber kebingungan saat debug):
  - **`HR DASHBOARD`** (ID `1qSTpi6OwUOBoORIALBCdwWehH-R0L8az4vwuaOV3shU`, `NSRECORD_SPREADSHEET_ID`) — berisi `MASTER KARYAWAN`, `MANNING DISTRIBUTION`, `CONFIG`, `TRAINING` (kosong/rusak), `Design Dashboard`, `MOM`, `STSP Karyawan`, `LIB`. Judul file ini sebelumnya berbeda, diganti jadi "HR DASHBOARD" murni untuk branding/fokus — **tidak mengubah ID maupun isi sheet apa pun**, karena GAS buka spreadsheet by ID bukan by judul.
  - **`DATA KARYAWAN`** (ID `14OTl9xYINyRIqnJ2AEaCJFD_D9tNRRueNgFby6FjY9o`, `KARYAWAN_SPREADSHEET_ID`) — file **terpisah**, berisi sheet `KARYAWAN` (auth) yang dipakai bersama app lain (DAM PORTAL, EWO, dll). Sheet ini **hanya dipakai untuk identitas + gate otorisasi** (lihat §3.1) — tidak pernah jadi sumber data yang ditampilkan di panel manapun; seluruh isi panel 100% dari spreadsheet HR DASHBOARD.
- **Dokumentasi struktur `CONFIG` sheet diperjelas** (§1.1): `A2` = Link App (dibaca kode), `A5` = Link Shell (referensi manual saja).
- **Jebakan deployment GAS didokumentasikan** (§1.1, §6): deployment/version baru = snapshot beku kode saat itu; lupa deploy ulang setelah edit = URL live tetap sajikan kode lama. Ini penyebab utama sesi debug panjang sebelum akhirnya ketahuan akar masalah sebenarnya ada di data (kolom permission), bukan di kode maupun proses deploy.

### 6 Agu 2026 — Modul Manning Distribution (rencana vs aktual)
- **Endpoint baru** `getNsManningData(nik, periodeIso)`: bandingkan headcount rencana (sheet `MANNING DISTRIBUTION`) dengan aktual (`MASTER KARYAWAN`) per Cost Center dan per Departemen, dengan dropdown pilih periode + tren rencana bulanan.
- **Kolom baru dibaca dari MASTER KARYAWAN**: `COST CENTER` (sebelumnya ada di sheet tapi tidak pernah dibaca kode) - jadi join key ke sheet `MANNING DISTRIBUTION`. Departemen per Cost Center diturunkan otomatis dari mayoritas `bagian` karyawan aktual di Cost Center itu (sheet Manning sendiri tidak punya kolom Departemen).
- **Permission baru**: kolom `NS Manning` di sheet KARYAWAN (pola sama seperti 3 modul lain - admin isi `1` untuk NIK yang boleh akses). **Kolom ini harus ditambahkan manual ke sheet KARYAWAN produksi** sebelum modul ini bisa dipakai siapa pun.
- **Prasyarat sheet**: tab `MANNING DISTRIBUTION` harus ada di spreadsheet NS Record yang sama (`NSRECORD_SPREADSHEET_ID`), dengan kolom `Type, Periode, Comp, Comp Code, Cost Center, Head count, Nama Cost Center`. Format `Periode` boleh campur `MM.YYYY` (string) atau `M(M)YYYY` (angka) - dinormalisasi otomatis oleh `nsParsePeriode_`.
- **Bug fix infrastruktur test**: `tools/harness.js` dan `tools/check_html.js` memakai path absolut hardcode ke folder lama `0. EMPLOYEE NS RECORD` (sebelum rename ke `0. HR DASHBOARD` 28 Jul 2026) - keduanya gagal total (`ENOENT`) sejak rename dan baru ketahuan saat modul ini dikerjakan. Diganti ke path relatif.
- **Temuan terpisah (belum diperbaiki)**: setelah harness bisa jalan lagi, ketahuan 5 assertion regresi headcount/contract sudah drift dari `tools/sheet_values.json` saat ini (`total` 749 vs ekspektasi lama 745, `aman >90 hari` 151 vs 147, dll - beda konsisten ~4 baris). Kemungkinan `sheet_values.json` di-refresh setelah angka ekspektasi ditulis. Perlu investigasi terpisah, bukan bagian dari perubahan Manning ini.

### 28 Jul 2026 — Branding HR DASHBOARD & Multi-Level Interactive Analytics
- **Branding Renaming**: Mengubah seluruh identitas aplikasi dari `NS RECORD` menjadi **`HR DASHBOARD`** (`index.html`, `<title>`, logo sidebar, dan `ShellWebApp.gs` `.setTitle('HR DASHBOARD')`).
- **Fixed Navigation Sidebar**: Menetapkan `position: fixed` pada sidebar agar tidak tergulung saat scroll tabel.
- **Soft Pastel Amber Percentage Pill**: Memperbarui datalabel persentase grafik dengan pill frosted pastel amber (`rgba(254, 243, 199, 0.95)` / `#92400e`) untuk keterbacaan yang lembut dan elegan.
- **1-to-1 Dual Y-Axis Pareto Scaling**: Menyesuaikan kalkulasi `leftMax` dan `rightMax` agar titik persentase berada sejajar di atas batang diagram tanpa menabrak label.
- **Multi-Level Drill-Down & Mother-Daughter Filters**:
  - Klik diagram Masa Kerja (`cTahunKontrak`) memunculkan breakdown `Distribusi Departemen / Section` & `Distribusi Jabatan / Posisi` dan menyaring tabel Watchlist.
  - Klik diagram Section (`cTahunSection`) menyaring diagram Jabatan dan tabel Watchlist khusus untuk section tersebut.
  - Klik diagram Jabatan (`cTahunJabatan`) menyaring tabel Watchlist khusus untuk jabatan yang dipilih.
  - Menambahkan chip indikator filter komposit dengan aksi reset per-level & reset total.
- **Interactive Column Header Table Sorting**: Seluruh 11 header kolom pada tabel Watchlist mendukung sorting **Small to Big / Big to Small** dengan indikator panah `▲`/`▼`.
- **Backend Payload**: Menambahkan `buildContractTenureBreakdown_` dan payload `tenureBreakdown` pada `ns record.gs`.

### 16 Jul 2026 — Rilis awal
- Web App mandiri NS RECORD dengan 3 modul (Headcount, Contract, Recruitment).
