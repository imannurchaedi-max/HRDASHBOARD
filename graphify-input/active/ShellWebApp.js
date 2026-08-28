function doGet(e) {
  // =======================================================================
  // ⚠️ GANTI ID INI JIKA FILE SPREADSHEET NS RECORD PINDAH/DIGANTI.
  // Shell ini sengaja hardcode ID (bootstrap): dia butuh ID justru untuk
  // MENEMUKAN tab CONFIG tempat URL backend dibaca. Selain ID ini, semua
  // konfigurasi lain dibaca dinamis dari tab CONFIG.
  // =======================================================================
  const sheetId = '1qSTpi6OwUOBoORIALBCdwWehH-R0L8az4vwuaOV3shU';
  
  // Baca URL Backend terbaru dari tab CONFIG sel A2
  let backendUrl = null;
  try {
    const ss = SpreadsheetApp.openById(sheetId);
    const configSheet = ss.getSheetByName("CONFIG");
    if (!configSheet) {
      return HtmlService.createHtmlOutput('Error: Tab "CONFIG" tidak ditemukan di Spreadsheet NS Record.');
    }
    backendUrl = configSheet.getRange("A2").getValue();
  } catch (err) {
    return HtmlService.createHtmlOutput('Error gagal membuka Spreadsheet: ' + err.message + '<br>Pastikan ID Spreadsheet di ShellWebApp.gs sudah benar.');
  }

  if (!backendUrl || backendUrl === "") {
    return HtmlService.createHtmlOutput('Error: URL Backend di sel A2 kosong. Mohon paste URL Web App di tab CONFIG sel A2.');
  }

  // Validasi: A2 harus URL /exec Apps Script asli (termasuk domain Google Workspace), bukan sembarang string.
  backendUrl = backendUrl.toString().trim();
  if (!/^https:\/\/script\.google\.com\/(?:a\/macros\/[^\/]+\/|macros\/)s\/[A-Za-z0-9_-]+\/exec$/.test(backendUrl)) {
    return HtmlService.createHtmlOutput('Error: URL Backend di tab CONFIG sel A2 tidak valid. Harus berupa URL /exec Apps Script (https://script.google.com/.../exec).');
  }

  // Forward query string (misal: ?tab=contract) jika dipanggil via deep link
  let queryString = "";
  if (e && e.queryString) {
    queryString = "?" + e.queryString;
  }
  const fullTargetUrl = backendUrl + queryString;
  const safeBackendUrl = fullTargetUrl
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // Redirect ke backend URL (bukan iframe — X-Frame-Options sameorigin di
  // script.google.com akan memblokir iframe cross-origin).
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { margin: 0; background: #0f172a; color: #93c5fd; font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; }
          .redirect-box { text-align: center; }
          .spinner { width: 40px; height: 40px; border: 3px solid rgba(147,197,253,0.2); border-top: 3px solid #3b82f6; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 16px; }
          @keyframes spin { to { transform: rotate(360deg); } }
          a { color: #60a5fa; }
        </style>
        <meta http-equiv="refresh" content="0;url=${safeBackendUrl}">
      </head>
      <body>
        <div class="redirect-box">
          <div class="spinner"></div>
          <p>Mengarahkan ke HR DASHBOARD...</p>
          <p style="font-size:14px;color:#64748b">Klik <a href="${safeBackendUrl}">di sini</a> jika halaman tidak terbuka otomatis.</p>
        </div>
      </body>
    </html>
  `;
  
  return HtmlService.createHtmlOutput(html)
    .setTitle('HR DASHBOARD');
}
