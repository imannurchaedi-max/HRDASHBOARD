# DECISION-002 — DT SUMMARY diparkir; development lanjut di HR DASHBOARD

**Tanggal:** 12 November 2026
**Status:** Diterima — **menggantikan DECISION-001**
**Pemicu:** pemilik project memutuskan menghentikan pengembangan di DT SUMMARY per hari ini dan melanjutkan development modul HR di `0. HR DASHBAORD`.

---

## Keputusan

1. **DT SUMMARY diparkir** per 12 Nov 2026. Tidak ada pengembangan baru di sana.
2. **Development modul HR dilanjutkan di `0. HR DASHBAORD`**, memakai kode di
   `ACTIVE-v2/` sebagai basis. `ACTIVE-v2/` menjadi **kode kerja aktif**,
   bukan lagi sekadar referensi.
3. `ACTIVE/` (Sep 2026) tetap **arsip beku** — jangan dikembangkan, jangan
   dideploy.
4. Arah sinkronisasi **dibalik**: dulu portal → standalone. Mulai sekarang
   **HR DASHBOARD adalah sumber kebenaran** untuk modul HR. Bila kelak portal
   dihidupkan lagi, perubahan diporting **dari** HR DASHBOARD **ke** portal.

## Konsekuensi

| Hal | Sebelum (DECISION-001) | Sesudah (DECISION-002) |
|---|---|---|
| Sumber kebenaran HR | portal `0. DT SUMMARY` | **`0. HR DASHBOARD/ACTIVE-v2/`** |
| Status `ACTIVE-v2/` | referensi + sandbox | **kode kerja aktif** |
| Status portal | produksi | **diparkir** |
| 4 patch keamanan di `ns domain.gs` | deviasi sementara, diterapkan ulang tiap salin | **permanen** — bagian dari kode |
| Menyalin ulang `ns domain.gs` dari portal | rutin setelah update portal | **tidak lagi** (portal beku) |

## Yang harus diselesaikan sebelum deploy

Deploy `ACTIVE-v2/` **belum dilakukan** dan **belum bisa** diputuskan tanpa
menutup satu hal: model akses data.

`ACTIVE-v2/` memakai `executeAs: USER_ACCESSING` agar identitas per-pengguna
terbaca. Konsekuensinya pengguna harus punya akses baca ke spreadsheet
`HR DASHBOARD` dan `KARYAWAN`, sehingga gerbang 4 modul hanya berlaku di
tingkat API — bukan isolasi data. Pilihan:

| Opsi | Dampak | Catatan |
|---|---|---|
| **A. Bagikan via grup domain** | paling praktis; isolasi data tidak ada | hanya boleh bila semua pengguna dashboard memang berhak melihat seluruh data HR |
| **C. Hidupkan lagi login NIK/password** | identitas tanpa share spreadsheet; kembali ke password plaintext | kode login masih ada di `ACTIVE/ns record.gs` sebagai bahan |
| **D. Tunda deploy** | aman; development jalan terus di lokal | butuh keputusan ini nanti, sebelum go-live |

Keputusan ini **tidak menghambat coding** — hanya menghambat go-live.

## Aturan kerja baru

1. Perubahan fitur HR **dilakukan di `ACTIVE-v2/`**, bukan di portal.
2. Jangan menyentuh `0. DT SUMMARY` untuk pekerjaan HR. Kalau butuh acuan
   historis (mis. cara portal menyelesaikan sesuatu), baca saja tanpa mengubah.
3. Gerbang wajib sebelum commit: `node tools/verify-v2.cjs` hijau (47 cek).
4. Jangan menaruh data produksi/PII di repo.
5. Repo punya remote GitHub (`imannurchaedi-max/HRDASHBOARD`). Salinan lokal sempat
   kehilangan `.git`; sudah disambungkan ulang 12 Nov 2026 ke commit `5fbd562`.
   Sejak itu: `git pull` sebelum mulai, commit tiap perubahan, jangan commit PII.
6. Bila portal dihidupkan lagi: porting balik **dari sini ke portal**, dan
   pertahankan 4 patch keamanan di kedua sisi.

## Risiko yang diterima

- Portal yang diparkir akan **menua**: perbaikan dependency, perubahan Google
  Apps Script, dan data source bisa menyimpang dari kode HR DASHBOARD.
- Modul HR di portal tetap **berjalan** (bila masih di-deploy) dengan kode
  versi 8 Nov 2026 — tidak lagi menerima perbaikan. Bila masih dipakai user,
  pertimbangkan membekukannya secara eksplisit (nonaktifkan deployment) agar
  tidak ada dua versi yang hidup.
- Regression harness `tools/harness.js` dan `check_html.js` masih menguji
  `ACTIVE/` (arsip), bukan kode aktif. Yang menguji kode aktif hanya
  `tools/verify-v2.cjs`. Perlu diperluas bila fitur bertambah.
