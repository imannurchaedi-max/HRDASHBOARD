# DECISION-001 — Modul HR: produksi di portal, standalone tidak dipakai

**Tanggal:** 12 November 2026
**Status:** ~~Diterima~~ **DIGANTIKAN oleh `DECISION-002.md` (12 Nov 2026)** — DT SUMMARY diparkir, development lanjut di `ACTIVE-v2/`. Dokumen ini disimpan sebagai riwayat alasan.
**Konteks:** hasil extract balik modul HR dari portal ke standalone (`ACTIVE-v2/`)

---

## Konteks

Modul HR (Non Staff Record) sudah dimigrasikan ke DAM PORTAL
(`0. DT SUMMARY`) sejak v182 (2 Okt 2026) dan kini berjalan di sana dengan
parity terbaru. Sebagai upaya menyediakan versi mandiri, modul itu di-extract
balik ke `0. HR DASHBAORD/ACTIVE-v2/` dengan autentikasi SSO saja.

Code review independen menemukan satu keterbatasan yang **tidak bisa ditutup
oleh kode**: dengan `executeAs: USER_ACCESSING`, web app berjalan memakai
otoritas pengunjung. Akibatnya pengguna **wajib** punya akses baca ke
spreadsheet `HR DASHBOARD` dan spreadsheet autentikasi `KARYAWAN`. Siapa pun yang
bisa membuka spreadsheet itu dapat membaca seluruh isinya langsung, melewati
gerbang modul di aplikasi. Gerbang 4 modul karena itu hanya berlaku di
tingkat API, bukan sebagai isolasi data.

## Keputusan

**Opsi B.** Produksi modul HR tetap di **DAM PORTAL** (`0. DT SUMMARY`) yang
berjalan dengan `executeAs: USER_DEPLOYING` — spreadsheets dibaca oleh otoritas
server, sehingga pengguna tidak perlu dan tidak boleh diberi akses ke file
sumber.

`0. HR DASHBAORD/ACTIVE-v2/` **tidak di-deploy** dan **tidak** menjadi jalur
produksi. Statusnya: **referensi + sandbox pengujian**.

`0. HR DASHBAORD/ACTIVE/` (versi Sep 2026) juga **bukan** jalur produksi dan
tidak perlu dideploy ulang.

## Konsekuensi

1. **Sumber kebenaran modul HR = portal.** Berkas produksi:
   `0. DT SUMMARY/active trial/trial_hr_domain.gs` dan
   `active trial/TrialFrontendHr.html`. Perubahan fitur HR dilakukan di sana.
2. **`ACTIVE-v2/` disimpan** sebagai:
   - pembanding paritas (bisa di-diff terhadap portal kapan pun),
   - harness regresi lokal (`tools/verify-v2.cjs`, 47 cek) yang berjalan tanpa
     GAS — berguna untuk menguji logika domain tanpa menyentuh produksi.
3. **Jangan menambahkan data produksi/PII** ke `ACTIVE-v2/`.
4. User **tidak** diberikan akses langsung ke dua spreadsheet tersebut. Akses
   hanya lewat portal.
5. Temuan keamanan review yang relevan untuk produksi **berpindah ke portal**
   dan perlu ditindaklanjuti di sana (lihat bagian berikut).

## Tindak lanjut di portal (belum dikerjakan)

Temuan yang sama berpotensi ada di portal, karena fungsinya ikut diekspor
sebagai RPC publik:

| Fungsi (portal) | Masalah | Tindakan |
|---|---|---|
| `nsInstallDailyDashboardRefresh` | publik via `google.script.run`; gerbangnya `activeEmail === effectiveEmail` yang perilakunya bergantung mode eksekusi dan harus diuji empiris | beri allowlist admin eksplisit, atau jadikan privat (akhiran `_`) agar hanya dari editor |
| `nsRecordSelfTest` | publik, tanpa gerbang | idem |
| `nsInspectSpreadsheetLive` | publik, tanpa gerbang, ID spreadsheet hardcoded | idem + pakai resolver konfigurasi |
| `getSessionUserInfo` (bila ada padanan portal) | pastikan tidak mengirim PII berlebih | audit payload |

Catatan: portal **sudah** memakai `USER_DEPLOYING`, sehingga risiko "user harus
punya akses spreadsheet" **tidak** berlaku di sana — selama benar-benar tidak
ada share ke pengguna. Verifikasi: cek daftar sharing kedua spreadsheet.

## Pemicu untuk meninjau ulang keputusan ini

- Kebutuhan menjalankan dashboard HR di luar domain/portal (mis. akses vendor,
  lingkungan tanpa portal).
- Portal tidak lagi dirawat.
- Muncul kebutuhan isolasi data per-modul yang lebih ketat daripada portal
  sekarang — itu justru alasan memperkuat portal, bukan menghidupkan standalone.

Jika salah satu terjadi, buka lagi `ACTIVE-v2/README-DEPLOY.md` bagian 4 dan
pilih ulang di antara opsi A/B/C.
