// stempel-foto.js
// Menempelkan STEMPEL pada foto selfie absensi sebelum diunggah (tanpa kotak latar):
//   - Pojok kiri atas  : label CHECK-IN / CHECK-OUT
//   - Pojok kanan atas : logo perusahaan (PU_APN_K3.png)
//   - Kiri bawah       : nama karyawan, nama pekerjaan, kegiatan, tanggal & jam,
//                        koordinat lokasi (+akurasi GPS) -> teks putih dengan bayangan tipis
// Stempel dibuat oleh aplikasi (bukan aplikasi kamera pihak ketiga), jadi seragam di semua HP
// dan tidak bisa diubah pengguna. Waktu mengikuti jam server bila jam-server.js terpasang.
//
// Cara pasang: di index.html, SETELAH <script src="app.js"></script> (dan setelah jam-server.js
// bila dipakai) tambahkan:
//   <script src="stempel-foto.js"></script>
// Unggah juga file logo PU_APN_K3.png ke folder yang sama dengan index.html.
// File ini tidak mengubah app.js. Caranya: membungkus fungsi getLocation() milik app.js.
// Fungsi itu dipanggil tepat sebelum foto diunggah, sehingga koordinat pada stempel
// sama persis dengan koordinat yang tersimpan di database.
//
// Opsional: stempel-foto.sql (fungsi agar karyawan bisa membaca Nama Pekerjaan miliknya sendiri).

(function () {
  const CFG = {
    TIMEZONE: "Asia/Makassar",          // Asia/Jakarta = WIB, Asia/Makassar = WITA, Asia/Jayapura = WIT
    ZONE_LABELS: { "Asia/Jakarta": "WIB", "Asia/Makassar": "WITA", "Asia/Jayapura": "WIT" },
    LOGO_CANDIDATES: ["PU_APN_K3.png", "#headerLogo", "Logo Palma.png", "icon-192.png"],   // dicoba berurutan
    LOGO_MAX_W: 0.36,       // lebar logo maksimal = 36% lebar foto
    LOGO_MAX_H: 0.16,       // tinggi logo maksimal = 16% tinggi foto
    TEXT_SIZE: 0.029,       // ukuran huruf = 2,9% lebar foto
    TEXT_MAX_H: 0.40,       // blok teks maksimal 40% tinggi foto (huruf mengecil otomatis bila lebih)
    SHADOW: "rgba(0,0,0,0.7)",
    LABEL_AS_PILL: true,    // true = label CHECK-IN/OUT berlatar warna; false = teks putih biasa
    JPEG_QUALITY: 0.85,
    FAIL_OPEN: false        // false = absensi dibatalkan bila stempel gagal dibuat; true = tetap kirim tanpa stempel
  };

  let last = null;        // { orig, stamped } agar percobaan kirim ulang tidak menumpuk stempel
  let logoCache = { tried: false, img: null };
  let workCache = { uid: null, value: "" };

  const el = (id) => document.getElementById(id);

  // ---------- Format teks ----------
  function fmtDateTime(d) {
    const tz = CFG.TIMEZONE;
    const date = new Intl.DateTimeFormat("id-ID", { timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(d);
    const time = new Intl.DateTimeFormat("id-ID", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .format(d).replace(/\./g, ":");
    return { date, time: `${time} ${CFG.ZONE_LABELS[tz] || tz}` };
  }
  const fmtCoord = (n) => Number(n).toFixed(6);

  function clockNow() {
    try {
      if (window.ClockGuard && ClockGuard.state() === "ok") return ClockGuard.serverNow();
    } catch (e) { /* pakai jam HP */ }
    return new Date();
  }

  // ---------- Data karyawan ----------
  async function getWorkName() {
    const uid = typeof currentUser !== "undefined" && currentUser ? currentUser.id : null;
    if (workCache.uid === uid && workCache.value) return workCache.value;

    let v = (typeof currentProfile !== "undefined" && currentProfile && currentProfile.nama_pekerjaan) || "";
    if (!v) {
      try {
        const { data, error } = await supabaseClient.rpc("my_nama_pekerjaan");
        if (!error && data) v = String(data).trim();
      } catch (e) { /* fungsi belum dibuat */ }
    }
    if (!v && uid) {
      try {
        const { data } = await supabaseClient.from("employee_registry").select("nama_pekerjaan").eq("user_id", uid).limit(1);
        v = (data && data[0] && data[0].nama_pekerjaan) || "";
      } catch (e) { /* dibatasi RLS */ }
    }
    v = String(v || "").trim();
    if (v) workCache = { uid, value: v };
    return v || "-";
  }

  async function getActivity(isCheckIn) {
    if (isCheckIn) return ((el("activityInput") && el("activityInput").value) || "").trim() || "-";
    // Check-out tidak punya isian kegiatan: pakai kegiatan check-in hari ini
    try {
      const start = new Date(); start.setHours(0, 0, 0, 0);
      const { data } = await supabaseClient.from("attendance").select("activity")
        .eq("user_id", currentUser.id).eq("check_type", "check_in")
        .gte("created_at", start.toISOString()).order("created_at", { ascending: false }).limit(1);
      return (data && data[0] && data[0].activity) || "-";
    } catch (e) { return "-"; }
  }

  // ---------- Logo ----------
  function loadImage(src) {
    return new Promise((resolve) => {
      const img = new Image();
      const timer = setTimeout(() => resolve(null), 4000);
      img.onload = () => { clearTimeout(timer); resolve(img.width ? img : null); };
      img.onerror = () => { clearTimeout(timer); resolve(null); };
      img.src = src;
    });
  }
  async function loadLogo() {
    if (logoCache.tried) return logoCache.img;
    logoCache.tried = true;
    const seen = new Set();
    for (let c of CFG.LOGO_CANDIDATES) {
      if (c.startsWith("#")) { const n = el(c.slice(1)); c = n ? n.getAttribute("src") : null; }
      if (!c || seen.has(c)) continue;
      seen.add(c);
      const img = await loadImage(c);
      if (img) { logoCache.img = img; break; }
    }
    return logoCache.img;
  }

  // ---------- Menggambar stempel ----------
  function wrapText(ctx, text, maxW, maxLines) {
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = "";
    const fits = (s) => ctx.measureText(s).width <= maxW;

    for (let w of words) {
      while (!fits(w) && w.length > 1) {       // kata sangat panjang dipotong
        let cut = w.length - 1;
        while (cut > 1 && !fits(w.slice(0, cut))) cut--;
        if (cur) { lines.push(cur); cur = ""; }
        lines.push(w.slice(0, cut)); w = w.slice(cut);
      }
      const test = cur ? cur + " " + w : w;
      if (fits(test)) cur = test; else { if (cur) lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);

    if (lines.length > maxLines) {
      const kept = lines.slice(0, maxLines);
      let t = kept[maxLines - 1];
      while (t.length > 1 && !fits(t + "…")) t = t.slice(0, -1);
      kept[maxLines - 1] = t + "…";
      return kept;
    }
    return lines;
  }

  function render(ctx, W, H, bitmap, logo, info) {
    ctx.drawImage(bitmap, 0, 0, W, H);

    const pad = Math.round(W * 0.025);
    let base = Math.max(13, Math.round(W * CFG.TEXT_SIZE));
    let rows = [], lh = 0;

    // Susun baris teks; huruf mengecil otomatis bila blok teks terlalu tinggi
    for (let attempt = 0; attempt < 6; attempt++) {
      lh = Math.round(base * 1.3);
      const maxW = W - pad * 2;
      rows = [];
      const add = (text, opts, maxLines) => {
        ctx.font = `${opts.bold ? "bold " : ""}${opts.size}px sans-serif`;
        wrapText(ctx, text, maxW, maxLines || 1).forEach((t) => rows.push({ t, ...opts }));
      };
      add(info.name, { bold: true, size: Math.round(base * 1.12) }, 1);
      add(`Pekerjaan: ${info.work}`, { size: base }, 1);
      add(`Kegiatan: ${info.activity}`, { size: base }, 2);
      add(info.date, { size: base }, 1);
      add(info.time, { bold: true, size: base }, 1);
      add(`Lokasi: ${info.lat}, ${info.lon} (±${info.acc} m)`, { size: Math.round(base * 0.95) }, 2);
      if (rows.length * lh <= H * CFG.TEXT_MAX_H) break;
      base = Math.round(base * 0.9);
    }

    const shadowOn = () => {
      ctx.shadowColor = CFG.SHADOW;
      ctx.shadowBlur = Math.max(2, Math.round(base * 0.18));
      ctx.shadowOffsetX = Math.max(1, Math.round(base * 0.06));
      ctx.shadowOffsetY = Math.max(1, Math.round(base * 0.06));
    };
    const shadowOff = () => {
      ctx.shadowColor = "rgba(0,0,0,0)";
      ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
    };
    ctx.textBaseline = "top";

    // 1) Blok teks di kiri bawah (tanpa kotak latar, bayangan tipis)
    const top = H - pad - rows.length * lh;
    shadowOn();
    ctx.fillStyle = "#ffffff";
    rows.forEach((r, i) => {
      ctx.font = `${r.bold ? "bold " : ""}${r.size}px sans-serif`;
      ctx.fillText(r.t, pad, top + i * lh + Math.round((lh - r.size) / 2));
    });

    // 2) Label CHECK-IN / CHECK-OUT di kiri atas
    const label = info.isCheckIn ? "CHECK-IN" : "CHECK-OUT";
    const fs = Math.round(base * 1.05);
    ctx.font = `bold ${fs}px sans-serif`;
    const tw = ctx.measureText(label).width;
    if (CFG.LABEL_AS_PILL) {
      shadowOff();
      const px = Math.round(fs * 0.7), ph = Math.round(fs * 1.7);
      ctx.fillStyle = info.isCheckIn ? "#15803d" : "#c2410c";
      ctx.fillRect(pad, pad, tw + px * 2, ph);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(label, pad + px, pad + Math.round((ph - fs) / 2));
    } else {
      ctx.fillStyle = "#ffffff";
      ctx.fillText(label, pad, pad);
    }

    // 3) Logo perusahaan di kanan atas (tanpa latar dan tanpa bayangan)
    shadowOff();
    if (logo) {
      const sc = Math.min((W * CFG.LOGO_MAX_W) / logo.width, (H * CFG.LOGO_MAX_H) / logo.height);
      const lw = Math.round(logo.width * sc), lhh = Math.round(logo.height * sc);
      ctx.drawImage(logo, W - pad - lw, pad, lw, lhh);
    }

    return { pad, lh, rows, top, base };
  }

  async function toBitmap(blob) {
    if (typeof createImageBitmap === "function") {
      try { return await createImageBitmap(blob); } catch (e) { /* coba cara lain */ }
    }
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Foto tidak dapat dibaca."));
      img.src = URL.createObjectURL(blob);
    });
  }

  // ---------- Proses utama ----------
  async function applyStamp(loc) {
    if (typeof capturedBlob === "undefined" || !capturedBlob) return;

    const source = last && capturedBlob === last.stamped ? last.orig : capturedBlob;
    const isCheckIn = typeof currentCheckType === "undefined" || currentCheckType === "check_in";
    const { date, time } = fmtDateTime(clockNow());

    const [work, activity, logo] = await Promise.all([getWorkName(), getActivity(isCheckIn), loadLogo()]);
    const name = (typeof currentProfile !== "undefined" && currentProfile && currentProfile.full_name) ||
                 (typeof currentUser !== "undefined" && currentUser && currentUser.email) || "-";

    const bitmap = await toBitmap(source);
    const W = bitmap.width, H = bitmap.height;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    render(canvas.getContext("2d"), W, H, bitmap, logo, {
      name, work, activity, date, time, isCheckIn,
      lat: fmtCoord(loc.lat), lon: fmtCoord(loc.lon), acc: Math.round(loc.accuracy || 0)
    });
    if (bitmap.close) bitmap.close();

    const stamped = await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob gagal"))), "image/jpeg", CFG.JPEG_QUALITY));

    last = { orig: source, stamped };
    capturedBlob = stamped;     // app.js akan mengunggah foto yang sudah bercap
  }

  // ---------- Pasang pembungkus pada getLocation() ----------
  function install() {
    if (typeof window.getLocation !== "function") {
      console.warn("[stempel-foto] getLocation() tidak ditemukan. Pastikan stempel-foto.js dimuat setelah app.js.");
      return;
    }
    if (window.getLocation.__stamped) return;
    const original = window.getLocation;

    const wrapped = async function () {
      const loc = await original.apply(this, arguments);
      try {
        await applyStamp(loc);
      } catch (e) {
        console.error("[stempel-foto]", e);
        if (!CFG.FAIL_OPEN) throw new Error("Gagal membuat stempel pada foto. Ambil foto ulang lalu coba lagi.");
      }
      return loc;
    };
    wrapped.__stamped = true;
    window.getLocation = wrapped;
  }

  if (typeof window !== "undefined") install();

  // Hanya untuk pengujian di Node
  if (typeof module !== "undefined") module.exports = { fmtDateTime, wrapText, render, applyStamp, install, _cfg: CFG };
})();
