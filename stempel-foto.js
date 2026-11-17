// stempel-foto.js
// Menempelkan STEMPEL pada foto selfie absensi sebelum diunggah:
//   logo perusahaan, nama karyawan, nama pekerjaan, kegiatan, tanggal & jam,
//   koordinat lokasi (+akurasi GPS), dan jenis absensi (CHECK-IN / CHECK-OUT).
// Stempel dibuat oleh aplikasi (bukan aplikasi kamera pihak ketiga), jadi seragam di semua HP
// dan tidak bisa diubah pengguna. Waktu mengikuti jam server bila jam-server.js terpasang.
//
// Cara pasang: di index.html, SETELAH <script src="app.js"></script> (dan setelah jam-server.js
// bila dipakai) tambahkan:
//   <script src="stempel-foto.js"></script>
// File ini tidak mengubah app.js. Caranya: membungkus fungsi getLocation() milik app.js.
// Fungsi itu dipanggil tepat sebelum foto diunggah, sehingga koordinat pada stempel
// sama persis dengan koordinat yang tersimpan di database.
//
// Opsional: stempel-foto.sql (fungsi agar karyawan bisa membaca Nama Pekerjaan miliknya sendiri).

(function () {
  const CFG = {
    TIMEZONE: "Asia/Makassar",          // Asia/Jakarta = WIB, Asia/Makassar = WITA, Asia/Jayapura = WIT
    ZONE_LABELS: { "Asia/Jakarta": "WIB", "Asia/Makassar": "WITA", "Asia/Jayapura": "WIT" },
    LOGO_CANDIDATES: ["#headerLogo", "Logo Palma.png", "icon-192.png"],   // dicoba berurutan
    JPEG_QUALITY: 0.85,
    FAIL_OPEN: false      // false = absensi dibatalkan bila stempel gagal dibuat; true = tetap kirim tanpa stempel
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

    let base = Math.max(13, Math.round(W * 0.03));
    let layout;
    for (let attempt = 0; attempt < 5; attempt++) {
      const pad = Math.round(base * 0.7), lh = Math.round(base * 1.3);
      const logoSize = logo ? Math.round(lh * 3.2) : 0;
      const textX = pad + (logoSize ? logoSize + pad : 0);
      const maxW = W - textX - pad;

      const rows = [];
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

      const panelH = pad * 2 + rows.length * lh;
      layout = { pad, lh, logoSize, textX, rows, panelH };
      if (panelH <= H * 0.5) break;
      base = Math.round(base * 0.88);
    }

    const { pad, lh, logoSize, textX, rows, panelH } = layout;
    const top = H - panelH;

    // Panel gelap semi-transparan di bagian bawah
    ctx.fillStyle = "rgba(0,0,0,0.62)";
    ctx.fillRect(0, top, W, panelH);

    // Logo (latar putih agar terlihat di panel gelap)
    if (logo) {
      const box = logoSize;
      const y = top + Math.round((panelH - box) / 2);
      ctx.fillStyle = "rgba(255,255,255,0.94)";
      ctx.fillRect(pad, y, box, box);
      const inner = Math.round(box * 0.86);
      const s = Math.min(inner / logo.width, inner / logo.height);
      const lw = Math.round(logo.width * s), lhh = Math.round(logo.height * s);
      ctx.drawImage(logo, pad + Math.round((box - lw) / 2), y + Math.round((box - lhh) / 2), lw, lhh);
    }

    // Teks
    ctx.textBaseline = "top";
    ctx.fillStyle = "#ffffff";
    rows.forEach((r, i) => {
      ctx.font = `${r.bold ? "bold " : ""}${r.size}px sans-serif`;
      ctx.fillText(r.t, textX, top + pad + i * lh + Math.round((lh - r.size) / 2));
    });

    // Label jenis absensi di pojok kanan atas foto
    const label = info.isCheckIn ? "CHECK-IN" : "CHECK-OUT";
    const fs = Math.round(base * 1.05);
    ctx.font = `bold ${fs}px sans-serif`;
    const tw = ctx.measureText(label).width, px = Math.round(fs * 0.7), ph = Math.round(fs * 1.7);
    ctx.fillStyle = info.isCheckIn ? "#15803d" : "#c2410c";
    ctx.fillRect(W - tw - px * 2 - pad, pad, tw + px * 2, ph);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(label, W - tw - px - pad, pad + Math.round((ph - fs) / 2));

    return layout;
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
