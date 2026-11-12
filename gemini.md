<!-- TOOLS-GUIDANCE: pembagian tugas tools AI di monorepo ini -->
## Panduan Penggunaan Tools AI (WAJIB dibaca sebelum bekerja)

Gunakan tools yang TEPAT untuk tiap langkah - pakai yang paling ringan yang cukup; jangan kerjakan manual apa yang bisa dikerjakan tool.

1. **Context7 (dokumentasi terkini)** - SEBELUM menulis kode yang memakai library/framework/API eksternal. Ambil docs versi-spesifik: MCP `resolve-library-id` -> `query-docs`, atau CLI `ctx7 library` -> `ctx7 docs`. Mencegah halusinasi API.

2. **GitNexus (peta codebase & blast radius)** - SEBELUM mengedit kode yang SUDAH ada: impact analysis (upstream) untuk tahu siapa yang memanggil & apa yang rusak. SETELAH edit: `detect-changes` sebelum commit. Jangan edit buta.

3. **Superpowers (disiplin proses)** - untuk SEMUA task pembangunan: spec -> plan -> TDD red/green -> subagent-driven development -> review (YAGNI & DRY).

4. **Anthropic Skills (keahlian task spesifik)** - untuk task khusus: dokumen `docx`/`pdf`/`pptx`/`xlsx`, `webapp-testing`, `frontend-design`, `mcp-builder`, dll. Sebut nama skill (mis. "Use the PDF skill to ...").

5. **LangGraph (orkestrasi workflow)** - untuk workflow multi-langkah/agent, rangkai sebagai graph.

6. **Graphify (anatomi kode/AST)** - untuk analisis struktur & data/control dependence mendalam.

Ketersediaan: Context7 = semua agent; Superpowers = Claude Code & Codex; Anthropic Skills = Claude Code.

Prinsip: **pintar** (fakta/docs, bukan tebak) -> **teliti** (TDD + impact analysis) -> **hemat** (load on-demand, plan-first, manfaatkan index).

## Konteks project (diperbarui 12 Nov 2026)

- **`ACTIVE/`** = aplikasi standalone lama (3 file: `ShellWebApp.gs`, `ns record.gs`, `index.html`). Deploy: paste 3 file, lalu URL `/exec` dimasukkan ke `CONFIG!A2`.
- **DECISION-002 (12 Nov 2026): `ACTIVE-v2/` adalah KODE KERJA AKTIF.** Development modul HR lanjut **di sini**; **DT SUMMARY diparkir** - jangan mengembangkan modul HR di sana. `ACTIVE/` (Sep 2026) = arsip beku. Deploy `ACTIVE-v2/` **belum** dilakukan; menunggu keputusan model akses data (`ACTIVE-v2/DECISION-002.md`).
- **`ACTIVE-v2/`** = modul HR hasil **extract balik** dari portal (paritas rilis 8 Nov 2026, terverifikasi: frontend md5 identik, 68 fungsi backend sama). Sejak DECISION-002 **boleh dikembangkan langsung** - tidak ada lagi salinan ulang dari portal. `ns domain.gs` memuat **4 patch keamanan permanen** (didaftar di header file; cek `grep -c "PATCH P[0-9]" "ns domain.gs"` -> 3) yang tidak boleh hilang.
- **Auth `ACTIVE-v2/`**: SSO saja (login NIK/password dihapus), manifest `executeAs: USER_ACCESSING`. `Session.getActiveUser()` = user yang mengakses, bisa KOSONG bila tidak ada user aktif (mis. trigger); `getEffectiveUser()` = akun yang otoritasnya dipakai. Klaim "USER_DEPLOYING membuat semua pengunjung terbaca sebagai pemilik" TIDAK benar sebagai aturan umum. Konsekuensi USER_ACCESSING: user butuh akses baca ke 2 spreadsheet, jadi gerbang modul bersifat **tingkat-API, bukan isolasi data**. Baca `ACTIVE-v2/README-DEPLOY.md` bagian 4 sebelum deploy.
- **Fungsi admin `ACTIVE-v2/` fail-closed**: butuh Script Property `NS_ADMIN_NIKS`/`NS_ADMIN_EMAILS`. Scheduler harian hanya menerima NIK di `NS_DASHBOARD_REFRESH_NIK`.
- **Uji sebelum deploy**: `node tools/verify-v2.cjs` untuk `ACTIVE-v2/` (wajib hijau; ini satu-satunya uji yang meng-cover v2). Untuk `ACTIVE/`: `node tools/harness.js` + `node tools/check_html.js`.
- `sync-graphify.ps1`, `tools/harness.js`, dan `tools/check_html.js` HANYA mencakup `ACTIVE/` - indeks GitNexus/Graphify belum memuat `ACTIVE-v2/`.
- Repo **punya remote GitHub**: `https://github.com/imannurchaedi-max/HRDASHBOARD` (branch `main`). Salinan lokal sempat kehilangan `.git` (sync) dan sudah disambungkan ulang 12 Nov 2026 ke commit `5fbd562`. `git pull` sebelum mulai, commit tiap perubahan; `REF/` dan `tools/sheet_values.json` di-ignore karena PII.
- Detail deploy + risiko: `ACTIVE-v2/README-DEPLOY.md`.

# GEMINI.md

<!-- SHARED AI TOOLS: monorepo root -->
## Shared AI Tools (Context7, Superpowers & Anthropic Skills)
- **Context7** - dokumentasi kode real-time (MCP: `resolve-library-id` + `query-docs`; CLI: `ctx7 library`/`ctx7 docs`). Guide: `CONTEXT7_GUIDE.md` (root).
- **Superpowers** - framework skill agent (spec -> plan -> TDD red/green -> subagent -> review).
- **Anthropic Skills** - skill resmi Anthropic (dokumen: `docx`/`pdf`/`pptx`/`xlsx`; contoh: `mcp-builder`, `webapp-testing`, `frontend-design`). Terpasang di Claude Code.
- Monorepo context: `AGENTS.md` + `AI_INSTRUCTIONS.md` (root).
