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

<!-- monorepo-global-setup -->
## Monorepo Global Setup — WAJIB

Folder ini bagian dari **monorepo**. GitNexus, Graphify, LangGraph, dan Python venv adalah **setup global di root workspace** — BUKAN di folder ini.

- Shared module: `shared_core/core_setup.py` → `init_gitnexus()`, `init_graphify()`, `init_langgraph()`, `init_all()`
- Python venv tunggal: `<root>/venv`
- Dependency tunggal: `<root>/requirements.txt`
- GitNexus CLI global: `<root>/node_modules/gitnexus/dist/cli/index.js` (install sekali: `npm install gitnexus` di root)

**DILARANG** membuat venv/requirements/setup GitNexus/Graphify/LangGraph baru di sub-folder ini. Setup lokal hanya untuk hal spesifik project (mis. script mirror/deploy/tools project). Selalu import dari `shared_core`.

<!-- /monorepo-global-setup -->


<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **0. HR DASHBAORD**.

> Index stale? Run `node .gitnexus/run.cjs analyze --index-only` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? Bootstrap with `npx`, `bunx`, or `pnpm dlx` — e.g. `bunx gitnexus@latest analyze` (npm 11 npx crash; #1939).

## Always Do

- **MUST run impact analysis before editing.** Use `impact({target: "symbolName", direction: "upstream"})` (MCP) or `node .gitnexus/run.cjs impact "symbolName" --direction upstream --repo .` (CLI fallback); report callers, processes, and risk. Never substitute grep for graph analysis. For unified PDG impact, add `mode: "pdg"` with optional `line: <N>` — it returns statement-level `affectedStatements` over CDG + REACHING_DEF and inter-procedural symbols in `interproceduralByDepth`/`byDepth`; no-layer/degraded PDG results are UNKNOWN-risk notes (`--pdg` layer). CLI equivalent: `node .gitnexus/run.cjs impact "symbolName" --direction upstream --mode pdg --line <N> --repo .`.
- **MUST analyze graph changes before committing.** Use `detect_changes({scope: "all"})` (MCP) or `node .gitnexus/run.cjs detect-changes --scope all --repo .` (CLI fallback). `partial: true` or `truncated: true` is not a clean check — a zero means unseen, not unaffected; re-run it. For regression review: `detect_changes({scope: "compare", base_ref: "main"})` or `node .gitnexus/run.cjs detect-changes --scope compare --base-ref "main" --repo .`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- **MUST treat `risk: UNKNOWN` as unresolved, not as low.** An empty caller set is not evidence the symbol is unused — it can also mean the callers are not resolvable by the index (plain-object property access, dynamic dispatch, cross-language calls). `impact` pairs `UNKNOWN` with a `riskNote` saying so. Confirm with a text search before treating the symbol as safe to change or delete; do not proceed on the strength of a zero.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).
- For control/data dependence, `pdg_query({mode: "controls", target: "fileOrSymbol"})` answers "under what condition does X run?" (CDG, incl. guard clauses) and `pdg_query({mode: "flows", target, variable})` traces "where does variable Y flow?" (REACHING_DEF). `--pdg` layer.

## Never Do

- NEVER edit a function, class, or method before MCP/CLI impact analysis.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis, and never read `UNKNOWN` as an all-clear — it means the walk could not answer, which is the one verdict that requires confirming by other means.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit before MCP/CLI graph change analysis.

## Resources

| Resource | Use for |
| --- | --- |
| `gitnexus://repo/0. HR DASHBAORD/context` | Codebase overview, check index freshness |
| `gitnexus://repo/0. HR DASHBAORD/clusters` | All functional areas |
| `gitnexus://repo/0. HR DASHBAORD/processes` | All execution flows |
| `gitnexus://repo/0. HR DASHBAORD/process/{name}` | Step-by-step execution trace |

<!-- gitnexus:end -->

<!-- project-workflow:start -->
# Workflow Project (terverifikasi 28 Agu 2026)

Repo ini punya remote GitHub: **https://github.com/imannurchaedi-max/HRDASHBOARD** (branch `main`). Klaim "SUDAH git" benar. **Koreksi 12 Nov 2026:** salinan lokal sempat kehilangan folder `.git` (kemungkinan karena sync) dan sudah disambungkan ulang ke commit `5fbd562`. Karena folder ini kini **kode kerja aktif** (DECISION-002): jalankan `git pull` sebelum mulai, commit tiap perubahan, dan JANGAN pernah commit `REF/` atau `tools/sheet_values.json` (PII — sudah di-`.gitignore`).

## Sebelum mengedit simbol apa pun
- `python -c "from shared_core.core_setup import run_gitnexus; run_gitnexus('impact', '<namaSimbol>', '-d', 'upstream', '-r', '0. HR DASHBAORD', repo_root='.')"` — wajib; laporkan blast radius ke user. Contoh: `nsBuildRecords_` = HIGH (5 caller: 4 endpoint + selfTest).
- Gunakan GitNexus GLOBAL via `shared_core.run_gitnexus` (list args, aman untuk nama repo ber-spasi). Jangan pakai `.gitnexus/run.cjs` lokal.

## Setelah mengedit ACTIVE/ atau documentation/
- Jalankan `powershell -File sync-graphify.ps1` — mirror `.gs`→`graphify-input/active/*.js`, regenerasi fixture, harness + check_html, lalu re-index GitNexus via GLOBAL. Tanpa ini, hasil query/impact membaca kode lama.
- Test manual: `node tools/harness.js` dan `node tools/check_html.js` — keduanya harus hijau sebelum deploy/commit.
- Refresh fixture dari xlsx: `python tools/dump_sheet.py` (path relatif ke repo, 35 kolom A:AI).

## Setelah mengubah ACTIVE-v2/ (kode kerja aktif)
- `node tools/verify-v2.cjs` — **WAJIB hijau**. Ini satu-satunya uji yang meng-cover `ACTIVE-v2/` (47 cek: sesi SSO, gerbang izin per modul, anti-spoofing NIK client, gerbang admin, jalur scheduler, gagal-baca vs tidak-terdaftar, integritas cache, 4 endpoint, `doGet`).
- `tools/harness.js` dan `tools/check_html.js` HANYA membaca `ACTIVE/` (3 file) — tidak menyentuh `ACTIVE-v2/`. Jangan menganggap "hijau" di sana berarti v2 aman.
- `sync-graphify.ps1` juga hanya mirror `ACTIVE/` → indeks GitNexus/Graphify **tidak** memuat modul v2. Impact analysis untuk file v2 masih buta, jadi baca kode langsung.
- Jangan mengubah `ACTIVE/` saat mengerjakan `ACTIVE-v2/` (dan sebaliknya). `ACTIVE-v2/` = kode kerja aktif; `ACTIVE/` = arsip beku.

## Sebelum commit
- `python -c "from shared_core.core_setup import run_gitnexus; run_gitnexus('detect-changes', '-r', '0. HR DASHBAORD', repo_root='.')"` — verifikasi hanya simbol yang diharapkan yang berubah. Compare ke baseline: `--scope compare -b main`.
- `git status` — pastikan tidak ada file PII (`REF/`, `tools/sheet_values.json`) ter-stage; keduanya di-gitignore permanen.

## Catatan
- Blok di antara marker `gitnexus:start/end` di file ini ditulis ulang otomatis oleh `analyze` — jangan edit di dalamnya; tambahan project taruh di luar marker.
- `graphify-out/cache/` dan `node_modules/` lokal project tidak di-commit (regenerable). `.gitnexus/` & GitNexus CLI kini GLOBAL di root workspace.
- **DECISION-002 (12 Nov 2026): `ACTIVE-v2/` adalah KODE KERJA AKTIF.** Development modul HR dilanjutkan **di sini**; **DT SUMMARY diparkir** — jangan mengembangkan modul HR di sana. `ACTIVE/` (Sep 2026) = arsip beku, jangan dikembangkan/dideploy. Deploy `ACTIVE-v2/` **belum** dilakukan dan menunggu keputusan model akses data (`ACTIVE-v2/DECISION-002.md`).
- **Jangan menaruh data produksi/PII di repo ini.** `REF/` dan `tools/sheet_values.json` tetap di-ignore.
- **`ACTIVE-v2/` = modul HR hasil extract balik dari portal** (paritas rilis 8 Nov 2026, diverifikasi: frontend md5 identik, 68 fungsi backend sama). Sejak DECISION-002 file ini **boleh dikembangkan langsung** — tidak ada lagi salinan ulang dari portal. `TrialFrontendHr.html` masih salinan verbatim; kalau kamu mengubahnya, catat di README bahwa paritas portal sudah dilepas. `ns domain.gs` memuat **4 patch keamanan permanen** (didaftar di header file; cek `grep -c "PATCH P[0-9]" "ns domain.gs"` → 3) yang **tidak boleh hilang**.
- **Auth `ACTIVE-v2/`**: SSO saja (login NIK/password dihapus), manifest `executeAs: USER_ACCESSING`. **Koreksi 12 Nov 2026:** `Session.getActiveUser()` = user yang mengakses dan bisa KOSONG bila tidak ada user aktif (mis. trigger); `getEffectiveUser()` = akun yang otoritasnya dipakai. Klaim "USER_DEPLOYING membuat semua pengunjung terbaca sebagai pemilik" TIDAK benar sebagai aturan umum — perlakuannya harus diuji empiris. Konsekuensi nyata USER_ACCESSING: user butuh akses baca ke 2 spreadsheet, sehingga gerbang 4 modul bersifat **tingkat-API, bukan isolasi data**. Baca `ACTIVE-v2/README-DEPLOY.md` bagian 4 sebelum deploy.
- **Fungsi admin `ACTIVE-v2/` fail-closed**: butuh Script Property `NS_ADMIN_NIKS`/`NS_ADMIN_EMAILS`. Scheduler harian berjalan tanpa user aktif dan hanya menerima NIK di `NS_DASHBOARD_REFRESH_NIK`.
<!-- project-workflow:end -->



<!-- SHARED AI TOOLS: monorepo root -->
## Shared AI Tools (Context7, Superpowers & Anthropic Skills)
- **Context7** - dokumentasi kode real-time untuk LLM/agent.
  - MCP: `resolve-library-id` + `query-docs`.
  - CLI: `ctx7 library <nama> <query>` lalu `ctx7 docs <libraryId> <query>`.
  - Guide lengkap: `CONTEXT7_GUIDE.md` (root monorepo).
- **Superpowers** - framework skill/metodologi agent.
  - Alur: spec -> plan -> TDD red/green -> subagent -> review (YAGNI & DRY).
  - Skill: `test-driven-development`, `writing-plans`, `executing-plans`, `subagent-driven-development`, `systematic-debugging`.
- **Anthropic Skills** - skill resmi Anthropic (dokumen: `docx`/`pdf`/`pptx`/`xlsx`; contoh: `mcp-builder`, `webapp-testing`, `frontend-design`). Terpasang di Claude Code.
- Aturan & tools monorepo lain: `AGENTS.md` + `AI_INSTRUCTIONS.md` (root monorepo).