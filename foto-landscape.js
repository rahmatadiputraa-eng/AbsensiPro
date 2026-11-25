// foto-landscape.js
// Mengingatkan karyawan agar mengambil foto absensi dalam posisi LANDSCAPE (HP mendatar).
//   1) Pengingat tetap di atas tombol "Ambil Foto Selfie" (sebelum kamera dibuka).
//   2) Setelah foto diambil, orientasinya dicek. Jika foto TEGAK (portrait), muncul peringatan
//      di bawah pratinjau foto.
//
// Catatan: orientasi ditentukan oleh aplikasi kamera HP, jadi aplikasi ini hanya bisa
// mengingatkan dan mendeteksi, tidak bisa memaksa kamera menjadi landscape.
//
// Cara pasang: di index.html, setelah <script src="app.js"></script> tambahkan:
//   <script src="foto-landscape.js"></script>
// File ini tidak mengubah app.js. Di bagian CFG di bawah, MODE bisa diubah:
//   "warn"  = hanya peringatan; foto tegak tetap boleh dikirim (bawaan)
//   "block" = foto tegak tidak bisa dikirim sampai diambil ulang secara landscape

(function () {
  const CFG = {
    MODE: "warn"   // "warn" atau "block"
  };

  const TEXT = {
    reminder: "Putar HP ke posisi mendatar (landscape) sebelum mengambil foto, agar hasilnya lebih luas dan stempel terbaca jelas.",
    warn: "Foto ini diambil dalam posisi tegak (portrait). Disarankan putar HP ke posisi mendatar (landscape), lalu ketuk \"Ulangi Foto\".",
    block: "Foto harus diambil dalam posisi mendatar (landscape). Putar HP, lalu ketuk \"Ulangi Foto\".",
    blockedSend: "Foto masih posisi tegak. Putar HP ke landscape lalu ketuk \"Ulangi Foto\" sebelum mengirim."
  };

  let portrait = false;
  let token = 0;
  let warnEl = null;

  const el = (id) => document.getElementById(id);
  const BOX = "margin:0.5rem 0; padding:10px 12px; border-radius:8px; background:#fff7ed; border:1px solid #fdba74; " +
              "color:#9a3412; font-size:0.9rem; line-height:1.4; display:flex; gap:8px; align-items:flex-start;";
  const ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" ' +
               'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none;margin-top:1px">' +
               '<rect x="2" y="7" width="20" height="10" rx="2"/><line x1="18" y1="12" x2="18.01" y2="12"/></svg>';

  function makeBox(id, text) {
    const b = document.createElement("div");
    b.id = id;
    b.setAttribute("role", "note");
    b.style.cssText = BOX;
    b.innerHTML = ICON + "<span></span>";
    b.lastChild.textContent = text;
    return b;
  }

  // ---------- Orientasi foto (setelah memperhitungkan rotasi EXIF) ----------
  async function orientedSize(file) {
    if (typeof createImageBitmap === "function") {
      try {
        const b = await createImageBitmap(file, { imageOrientation: "from-image" });
        const r = { w: b.width, h: b.height };
        if (b.close) b.close();
        return r;
      } catch (e) { /* coba cara lain */ }
    }
    return await new Promise((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => { resolve({ w: img.naturalWidth, h: img.naturalHeight }); URL.revokeObjectURL(url); };
      img.onerror = () => { resolve(null); URL.revokeObjectURL(url); };
      img.src = url;
    });
  }

  function renderWarn() {
    if (!warnEl) return;
    if (portrait) {
      warnEl.lastChild.textContent = CFG.MODE === "block" ? TEXT.block : TEXT.warn;
      warnEl.classList.remove("hidden");
      warnEl.style.display = "flex";
    } else {
      warnEl.style.display = "none";
    }
  }

  function clearWarn() { token++; portrait = false; renderWarn(); }

  // ---------- Pasang tampilan & pendengar ----------
  function init() {
    const section = el("cameraSection"), container = el("cameraContainer"), input = el("selfieInput");
    if (!section || !container || !input || el("landscapeReminder")) return;

    // 1) Pengingat tetap sebelum kamera dibuka
    section.insertBefore(makeBox("landscapeReminder", TEXT.reminder), container);

    // 2) Peringatan setelah foto diambil (di bawah pratinjau)
    warnEl = makeBox("landscapeWarning", TEXT.warn);
    warnEl.style.display = "none";
    const preview = el("previewContainer");
    if (preview && preview.after) preview.after(warnEl); else container.appendChild(warnEl);

    input.addEventListener("change", async (ev) => {
      const file = ev.target.files && ev.target.files[0];
      const my = ++token;
      if (!file) { portrait = false; renderWarn(); return; }
      const size = await orientedSize(file);
      if (my !== token || !size) return;       // ada foto yang lebih baru
      portrait = size.h > size.w;
      renderWarn();
    });

    // Bersihkan peringatan saat form direset (ganti akun / logout / pilih Check-in lagi)
    const prev = el("photoPreview");
    if (prev && typeof MutationObserver !== "undefined") {
      new MutationObserver(() => { if (prev.classList.contains("hidden")) clearWarn(); })
        .observe(prev, { attributes: true, attributeFilter: ["class"] });
    }

    // Mode "block": cegah pengiriman foto tegak (berjalan sebelum handler milik app.js)
    document.addEventListener("click", (ev) => {
      if (CFG.MODE !== "block" || !portrait) return;
      const btn = ev.target && ev.target.closest ? ev.target.closest("#attendanceBtn") : null;
      if (!btn) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      if (typeof message === "function" && el("attendanceMsg")) message("attendanceMsg", TEXT.blockedSend, true);
    }, true);
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
  }

  // Hanya untuk pengujian di Node
  if (typeof module !== "undefined") module.exports = { init, _cfg: CFG, _state: () => ({ portrait }) };
})();
