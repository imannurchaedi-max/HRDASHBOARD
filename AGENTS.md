<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **0. HR DASHBAORD**. Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/0. HR DASHBAORD/context` | Codebase overview, check index freshness |
| `gitnexus://repo/0. HR DASHBAORD/clusters` | All functional areas |
| `gitnexus://repo/0. HR DASHBAORD/processes` | All execution flows |
| `gitnexus://repo/0. HR DASHBAORD/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

<!-- project-workflow:start -->
# Workflow Project (terverifikasi 28 Agu 2026)

Repo ini SUDAH git (branch `main`) DAN ter-index GitNexus. Selalu dahulukan keduanya sebelum mengubah kode.

## Sebelum mengedit simbol apa pun
- `npx gitnexus impact <namaSimbol> -d upstream -r "0. HR DASHBAORD"` — wajib; laporkan blast radius ke user. Contoh: `nsBuildRecords_` = HIGH (5 caller: 4 endpoint + selfTest).
- Jangan pakai `node .gitnexus/run.cjs` untuk perintah yang butuh `-r`: wrapper itu menggabungkan argumen lewat shell, sehingga nama repo ber-spasi terpecah. Pakai `npx gitnexus ...` dengan tanda kutip.

## Setelah mengedit ACTIVE/ atau documentation/
- Jalankan `powershell -File sync-graphify.ps1` — mirror `.gs`→`graphify-input/active/*.js`, regenerasi fixture, harness + check_html, lalu re-index GitNexus. Tanpa ini, hasil query/impact membaca kode lama.
- Test manual: `node tools/harness.js` dan `node tools/check_html.js` — keduanya harus hijau sebelum deploy/commit.
- Refresh fixture dari xlsx: `python tools/dump_sheet.py` (path relatif ke repo, 35 kolom A:AI).

## Sebelum commit
- `npx gitnexus detect-changes -r "0. HR DASHBAORD"` — verifikasi hanya simbol yang diharapkan yang berubah. Compare ke baseline: `--scope compare -b main`.
- `git status` — pastikan tidak ada file PII (`REF/`, `tools/sheet_values.json`) ter-stage; keduanya di-gitignore permanen.

## Catatan
- Blok di antara marker `gitnexus:start/end` di file ini ditulis ulang otomatis oleh `analyze` — jangan edit di dalamnya; tambahan project taruh di luar marker.
- `.gitnexus/`, `graphify-out/cache/`, `node_modules/` tidak di-commit (regenerable).
- Deploy ke GAS tetap manual: paste 3 file → New deployment → paste URL `/exec` ke `CONFIG!A2` (lihat `documentation/ns_record_architecture.md` §6).
<!-- project-workflow:end -->
