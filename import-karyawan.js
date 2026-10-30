// import-karyawan.js
// Import massal data karyawan dari file Excel (.xlsx) atau CSV.
// Dimuat SETELAH app.js:  <script src="app.js"></script><script src="import-karyawan.js"></script>
// Memakai variabel/fungsi dari app.js: supabaseClient, allEmployees, loadEmployeesData,
// ensureExcelJS, downloadBlob, escapeHtml.

(function () {
  const MAX_ROWS = 1000;   // batas baris per file
  const CHUNK = 100;       // jumlah baris per kiriman ke database
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const SAMPLE_DOMAIN = "@contoh.example"; // baris contoh di template, otomatis diabaikan

  // Nama kolom (dinormalkan: huruf kecil tanpa spasi/simbol) -> field database
  const ALIAS = {
    namalengkap: "full_name", nama: "full_name", namakaryawan: "full_name", fullname: "full_name", name: "full_name",
    email: "email", emailkerja: "email", emailkaryawan: "email",
    nik: "nik", nomorindukkaryawan: "nik",
    jabatan: "jabatan",
    namapekerjaan: "nama_pekerjaan", pekerjaan: "nama_pekerjaan",
    nohp: "phone", nohpwhatsapp: "phone", nohpwa: "phone", nomorhp: "phone", hp: "phone",
    telepon: "phone", whatsapp: "phone", phone: "phone", nowhatsapp: "phone",
    peran: "role", role: "role"
  };

  let pendingRows = [];

  const norm = (h) => String(h || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const esc = (v) => (typeof escapeHtml === "function" ? escapeHtml(v) : String(v));

  // ---------- Membaca isi sel Excel ----------
  function cellText(v) {
    if (v === null || v === undefined) return "";
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === "object") {
      if (v.richText) return v.richText.map((t) => t.text).join("").trim();
      if (v.text !== undefined) return cellText(v.text);
      if (v.result !== undefined) return cellText(v.result);
      if (v.hyperlink) return String(v.hyperlink).replace(/^mailto:/i, "").trim();
      return "";
    }
    if (typeof v === "number") return Number.isInteger(v) ? v.toFixed(0) : String(v);
    return String(v).trim();
  }

  async function parseXlsx(file) {
    if (!(await ensureExcelJS())) throw new Error("Library ExcelJS gagal dimuat. Periksa koneksi internet.");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await file.arrayBuffer());
    const ws = wb.worksheets[0];
    if (!ws) throw new Error("File Excel kosong.");
    const cols = Math.max(ws.columnCount, 10);
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const vals = [];
      for (let c = 1; c <= cols; c++) vals.push(cellText(row.getCell(c).value));
      if (vals.some((x) => x !== "")) rows.push({ line: rowNumber, vals });
    });
    return rows;
  }

  // ---------- Membaca CSV (pemisah koma atau titik koma) ----------
  function parseCsvText(text) {
    text = String(text).replace(/^\uFEFF/, "");
    const firstLine = text.split(/\r?\n/)[0] || "";
    const delim = firstLine.split(";").length > firstLine.split(",").length ? ";" : ",";
    const rows = [];
    let row = [], cur = "", inQ = false, recordNo = 1;

    const endRecord = () => {
      row.push(cur); cur = "";
      if (row.some((c) => c.trim() !== "")) rows.push({ line: recordNo, vals: row.map((c) => c.trim()) });
      row = []; recordNo++;
    };

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
        else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === delim) { row.push(cur); cur = ""; }
      else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; endRecord(); }
      else cur += ch;
    }
    if (cur !== "" || row.length) endRecord();
    return rows;
  }

  // Excel sering menghapus angka 0 di depan nomor HP (0812... -> 812...)
  function fixPhone(p) {
    if (/^8\d{8,11}$/.test(p)) return "0" + p;
    return p;
  }

  // ---------- Validasi ----------
  function analyze(rows) {
    if (!rows.length) throw new Error("File tidak berisi data.");

    const colOf = {};
    rows[0].vals.map(norm).forEach((h, i) => {
      const f = ALIAS[h];
      if (f && colOf[f] === undefined) colOf[f] = i;
    });
    if (colOf.full_name === undefined || colOf.email === undefined) {
      throw new Error('Kolom wajib tidak ditemukan. Baris pertama harus berisi judul "Nama Lengkap" dan "Email". Unduh template untuk contohnya.');
    }

    const data = rows.slice(1);
    if (data.length > MAX_ROWS) throw new Error(`Maksimal ${MAX_ROWS} baris per file. File Anda berisi ${data.length} baris.`);

    const existing = typeof allEmployees !== "undefined" ? allEmployees : [];
    const existingEmails = new Set(existing.map((e) => (e.email || "").toLowerCase()));
    const existingNik = new Map(existing.filter((e) => e.nik).map((e) => [String(e.nik).trim().toLowerCase(), e.full_name]));
    const seenEmail = new Set(), seenNik = new Set();
    const valid = [], errors = [], skipped = [];

    data.forEach((r) => {
      const get = (f) => (colOf[f] === undefined ? "" : r.vals[colOf[f]] || "");
      const rec = {
        line: r.line,
        full_name: get("full_name"),
        email: get("email").toLowerCase(),
        nik: get("nik"),
        jabatan: get("jabatan"),
        nama_pekerjaan: get("nama_pekerjaan"),
        phone: fixPhone(get("phone")),
        role: "employee"
      };
      const roleRaw = get("role").toLowerCase();

      if (!rec.full_name && !rec.email && !rec.nik) return;          // baris kosong
      if (rec.email.endsWith(SAMPLE_DOMAIN)) return;                  // baris contoh dari template

      const problems = [];
      if (!rec.full_name) problems.push("Nama kosong");
      if (!rec.email) problems.push("Email kosong");
      else if (!EMAIL_RE.test(rec.email)) problems.push("Format email tidak valid");

      if (roleRaw) {
        if (roleRaw === "admin") rec.role = "admin";
        else if (["karyawan", "employee", "staff", "staf"].includes(roleRaw)) rec.role = "employee";
        else problems.push(`Peran "${get("role")}" tidak dikenal (isi Karyawan atau Admin)`);
      }

      if (!problems.length && existingEmails.has(rec.email)) {
        skipped.push({ line: rec.line, name: rec.full_name, msg: "Email sudah terdaftar (dilewati)" });
        return;
      }
      if (!problems.length && seenEmail.has(rec.email)) problems.push("Email dobel di dalam file");

      if (rec.nik) {
        const k = rec.nik.toLowerCase();
        if (existingNik.has(k)) problems.push(`NIK sudah dipakai ${existingNik.get(k)}`);
        else if (seenNik.has(k)) problems.push("NIK dobel di dalam file");
      }

      if (problems.length) { errors.push({ line: rec.line, name: rec.full_name || "-", msg: problems.join("; ") }); return; }

      seenEmail.add(rec.email);
      if (rec.nik) seenNik.add(rec.nik.toLowerCase());
      valid.push(rec);
    });

    return { valid, errors, skipped };
  }

  // ---------- Tampilan ----------
  function el(id) { return document.getElementById(id); }
  function setStatus(text, isError) {
    const s = el("importStatus");
    if (s) { s.textContent = text; s.style.color = isError ? "#b91c1c" : "#0e7490"; }
  }

  function renderPreview(res, fileName) {
    const { valid, errors, skipped } = res;
    pendingRows = valid;

    const problemRows = [
      ...errors.map((e) => ({ ...e, kind: "Ditolak" })),
      ...skipped.map((s) => ({ ...s, kind: "Dilewati" }))
    ].sort((a, b) => a.line - b.line);

    const problemHtml = problemRows.length ? `
      <p style="margin:12px 0 4px;"><b>Baris yang tidak diimpor:</b></p>
      <div class="tableWrap" style="max-height:180px; overflow:auto;">
        <table><thead><tr><th>Baris</th><th>Nama</th><th>Status</th><th>Alasan</th></tr></thead>
        <tbody>${problemRows.slice(0, 100).map((p) =>
          `<tr><td>${p.line}</td><td>${esc(p.name)}</td><td>${p.kind}</td><td>${esc(p.msg)}</td></tr>`).join("")}
        </tbody></table>
      </div>
      ${problemRows.length > 100 ? `<p class="muted">…dan ${problemRows.length - 100} baris lainnya.</p>` : ""}` : "";

    const previewHtml = valid.length ? `
      <p style="margin:12px 0 4px;"><b>Pratinjau data yang akan diimpor${valid.length > 8 ? " (8 pertama)" : ""}:</b></p>
      <div class="tableWrap" style="max-height:200px; overflow:auto;">
        <table><thead><tr><th>Nama</th><th>Email</th><th>NIK</th><th>Jabatan</th><th>Pekerjaan</th><th>Peran</th></tr></thead>
        <tbody>${valid.slice(0, 8).map((v) =>
          `<tr><td>${esc(v.full_name)}</td><td>${esc(v.email)}</td><td>${esc(v.nik || "-")}</td><td>${esc(v.jabatan || "-")}</td><td>${esc(v.nama_pekerjaan || "-")}</td><td>${v.role === "admin" ? "Admin" : "Karyawan"}</td></tr>`).join("")}
        </tbody></table>
      </div>` : "";

    el("importBody").innerHTML = `
      <p class="muted" style="margin:0 0 8px;">File: <b>${esc(fileName)}</b></p>
      <p style="margin:0;">
        ✅ <b>${valid.length}</b> siap diimpor &nbsp;•&nbsp;
        ⏭️ <b>${skipped.length}</b> dilewati (sudah terdaftar) &nbsp;•&nbsp;
        ❌ <b>${errors.length}</b> bermasalah
      </p>
      ${previewHtml}${problemHtml}`;

    const btn = el("importConfirmBtn");
    btn.textContent = `Import ${valid.length} Karyawan`;
    btn.disabled = valid.length === 0;
    btn.classList.remove("hidden");
    setStatus(valid.length ? "Periksa data di atas, lalu klik tombol Import." : "Tidak ada baris yang bisa diimpor.", !valid.length);
  }

  async function handleFile(file) {
    if (!file) return;
    el("importModal").classList.remove("hidden");
    el("importBody").innerHTML = "";
    el("importConfirmBtn").classList.add("hidden");
    setStatus("Membaca file…");

    try {
      // Pakai data karyawan terbaru supaya pengecekan duplikat akurat
      if (typeof loadEmployeesData === "function") await loadEmployeesData();

      const name = file.name.toLowerCase();
      let rows;
      if (name.endsWith(".xlsx")) rows = await parseXlsx(file);
      else if (name.endsWith(".csv")) rows = parseCsvText(await file.text());
      else throw new Error("Format file harus .xlsx atau .csv. (File .xls lama: simpan ulang sebagai .xlsx.)");

      renderPreview(analyze(rows), file.name);
    } catch (e) {
      el("importBody").innerHTML = "";
      setStatus(e.message || "Gagal membaca file.", true);
    }
  }

  // ---------- Kirim ke database ----------
  const toDb = (r) => ({
    full_name: r.full_name,
    email: r.email,
    nik: r.nik || null,
    jabatan: r.jabatan || null,
    nama_pekerjaan: r.nama_pekerjaan || null,
    phone: r.phone || null,
    role: r.role
  });

  async function runImport() {
    const total = pendingRows.length;
    if (!total) return;
    const btn = el("importConfirmBtn");
    btn.disabled = true;
    let done = 0;

    try {
      for (let i = 0; i < total; i += CHUNK) {
        const chunk = pendingRows.slice(i, i + CHUNK).map(toDb);
        setStatus(`Mengimpor ${Math.min(i + CHUNK, total)} dari ${total}…`);
        const { error } = await supabaseClient.from("employee_registry").insert(chunk);
        if (error) {
          const hint = error.code === "23505" ? " (ada email/NIK yang sudah terdaftar — buka ulang import untuk memeriksa)" : "";
          setStatus(`Gagal pada kelompok ke-${Math.floor(i / CHUNK) + 1}: ${error.message}${hint}. Berhasil tersimpan sebelumnya: ${done} karyawan.`, true);
          if (typeof loadEmployeesData === "function") await loadEmployeesData();
          btn.disabled = false;
          return;
        }
        done += chunk.length;
      }

      pendingRows = [];
      btn.classList.add("hidden");
      el("importBody").innerHTML = `
        <p style="margin:0;">🎉 <b>${done} karyawan</b> berhasil ditambahkan.</p>
        <p class="muted">Minta masing-masing karyawan membuka halaman login, klik <b>Daftar akun</b>, lalu mendaftar dengan email yang tercatat.</p>`;
      setStatus("");
      if (typeof loadEmployeesData === "function") await loadEmployeesData();
    } catch (e) {
      setStatus("Import gagal: " + (e.message || e), true);
      btn.disabled = false;
    }
  }

  // ---------- Template ----------
  async function downloadTemplate() {
    if (!(await ensureExcelJS())) { alert("Library ExcelJS gagal dimuat. Periksa koneksi internet."); return; }

    const wb = new ExcelJS.Workbook();
    wb.creator = "AbsensiPro";
    const ws = wb.addWorksheet("Karyawan");
    const headers = ["Nama Lengkap", "Email", "NIK", "Jabatan", "Nama Pekerjaan", "No. HP / WhatsApp", "Peran"];
    ws.columns = [
      { width: 28 }, { width: 34 }, { width: 22 }, { width: 22 }, { width: 26 }, { width: 22 }, { width: 12 }
    ];
    ws.getColumn(3).numFmt = "@";   // NIK sebagai teks agar angka 0 di depan tidak hilang
    ws.getColumn(6).numFmt = "@";   // No. HP sebagai teks

    const head = ws.getRow(1);
    headers.forEach((t, i) => {
      const c = head.getCell(i + 1);
      c.value = t;
      c.font = { bold: true, color: { argb: "FFFFFFFF" } };
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF155E75" } };
      c.alignment = { horizontal: "center", vertical: "middle" };
    });
    head.height = 22;

    // Baris contoh (domain @contoh.example otomatis diabaikan saat import)
    ws.addRow(["Contoh Satu", "contoh1" + SAMPLE_DOMAIN, "6371010101010001", "Mandor", "Pemanen Sawit", "081234567890", "Karyawan"]);
    ws.addRow(["Contoh Dua", "contoh2" + SAMPLE_DOMAIN, "6371010101010002", "Staf Administrasi", "Operator Data", "082345678901", "Karyawan"]);

    // Dropdown kolom Peran
    for (let r = 2; r <= 1001; r++) {
      ws.getCell(`G${r}`).dataValidation = { type: "list", allowBlank: true, formulae: ['"Karyawan,Admin"'] };
    }
    ws.views = [{ state: "frozen", ySplit: 1 }];

    const guide = wb.addWorksheet("Petunjuk");
    guide.getColumn(1).width = 100;
    [
      "PETUNJUK IMPORT KARYAWAN",
      "",
      "1. Isi data di sheet 'Karyawan', satu karyawan per baris. Baris pertama (judul kolom) jangan diubah.",
      "2. Kolom WAJIB: Nama Lengkap dan Email. Kolom lain boleh dikosongkan.",
      "3. Email harus unik. Email yang sudah terdaftar akan dilewati otomatis.",
      "4. NIK sebaiknya unik (dipakai untuk verifikasi lupa kata sandi). NIK yang sama dengan karyawan lain akan ditolak.",
      "5. Kolom Peran diisi 'Karyawan' atau 'Admin'. Jika kosong dianggap Karyawan.",
      "6. Kolom NIK dan No. HP sudah berformat teks. Jangan diubah ke angka agar angka 0 di depan tidak hilang.",
      "7. Baris contoh (email @contoh.example) otomatis diabaikan, boleh dihapus atau dibiarkan.",
      "8. Maksimal " + MAX_ROWS + " baris per file. Simpan sebagai .xlsx (atau .csv) lalu unggah lewat tombol Import.",
      "9. Setelah import, setiap karyawan harus mendaftar sendiri lewat 'Daftar akun' memakai email yang sama."
    ].forEach((t, i) => {
      const c = guide.getCell(`A${i + 1}`);
      c.value = t;
      c.alignment = { wrapText: true, vertical: "top" };
      if (i === 0) c.font = { bold: true, size: 13 };
    });

    const buf = await wb.xlsx.writeBuffer();
    downloadBlob(
      new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
      "template-import-karyawan.xlsx"
    );
  }

  // ---------- Pasang tombol & modal ----------
  function init() {
    const addBtn = document.getElementById("openAddEmpBtn");
    if (!addBtn || document.getElementById("importEmpBtn")) return;

    const bar = document.createElement("div");
    bar.className = "row gap-sm";
    bar.style.margin = "0.5rem 0";
    bar.innerHTML = `
      <button type="button" id="importEmpBtn" class="secondary">⬆️ Import Excel / CSV</button>
      <button type="button" id="templateEmpBtn" class="secondary">⬇️ Unduh Template</button>
      <input type="file" id="importEmpFile" accept=".xlsx,.csv" class="hidden">`;
    addBtn.parentElement.after(bar);

    const modal = document.createElement("div");
    modal.id = "importModal";
    modal.className = "modal-panel hidden";
    modal.style.maxWidth = "720px";
    modal.style.maxHeight = "88vh";
    modal.style.overflowY = "auto";
    modal.innerHTML = `
      <h3>Import Karyawan dari Excel / CSV</h3>
      <div id="importBody"></div>
      <p id="importStatus" class="msg" aria-live="polite"></p>
      <div class="row">
        <button type="button" id="importConfirmBtn" class="hidden">Import</button>
        <button type="button" id="importCloseBtn" class="secondary">Tutup</button>
      </div>`;
    document.body.appendChild(modal);

    const fileInput = document.getElementById("importEmpFile");
    document.getElementById("importEmpBtn").onclick = () => { fileInput.value = ""; fileInput.click(); };
    fileInput.onchange = (e) => handleFile(e.target.files && e.target.files[0]);
    document.getElementById("templateEmpBtn").onclick = downloadTemplate;
    document.getElementById("importConfirmBtn").onclick = runImport;
    document.getElementById("importCloseBtn").onclick = () => {
      modal.classList.add("hidden");
      pendingRows = [];
    };
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
  }

  // Hanya untuk pengujian di Node
  if (typeof module !== "undefined") module.exports = { parseCsvText, analyze, fixPhone, cellText };
})();
