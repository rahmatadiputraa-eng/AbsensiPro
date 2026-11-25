// stempel-foto.js
// Menempelkan STEMPEL pada foto selfie absensi sebelum diunggah (tanpa kotak latar):
//   - Pojok kiri atas   : label CHECK-IN / CHECK-OUT
//   - Pojok kanan atas  : logo perusahaan (PU_APN_K3.png)
//   - Pojok kanan bawah : peta lokasi (OpenStreetMap) dengan pin di posisi saat absen
//   - Kiri bawah        : nama karyawan, nama pekerjaan, kegiatan, tanggal & jam,
//                         koordinat lokasi (+akurasi GPS) -> teks putih dengan bayangan tipis
// Pekerjaan dan kegiatan yang panjang ditulis penuh (turun ke baris berikutnya); bila terlalu
// panjang, ukuran huruf mengecil otomatis agar semuanya tetap terlihat.
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
// Peta: gambar peta diambil dari tile OpenStreetMap saat absen (butuh internet, 1-4 gambar kecil).
// Bila peta gagal dimuat, stempel tetap dibuat tanpa peta dan absensi tidak terhalang.
// Opsional: stempel-foto.sql (fungsi agar karyawan bisa membaca Nama Pekerjaan miliknya sendiri).

(function () {
  const CFG = {
    TIMEZONE: "Asia/Makassar",          // Asia/Jakarta = WIB, Asia/Makassar = WITA, Asia/Jayapura = WIT
    ZONE_LABELS: { "Asia/Jakarta": "WIB", "Asia/Makassar": "WITA", "Asia/Jayapura": "WIT" },
    LOGO_CANDIDATES: ["PU_APN_K3.png", "#headerLogo", "Logo Palma.png", "icon-192.png"],   // dicoba berurutan
    LOGO_MAX_W: 0.36,       // lebar logo maksimal = 36% lebar foto
    LOGO_MAX_H: 0.16,       // tinggi logo maksimal = 16% tinggi foto
    TEXT_SIZE: 0.025,       // ukuran huruf = 2,5% lebar foto (sebelumnya 2,9%)
    MIN_TEXT_SIZE: 0.016,   // batas terkecil bila teks sangat panjang
    TEXT_MAX_H: 0.45,       // blok teks maksimal 45% tinggi foto (huruf mengecil otomatis bila lebih)
    SHADOW: "rgba(0,0,0,0.7)",
    LABEL_AS_PILL: true,    // true = label CHECK-IN/OUT berlatar warna; false = teks putih biasa
    MAP_ENABLED: true,      // false = tanpa peta
    MAP_SIZE: 0.25,         // sisi peta = 25% lebar foto
    MAP_ZOOM: 17,           // 17 = sekitar 300 m lebar peta; 18 = lebih dekat, 16 = lebih luas
    MAP_TIMEOUT_MS: 4000,   // batas waktu memuat gambar peta
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

  // ---------- Peta (tile OpenStreetMap) ----------
  const tileCache = new Map();

  function worldPx(lat, lon, z) {
    const n = Math.pow(2, z);
    const x = ((lon + 180) / 360) * n;
    const rad = (lat * Math.PI) / 180;
    const y = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
    return { x: x * 256, y: y * 256, n };
  }

  function loadTile(z, tx, ty) {
    const key = `${z}/${tx}/${ty}`;
    if (tileCache.has(key)) return tileCache.get(key);
    if (tileCache.size > 40) tileCache.clear();
    const p = new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";      // tanpa CORS, gambar gagal dimuat (kanvas tidak "tercemar")
      const timer = setTimeout(() => resolve(null), CFG.MAP_TIMEOUT_MS);
      img.onload = () => { clearTimeout(timer); resolve(img.width ? img : null); };
      img.onerror = () => { clearTimeout(timer); resolve(null); };
      img.src = `https://tile.openstreetmap.org/${key}.png`;
    }).then((img) => { if (!img) tileCache.delete(key); return img; });
    tileCache.set(key, p);
    return p;
  }

  // Menghasilkan kanvas 256x256 berisi peta dengan titik lokasi tepat di tengah (atau null bila gagal)
  async function buildMap(lat, lon) {
    if (!CFG.MAP_ENABLED || !isFinite(lat) || !isFinite(lon)) return null;
    const z = CFG.MAP_ZOOM, S = 256;
    const c = worldPx(lat, lon, z);
    const left = c.x - S / 2, top = c.y - S / 2;
    const tx0 = Math.floor(left / 256), tx1 = Math.floor((left + S - 1) / 256);
    const ty0 = Math.floor(top / 256), ty1 = Math.floor((top + S - 1) / 256);

    const jobs = [];
    for (let ty = ty0; ty <= ty1; ty++) {
      if (ty < 0 || ty >= c.n) continue;
      for (let tx = tx0; tx <= tx1; tx++) {
        const wx = ((tx % c.n) + c.n) % c.n;
        jobs.push(loadTile(z, wx, ty).then((img) => ({ img, dx: tx * 256 - left, dy: ty * 256 - top })));
      }
    }
    const tiles = await Promise.all(jobs);
    if (!tiles.some((t) => t.img)) return null;

    const cv = document.createElement("canvas");
    cv.width = S; cv.height = S;
    const g = cv.getContext("2d");
    g.fillStyle = "#e5e7eb"; g.fillRect(0, 0, S, S);
    tiles.forEach((t) => { if (t.img) g.drawImage(t.img, Math.round(t.dx), Math.round(t.dy)); });
    return cv;
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

  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    ctx.lineTo(x + w, y + h - r);
    ctx.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    ctx.lineTo(x + r, y + h);
    ctx.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    ctx.lineTo(x, y + r);
    ctx.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
    ctx.closePath();
  }

  // Pin merah; ujung bawah pin tepat di (cx, cy) = posisi lokasi
  function drawPin(ctx, cx, cy, r) {
    const d = r * 2.2, hy = cy - d, th = Math.acos(r / d);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx - r * Math.sin(th), hy + r * Math.cos(th));
    ctx.arc(cx, hy, r, Math.PI / 2 + th, Math.PI / 2 - th + Math.PI * 2, false);
    ctx.closePath();
    ctx.fillStyle = "#dc2626"; ctx.fill();
    ctx.lineWidth = Math.max(1.5, r * 0.18); ctx.strokeStyle = "#ffffff"; ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, hy, r * 0.38, 0, Math.PI * 2); ctx.closePath();
    ctx.fillStyle = "#ffffff"; ctx.fill();
  }

  function drawMap(ctx, cv, x, y, size) {
    const rad = Math.round(size * 0.06);
    ctx.save();
    roundRectPath(ctx, x, y, size, size, rad);
    ctx.clip();
    ctx.drawImage(cv, 0, 0, 256, 256, x, y, size, size);
    drawPin(ctx, x + size / 2, y + size / 2, Math.max(6, Math.round(size * 0.07)));
    // Atribusi wajib OpenStreetMap
    const fs = Math.max(8, Math.round(size * 0.05));
    ctx.font = `${fs}px sans-serif`; ctx.textBaseline = "top";
    const label = "© OpenStreetMap";
    const w = Math.ceil(ctx.measureText(label).width + fs * 1.6), h = Math.round(fs * 1.5);
    ctx.fillStyle = "rgba(255,255,255,0.82)"; ctx.fillRect(x + size - w, y + size - h, w, h);
    ctx.fillStyle = "#333333"; ctx.fillText(label, x + size - w + Math.round(fs / 2), y + size - h + Math.round((h - fs) / 2));
    ctx.restore();
    roundRectPath(ctx, x, y, size, size, rad);
    ctx.lineWidth = Math.max(2, Math.round(size * 0.016)); ctx.strokeStyle = "#ffffff"; ctx.stroke();
  }

  function render(ctx, W, H, bitmap, logo, info, mapCanvas) {
    ctx.drawImage(bitmap, 0, 0, W, H);

    const pad = Math.round(W * 0.025);
    const mapSize = mapCanvas ? Math.round(W * CFG.MAP_SIZE) : 0;
    const maxW = W - pad * 2 - (mapSize ? mapSize + pad : 0);     // teks tidak menimpa peta
    const minBase = Math.max(10, Math.round(W * CFG.MIN_TEXT_SIZE));
    const startBase = Math.max(minBase, Math.round(W * CFG.TEXT_SIZE));
    let base = startBase, lh = 0, rows = [];

    const layoutRows = (limits) => {
      const out = [];
      const add = (text, opts, maxLines) => {
        ctx.font = `${opts.bold ? "bold " : ""}${opts.size}px sans-serif`;
        wrapText(ctx, text, maxW, maxLines).forEach((t) => out.push({ t, ...opts }));
      };
      add(info.name, { bold: true, size: Math.round(base * 1.12) }, 2);
      add(`Pekerjaan: ${info.work}`, { size: base }, limits.work);
      add(`Kegiatan: ${info.activity}`, { size: base }, limits.act);
      add(info.date, { size: base }, 1);
      add(info.time, { bold: true, size: base }, 1);
      add(`Lokasi: ${info.lat}, ${info.lon} (±${info.acc} m)`, { size: Math.round(base * 0.95) }, 2);
      return out;
    };

    // Cari ukuran huruf terbesar yang membuat seluruh teks muat (tanpa dipotong)
    const tryFit = (limits) => {
      base = startBase;
      for (;;) {
        lh = Math.round(base * 1.28);
        rows = layoutRows(limits);
        const ok = rows.length * lh <= H * CFG.TEXT_MAX_H;
        if (ok || base <= minBase) return ok;
        base = Math.max(minBase, Math.round(base * 0.92));
      }
    };
    // Jaring pengaman: hanya bila teks luar biasa panjang, batasi jumlah baris (dengan "…")
    if (!tryFit({ work: Infinity, act: Infinity })) tryFit({ work: 4, act: 7 });

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

    // 0) Peta di kanan bawah (pin = posisi saat absen)
    shadowOff();
    if (mapCanvas) drawMap(ctx, mapCanvas, W - pad - mapSize, H - pad - mapSize, mapSize);

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
    const fs = Math.round(Math.max(base, W * 0.027) * 1.05);
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

    return { pad, lh, rows, top, base, mapSize };
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

    const [work, activity, logo, mapCanvas] = await Promise.all([
      getWorkName(), getActivity(isCheckIn), loadLogo(),
      buildMap(Number(loc.lat), Number(loc.lon)).catch(() => null)
    ]);
    const name = (typeof currentProfile !== "undefined" && currentProfile && currentProfile.full_name) ||
                 (typeof currentUser !== "undefined" && currentUser && currentUser.email) || "-";

    const bitmap = await toBitmap(source);
    const W = bitmap.width, H = bitmap.height;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    render(canvas.getContext("2d"), W, H, bitmap, logo, {
      name, work, activity, date, time, isCheckIn,
      lat: fmtCoord(loc.lat), lon: fmtCoord(loc.lon), acc: Math.round(loc.accuracy || 0)
    }, mapCanvas);
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
  if (typeof module !== "undefined") module.exports = { fmtDateTime, wrapText, render, applyStamp, install, buildMap, worldPx, _cfg: CFG };
})();
