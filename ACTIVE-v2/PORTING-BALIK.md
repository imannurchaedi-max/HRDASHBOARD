# Porting Balik ke DT SUMMARY (bila dibutuhkan)

**Status:** belum pernah dilakukan. Arah kerja sekarang **satu arah**:
`0. HR DASHBAORD/ACTIVE-v2/` → portal. Portal diparkir sejak 8 Nov 2026.

Dokumen ini hanya prosedur cadangan. Jangan dijalankan tanpa alasan.

---

## Kapan porting balik masuk akal

- Portal dihidupkan lagi dan dipakai pengguna.
- Ada fitur baru di HR DASHBOARD yang dibutuhkan di portal.
- Portal perlu menutup celah keamanan yang di sini sudah diperbaiki (patch P1–P4).

**Bukan** untuk sebaliknya: jangan menyalin dari portal ke sini — portal beku di
kode 8 Nov 2026 dan paritasnya sudah dilepas sejak DECISION-002.

---

## Pemetaan arah balik

| Di sini (`ACTIVE-v2/`) | Tujuan (`0. DT SUMMARY/active trial/`) | Cara |
|---|---|---|
| `TrialFrontendHr.html` | `TrialFrontendHr.html` | salin utuh (strukturnya memang milik portal) |
| `ns domain.gs` | `trial_hr_domain.gs` | salin utuh **termasuk blok patch P1–P4** |
| `ns record.gs` | **tidak disalin utuh** | portal punya auth sendiri (`WebApp.gs`). Yang perlu diporting hanya `nsAssertAdmin_`, `nsIsAdminProfile_`, daftar admin `NS_ADMIN_NIKS`/`NS_ADMIN_EMAILS`, dan (opsional) perbaikan cache |
| `index.html` (shell) | **tidak disalin** | portal punya shell sendiri; cukup pastikan nav `#nav-hr-*`, `#tabHr*`, dan `TrialHrController.loadTab` masih terpasang |
| `appsscript.json` | **tidak disalin** | manifest portal berbeda (`USER_DEPLOYING`) |
| `tools/verify-v2.cjs` | **tidak disalin** | portal punya `npm test` sendiri |

---

## Langkah

```bash
cd "/home/iman/SynologyDrive/0. DT SUMMARY"
git pull
git checkout -b feat/hr-<nama-perubahan>

# 1. frontend (aman, strukturnya sama)
cp "../0. HR DASHBAORD/ACTIVE-v2/TrialFrontendHr.html" "active trial/TrialFrontendHr.html"

# 2. backend domain (bawa patch keamanan)
cp "../0. HR DASHBAORD/ACTIVE-v2/ns domain.gs" "active trial/trial_hr_domain.gs"
```

3. **Cek dependensi yang hanya ada di HR DASHBOARD** sebelum `clasp push`:
   - `ns domain.gs` memanggil `nsAssertAdmin_()` dan `getHrSpreadsheetId_()`.
     Di portal keduanya **belum ada** → porting ke `WebApp.gs`
     (atau `trial_auth_domain.gs`) lalu pastikan namanya sama.
   - Portal memakai `USER_DEPLOYING`, sehingga `Session.getActiveUser()` bisa
     kosong. Tentukan dulu identitas admin di portal: pemilik deploy
     (`getEffectiveUser()`) atau daftar email di Script Property.
   - Portal tidak memakai `getHrSpreadsheetId_()`; ganti dengan pola konfigurasi
     portal yang sudah ada (`NSRECORD_SPREADSHEET_ID` dibaca langsung).

4. **Perbedaan model auth — jangan ikut dibawa:**
   portal punya `resolveRequestUserProfile_()` dengan fallback `client-nik`.
   Versi di sini mengabaikan NIK dari client. Jangan mengganti auth portal hanya
   karena porting ini; modul lain bergantung padanya.

5. Gerbang wajib di portal:

```bash
npm test                 # harus hijau
npm run check:frontend
npm run detect:changes
```

6. Deploy + dokumentasi:

```bash
npx clasp push           # rootDir = "active trial"
```

   Lalu catat di `documentation/LOG_IMPROVEMENTS.md` (versi baru), dan
   perbarui `ARSITEKTUR.md` / `MAPPING.md` bila perilaku/berkas berubah.

---

## Jebakan yang sudah diketahui

- `0. DT SUMMARY/active/` adalah **arsip** — jangan diedit.
- Jangan membawa `ns record.gs`, `index.html`, atau `appsscript.json` dari sini
  ke portal; itu lapisan milik aplikasi standalone.
- Patch P1–P4 di portal **belum tentu cocok** begitu saja: gerbang
  `nsInstallDailyDashboardRefresh` di portal masih membandingkan
  `activeEmail === effectiveEmail`. Setelah porting, uji ulang siapa yang bisa
  memanggilnya di deployment nyata.
- Cache izin di sini 120 detik (`NS_AUTH_CACHE_TTL_SECONDS`). Kalau portal masih
  memakai 600 detik, samakan atau dokumentasikan bedanya.
- Setelah porting, **jangan** salin hasilnya kembali ke sini. Tetapkan satu
  sumber kebenaran: `ACTIVE-v2/` (lihat `DECISION-002.md`).
