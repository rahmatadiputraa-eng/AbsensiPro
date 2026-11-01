// jam-server.js
// Mencegah absensi jika tanggal/jam HP diubah manual.
// Cara kerja: jam HP dibandingkan dengan jam server Supabase. Jika selisih > 2 menit,
// tombol Check-in, Check-out, dan Kirim absensi diblokir sampai jam HP kembali sesuai.
// Perlindungan kedua ada di database (lihat jam-server.sql), sehingga tetap aman
// walaupun seseorang mencoba melewati kode di browser.
//
// Cara pasang: di index.html, SETELAH <script src="app.js"></script> tambahkan
//   <script src="jam-server.js"></script>
// File ini tidak mengubah app.js sama sekali. Memakai variabel global dari app.js:
//   supabaseClient, currentUser, message (opsional).

(function () {
  const MAX_DRIFT_MS = 2 * 60 * 1000;      // toleransi selisih jam HP vs server
  const RECHECK_EVERY_S = 30;              // verifikasi ulang ke server tiap 30 detik
  const JUMP_TOLERANCE_MS = 30 * 1000;     // lonjakan jam lokal yang dianggap mencurigakan
  const FRESH_MS = 20 * 1000;              // hasil verifikasi dianggap segar untuk kirim absensi

  // checking | ok | bad | error | disabled
  //   disabled = fungsi server_now belum dipasang di Supabase (fitur tidak aktif, tidak memblokir)
  let state = "checking";
  let offsetMs = 0;
  let lastVerifiedPerf = -Infinity;
  let verifying = null;
  let bypass = false;
  let wasLoggedIn = false;
  let sinceVerify = 0;
  let lastDate = Date.now(), lastPerf = performance.now();

  const GUARDED = ["btnCheckIn", "btnCheckOut", "attendanceBtn"];
  const $id = (id) => document.getElementById(id);
  const isLoggedIn = () => typeof currentUser !== "undefined" && !!currentUser;
  const guardActive = () => state !== "ok" && state !== "disabled";

  function fmtDiff(ms) {
    const s = Math.round(Math.abs(ms) / 1000);
    if (s < 90) return `${s} detik`;
    const m = Math.round(s / 60);
    if (m < 90) return `${m} menit`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h} jam`;
    return `${Math.round(h / 24)} hari`;
  }

  function messageText() {
    if (state === "bad") {
      return `Tanggal/jam HP Anda tidak sesuai dengan waktu server (selisih sekitar ${fmtDiff(offsetMs)}). ` +
             `Aktifkan "Tanggal & waktu otomatis" di Pengaturan HP, lalu tekan Periksa Ulang.`;
    }
    if (state === "error") {
      return "Tidak dapat memverifikasi waktu server. Periksa koneksi internet Anda, lalu tekan Periksa Ulang.";
    }
    return "Memeriksa waktu perangkat…";
  }

  // ---------- Verifikasi ke server ----------
  function verify() {
    if (verifying) return verifying;
    verifying = (async () => {
      try {
        const t0 = Date.now();
        const { data, error } = await supabaseClient.rpc("server_now");
        const t1 = Date.now();
        if (error) {
          // Fungsi belum dibuat di Supabase: jangan blokir semua orang
          if (error.code === "PGRST202" || /could not find the function/i.test(error.message || "")) {
            state = "disabled";
            console.warn("[jam-server] Fungsi server_now belum ada. Jalankan jam-server.sql di Supabase.");
            return true;
          }
          throw error;
        }
        if (!data) throw new Error("Respons waktu server kosong.");
        offsetMs = new Date(data).getTime() - (t0 + t1) / 2;   // selisih jam server - jam HP
        state = Math.abs(offsetMs) <= MAX_DRIFT_MS ? "ok" : "bad";
        lastVerifiedPerf = performance.now();
        lastDate = Date.now(); lastPerf = performance.now();
      } catch (e) {
        state = "error";
      }
      return state === "ok" || state === "disabled";
    })().finally(() => { verifying = null; render(); });
    return verifying;
  }

  // ---------- Tampilan ----------
  function ensureBanner() {
    let b = $id("clockGuardBanner");
    if (b) return b;
    const anchor = $id("btnCheckIn");
    if (!anchor || !anchor.parentElement) return null;
    b = document.createElement("div");
    b.id = "clockGuardBanner";
    b.className = "hidden";
    b.setAttribute("role", "alert");
    b.style.cssText = "margin:0 0 0.75rem; padding:10px 12px; border-radius:8px; background:#fef2f2; " +
                      "border:1px solid #fecaca; color:#991b1b; font-size:0.9rem;";
    b.innerHTML = `<span id="clockGuardText"></span>
      <button type="button" id="clockGuardRetry" class="secondary" style="margin-top:6px; display:block;">Periksa Ulang</button>`;
    anchor.parentElement.before(b);
    $id("clockGuardRetry").onclick = () => { state = "checking"; render(); verify(); };
    return b;
  }

  function render() {
    const blocked = isLoggedIn() && guardActive();

    GUARDED.forEach((id) => {
      const el = $id(id);
      if (!el) return;
      if (blocked) {
        if (!el.disabled) { el.disabled = true; el.dataset.clockGuard = "1"; }
      } else if (el.dataset.clockGuard === "1") {
        el.disabled = false;
        delete el.dataset.clockGuard;
      }
    });

    const banner = ensureBanner();
    if (!banner) return;
    if (blocked) {
      $id("clockGuardText").textContent = (state === "bad" || state === "error" ? "⚠️ " : "") + messageText();
      $id("clockGuardRetry").classList.toggle("hidden", state === "checking");
      banner.classList.remove("hidden");
    } else {
      banner.classList.add("hidden");
    }
  }

  function showBlockedMessage() {
    const text = state === "bad" || state === "error" ? messageText() : "Sedang memeriksa waktu perangkat. Coba lagi sebentar.";
    if (typeof message === "function" && $id("attendanceMsg")) message("attendanceMsg", text, true);
  }

  // ---------- Blokir klik (fase capture: berjalan sebelum handler milik app.js) ----------
  document.addEventListener("click", (ev) => {
    const btn = ev.target && ev.target.closest ? ev.target.closest("#btnCheckIn, #btnCheckOut, #attendanceBtn") : null;
    if (!btn || bypass || !isLoggedIn()) return;

    if (guardActive()) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      showBlockedMessage();
      return;
    }

    // Pengecekan terakhir tepat sebelum absensi dikirim
    if (btn.id === "attendanceBtn" && state === "ok" && performance.now() - lastVerifiedPerf > FRESH_MS) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      verify().then((ok) => {
        if (ok) { bypass = true; try { btn.click(); } finally { bypass = false; } }
        else showBlockedMessage();
      });
    }
  }, true);

  // ---------- Pemantau berkala ----------
  function tick() {
    const nowLoggedIn = isLoggedIn();

    if (nowLoggedIn && !wasLoggedIn) { state = "checking"; sinceVerify = 0; verify(); }   // baru login
    if (!nowLoggedIn && wasLoggedIn) { state = "checking"; }                              // logout
    wasLoggedIn = nowLoggedIn;

    if (nowLoggedIn) {
      // Deteksi jam diubah saat aplikasi terbuka: jam dinding melompat, jam monotonik tidak
      const dDate = Date.now() - lastDate, dPerf = performance.now() - lastPerf;
      lastDate = Date.now(); lastPerf = performance.now();
      if (Math.abs(dDate - dPerf) > JUMP_TOLERANCE_MS && state !== "disabled") {
        state = "checking"; sinceVerify = 0; verify();
      } else if (++sinceVerify >= RECHECK_EVERY_S) {
        sinceVerify = 0; verify();
      }
    }
    render();
  }

  if (typeof document !== "undefined") {
    setInterval(tick, 1000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden && isLoggedIn()) verify(); });
  }

  // Dipakai fitur lain bila perlu: window.ClockGuard.serverNow()
  const api = {
    verify,
    state: () => state,
    offset: () => offsetMs,
    serverNow: () => new Date(Date.now() + offsetMs)
  };
  if (typeof window !== "undefined") window.ClockGuard = api;

  // Hanya untuk pengujian di Node
  if (typeof module !== "undefined") module.exports = { ...api, _tick: tick };
})();
