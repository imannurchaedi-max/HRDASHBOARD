# ACTIVE-v2 — HR DASHBOARD (Non Staff Record) eks-portal

Hasil **extract balik** modul HR dari DAM PORTAL (`0. DT SUMMARY`) ke bentuk
aplikasi standalone. Dibuat 12 Nov 2026, **direvisi setelah code review
independen** (temuan HIGH/MEDIUM ditutup, sisa risiko didokumentasikan).

Folder `ACTIVE/` **tidak disentuh sama sekali**. Ini salinan paralel.

> **STATUS: KODE KERJA AKTIF (DECISION-002, 12 Nov 2026).**
> Development modul HR dilanjutkan **di folder ini**; DT SUMMARY diparkir.
> `ACTIVE/` (Sep 2026) = arsip beku. Deploy **belum** dilakukan dan menunggu
> keputusan model akses data (lihat Bagian 4.1 dan `DECISION-002.md`).
> Alasan historis pemilihan arsitektur: `DECISION-001.md` (sudah digantikan).

---

## 1. Isi folder

| File | Asal | Status |
|---|---|---|
| `ns domain.gs` | `0. DT SUMMARY/active trial/trial_hr_domain.gs` | salinan + **4 patch keamanan** (sudah permanen; portal diparkir) |
| `TrialFrontendHr.html` | `0. DT SUMMARY/active trial/TrialFrontendHr.html` | **VERBATIM** — self-contained (CSS + controller di dalam) |
| `ns record.gs` | tulis baru | Jembatan: auth SSO, cache, gerbang admin, `doGet`, `includeHtml_`, RPC sesi |
| `index.html` | tulis baru | Shell standalone: sidebar 4 modul, tema portal, loader + watchdog, bootstrap sesi |
| `appsscript.json` | tulis baru | Manifest, `executeAs: USER_ACCESSING` |

Paritas fitur diperoleh dengan **menyalin apa adanya**. Yang ditulis baru hanya
lapisan yang di portal disediakan oleh `WebApp.gs`, `dt qdash.gs`,
`trial_auth_domain.gs`, dan `TrialFrontendCore.html`.

### Patch pada `ns domain.gs` (satu-satunya deviasi dari portal)

| # | Fungsi | Patch |
|---|---|---|
| P1 | `nsRecordSelfTest` | + gerbang `nsAssertAdmin_` |
| P2 | `nsInstallDailyDashboardRefresh` | gerbang lama (`activeEmail === effectiveEmail`) **tidak membatasi siapa pun** di mode USER_ACCESSING → diganti `nsAssertAdmin_` |
| P3 | `nsInspectSpreadsheetLive` | + gerbang `nsAssertAdmin_` |
| P4 | `nsInspectSpreadsheetLive` | pakai `getHrSpreadsheetId_()` (menghormati Script Property), bukan ID hardcoded |

4 patch ini sekarang **permanen**. Portal diparkir (DECISION-002), jadi tidak ada
lagi penyalinan ulang rutin. Cek cepat: `grep -c "PATCH P[0-9]" "ns domain.gs"` → harus 3.

---

## 2. Yang berbeda dari `ACTIVE/` (versi Sep 2026)

| Aspek | `ACTIVE/` | `ACTIVE-v2/` |
|---|---|---|
| Autentikasi | Login NIK/password + SSO | **SSO saja** (email Google); password & form login dihapus |
| Identitas dari client | Ditolak untuk endpoint data | **Diabaikan total** — `requesterNik` tidak dipakai |
| Shell | `ShellWebApp.gs` (redirect `CONFIG!A2`) | `doGet` langsung; **tanpa** `CONFIG!A2` |
| Loader | Tidak ada | Overlay + `beginLoad_`/`endLoad_`/`guardLoadHandler_` + **watchdog 60 dtk** |
| Fitur HR | Baseline Sep 2026 | **Parity Nov 2026**: supervisory action board, manning shortage & shift readiness command center, koreksi angka |
| Gerbang admin | Hanya email pemilik | **Allowlist eksplisit** `NS_ADMIN_NIKS` / `NS_ADMIN_EMAILS`, fail-closed |

---

## 3. Deploy (belum dilakukan — menunggu keputusan model akses data)

1. Buat project Apps Script baru.
2. Buat 5 file dengan nama persis: `ns record.gs`, `ns domain.gs`, `index.html`,
   `TrialFrontendHr.html`, `appsscript.json` (Project Settings → tampilkan manifest).
3. Tempel isi masing-masing file.
4. `appsscript.json`: `executeAs` = `USER_ACCESSING`, `access` = `DOMAIN`.
5. Deploy → **New deployment** → Web app → Execute as **User accessing the web app**
   → Who has access **Anyone within <domain>**.
6. Atur Script Properties (bagian berikut), lalu buka URL `/exec`.

### Script Properties

| Property | Wajib? | Isi |
|---|---|---|
| `NS_ADMIN_NIKS` | **ya** (untuk fungsi admin) | NIK admin, dipisah koma, mis. `12345,67890` |
| `NS_ADMIN_EMAILS` | alternatif | email admin, dipisah koma |
| `NS_DASHBOARD_REFRESH_NIK` | ya bila pakai scheduler | NIK akun yang menjalankan refresh harian |
| `NSRECORD_SPREADSHEET_ID` | opsional | override ID spreadsheet HR |
| `KARYAWAN_SPREADSHEET_ID` | opsional | override ID spreadsheet autentikasi |

Bila `NS_ADMIN_NIKS`/`NS_ADMIN_EMAILS` kosong, **semua fungsi admin menolak**
(fail closed). Itu disengaja.

---

## 4. ⚠️ Keamanan — baca sebelum deploy

### 4.1 Izin modul bersifat tingkat-API, BUKAN isolasi data

Dengan `executeAs: USER_ACCESSING`, script berjalan dengan otoritas pengunjung.
Karena itu pengguna **harus** punya akses baca ke dua spreadsheet:

- `HR DASHBOARD` (`1qSTpi6…`)
- spreadsheet autentikasi `KARYAWAN` (`14OTl9xY…`)

**Konsekuensi yang tidak bisa diakali dengan kode:** siapa pun yang bisa membuka
spreadsheet tersebut **bisa membaca seluruh isinya langsung**, tanpa melewati
`requireModuleAccess_`. Contoh: user dengan izin hanya `NS Headcount` tetap bisa
membuka spreadsheet dan melihat data kontrak/PII semua karyawan.

Pilihan yang tersedia:

| Opsi | Konsekuensi |
|---|---|
| **A. Bagikan lewat grup domain** yang anggotanya memang berhak melihat **semua** data HR | Paling praktis; isolasi data tetap tidak ada |
| **B. Jangan pakai standalone; pakai portal** (`0. DT SUMMARY`, `USER_DEPLOYING`) | Otoritas server, spreadsheet tidak perlu dibagikan ke user — isolasi data nyata |
| **C. Kembalikan login NIK/password** dari `ACTIVE/ns record.gs` | Identitas tanpa share spreadsheet, tapi kembali ke password plaintext |

Catatan: opsi B (produksi di portal) sempat dipilih lewat `DECISION-001`, tetapi
**dibatalkan** oleh `DECISION-002` — DT SUMMARY diparkir dan development lanjut
di folder ini. Jadi pilihan A/C/D kembali terbuka dan **harus ditetapkan sebelum
go-live**; lihat `DECISION-002.md` bagian "Yang harus diselesaikan sebelum deploy".

### 4.2 Password di sheet KARYAWAN

v2 **tidak memakai** kolom `Password` (SSO saja). Bila kolom itu masih berisi
kredensial, isinya ikut terbaca oleh siapa pun yang punya akses spreadsheet
(poin 4.1). Tindakan yang disarankan: kosongkan/pindahkan kolom tersebut.

### 4.3 Gerbang admin

`nsInstallDailyDashboardRefresh`, `nsRecordSelfTest`, `nsInspectSpreadsheetLive`
(patch P1–P4), `nsSelfCheck`, dan `nsClearAuthCache` **menolak** akun yang tidak
ada di `NS_ADMIN_NIKS`/`NS_ADMIN_EMAILS`, dan menolak semua bila daftar kosong.

### 4.4 Jalur scheduler

Trigger harian berjalan **tanpa user aktif**. Jalur ini diberi pengecualian
sempit di `requireModuleAccess_`: hanya menerima NIK yang persis sama dengan
`NS_DASHBOARD_REFRESH_NIK`. Request browser selalu punya email sesi, sehingga
tidak bisa memakai jalur ini. Akun scheduler **harus** terdaftar di sheet
`KARYAWAN` dan punya keempat izin modul.

### 4.5 Cache izin (SLA pencabutan akses)

Izin dibaca dari cache selama **120 detik**. Mencabut izin di sheet baru efektif
setelah cache kedaluwarsa (atau setelah admin menjalankan `nsClearAuthCache`).
Naikkan/turunkan `NS_AUTH_CACHE_TTL_SECONDS` di `ns record.gs` sesuai SLA.
Cache juga menandai generasi + memverifikasi panjang hasil rakit, sehingga
potongan lintas generasi tidak bisa tercampur menjadi data izin palsu.

---

## 5. Verifikasi setelah deploy

Jalankan dari editor GAS (bukan dari browser):

| Fungsi | Gerbang | Kegunaan |
|---|---|---|
| `nsSelfCheck` | admin | Sesi, `activeEmail` vs `effectiveEmail`, NIK, izin 4 modul, daftar sheet HR, revisi patch |
| `nsClearAuthCache` | admin | Bersihkan cache izin setelah mengubah hak akses |
| `nsRecordSelfTest` | admin | Self-test domain HR (jumlah record, kolom hilang, NIK duplikat) |
| `nsInspectSpreadsheetLive` | admin | Struktur sheet HR (nama, baris, kolom, header) |
| `nsInstallDailyDashboardRefresh` | admin | Pasang trigger refresh harian ~01:00 |

Uji manual di browser: buka tiap modul, pastikan tidak ada toast error dan angka
KPI muncul (bukan 0 semua). Coba juga akun kedua tanpa admin untuk memastikan
fungsi admin benar-benar ditolak.

---

## 6. Hasil verifikasi

Dijalankan sebelum serah terima:

| Uji | Perintah | Hasil |
|---|---|---|
| Syntax `.gs` | `node --check` (via temp `.js`) | PASS keduanya |
| Syntax `<script>` inline | ekstrak + `node --check` | PASS 3 blok |
| Tabrakan deklarasi top-level | 30 vs 9 deklarasi | **0 tabrakan** |
| Paritas RPC frontend↔backend | 4 handler | **4/4 cocok** |
| Kontrak DOM id & CSS var | 4 root + 4 nav + 4 tab + 9 token | lengkap |
| **Uji runtime mock GAS** | `node tools/verify-v2.cjs` | **47 pass / 0 fail** |
| Tes lama `ACTIVE/` | `tools/harness.js` + `tools/check_html.js` | tetap hijau |

`tools/verify-v2.cjs` mencakup:
sesi SSO (terdaftar / tidak / tanpa user aktif), gerbang izin per modul,
**anti-spoofing NIK client**, 4 endpoint mengembalikan payload sah,
`doGet`/`includeHtml_`, **gerbang admin** (fail-closed, installer tanpa efek
samping bagi non-admin), **jalur scheduler** tanpa user aktif, **pembedaan
"gagal baca spreadsheet" vs "email tidak terdaftar"**, dan **integritas cache**
(generasi, chunk rusak → miss, namespace per spreadsheet, pemecah byte Unicode).

Belum diuji: **render di browser sungguhan** (chart/tabel/filter), deployment GAS
live, serta perilaku `getActiveUser()` di domain Anda (wajib dicek empiris —
lihat `nsSelfCheck`, bandingkan `activeEmail` vs `effectiveEmail`).

---

## 7. Integritas `ACTIVE/` (tidak disentuh)

Baseline md5 pada 12 Nov 2026, sebelum `ACTIVE-v2/` dibuat:

```
42ce847a96b2e8268d337675cca0afff  ACTIVE/ns record.gs
538203e7d8fe73ddca8151d411f5c6f6  ACTIVE/ShellWebApp.gs
221bf3a1d8c95232a97d8fc6a2bd2dbb  ACTIVE/index.html
```

---

## 8. Batasan & regresi yang diketahui

**Regresi dibanding `ACTIVE/`** (bukan bug baru — fitur lama tidak terbawa):

1. **Peringatan kualitas data hilang.** v2 tidak menampilkan
   `warnings.missingColumns`, `warnings.duplicateNiks`, maupun `preparedAt`
   (waktu snapshot persiapan). Akibatnya agregat yang tidak lengkap karena header
   rusak bisa terlihat normal. Portal punya keterbatasan yang sama.
   → Mitigasi sementara: jalankan `nsRecordSelfTest` (admin) untuk melihat
   kolom hilang dan NIK duplikat.
2. **Pencarian mengganti input saat mengetik.** `oninput` merender ulang seluruh
   root via `innerHTML`, sehingga fokus/kursor hilang tiap karakter. Sama seperti
   portal. → Ketik lalu tunggu, atau perbaiki di fragment (menyimpang dari paritas).
3. **Deep link tab awal tidak ada.** Shell selalu membuka modul pertama yang
   diizinkan; `ACTIVE/` bisa membuka tab dari query/hash.
4. **Analisis komposisi tipe tenaga kerja (DL/IDL/STAFF) di Manning** diganti
   tren & readiness per Cost Center; drilldown Contract (masa kerja → section →
   jabatan) tidak ada.

**Batasan teknis:**

- Cache payload HR memakai snapshot hari berjalan; setelah trigger harian,
  perubahan sumber belum tentu langsung terlihat di UI.
- `sync-graphify.ps1`, `tools/harness.js`, `tools/check_html.js` masih mengarah
  ke `ACTIVE/`; `ACTIVE-v2/` belum dimirror/diindeks.
- Repo ini **punya remote GitHub** (`imannurchaedi-max/HRDASHBOARD`). Salinan lokal sempat kehilangan `.git` dan sudah disambungkan ulang 12 Nov 2026 (commit `5fbd562`). Commit tiap perubahan; `REF/` & `tools/sheet_values.json` di-ignore karena PII.
- Nama file `ns domain.gs` memakai spasi; aman untuk upload manual, ganti jadi
  `ns_domain.gs` bila kelak memakai `clasp`.

## 9. Porting balik ke DT SUMMARY

Bila kelak portal dihidupkan lagi, prosedur lengkapnya ada di
[`PORTING-BALIK.md`](PORTING-BALIK.md): pemetaan berkas, langkah `cp`, dependensi
yang harus diporting dulu (`nsAssertAdmin_`, `getHrSpreadsheetId_`), perbedaan
model auth portal, gerbang `npm test`/`detect:changes`, dan jebakan yang sudah
diketahui. Arahnya satu arah: dari sini ke portal, bukan sebaliknya.
