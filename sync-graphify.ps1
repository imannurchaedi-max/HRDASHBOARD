# Sinkronkan ACTIVE/*.gs -> graphify-input/active/*.js lalu re-index GitNexus.
# WAJIB dijalankan setiap selesai mengedit file di ACTIVE/ atau documentation/.
# GitNexus mengindeks mirror .js, BUKAN .gs - tanpa langkah ini semua hasil
# query/impact menyesatkan karena membaca kode lama.
$root = $PSScriptRoot
$dest = Join-Path $root "graphify-input\active"
if (-not (Test-Path $dest)) { New-Item -ItemType Directory -Force $dest | Out-Null }

Write-Host "=== Step 1: Mirror sync ==="
Get-ChildItem (Join-Path $root "ACTIVE\*.gs") | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $dest ($_.BaseName + ".js")) -Force
    Write-Host "sync: $($_.Name) -> graphify-input/active/$($_.BaseName).js"
}
$indexHtml = Join-Path $root "ACTIVE\index.html"
if (Test-Path $indexHtml) {
    Copy-Item $indexHtml (Join-Path $dest "index.html") -Force
    Write-Host "sync: index.html"
}

$docDest = Join-Path $root "graphify-input\documentation"
if (-not (Test-Path $docDest)) { New-Item -ItemType Directory -Force $docDest | Out-Null }
Get-ChildItem (Join-Path $root "documentation\*.md") -ErrorAction SilentlyContinue | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $docDest $_.Name) -Force
    Write-Host "sync: documentation/$($_.Name)"
}

Write-Host "`n=== Step 2: Test harness ==="
python (Join-Path $root "tools\dump_sheet.py")
if ($LASTEXITCODE -ne 0) {
    Write-Host "WARNING: dump_sheet.py gagal - harness dilewati"
} else {
    node (Join-Path $root "tools\harness.js")
    if ($LASTEXITCODE -ne 0) { Write-Host "WARNING: harness ada cek yang GAGAL" }
    node (Join-Path $root "tools\check_html.js")
    if ($LASTEXITCODE -ne 0) { Write-Host "WARNING: check_html ada cek yang GAGAL" }
}

Write-Host "`n=== Step 3: GitNexus re-index ==="
# Pakai runner lokal GitNexus supaya konsisten, lalu aktifkan/abaikan mode git
# sesuai status folder saat ini.
$gitArgs = @(".gitnexus/run.cjs", "analyze", "--no-stats")
git -C $root rev-parse --is-inside-work-tree *> $null
if ($LASTEXITCODE -ne 0) {
    $gitArgs += "--skip-git"
}
node (Join-Path $root $gitArgs[0]) $gitArgs[1..($gitArgs.Length - 1)]
if ($LASTEXITCODE -ne 0) { Write-Host "WARNING: GitNexus analyze gagal" }

Write-Host "`nSync selesai."
