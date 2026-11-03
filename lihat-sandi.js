// lihat-sandi.js
// Menambahkan tombol mata (tampilkan / sembunyikan) pada SEMUA kolom kata sandi:
// halaman Masuk, Daftar akun, Lupa kata sandi, dan Ubah kata sandi di Profil.
// Berdiri sendiri: tidak mengubah app.js maupun index.html (kecuali satu baris <script>).
//
// Cara pasang: di index.html, setelah <script src="app.js"></script> tambahkan
//   <script src="lihat-sandi.js"></script>

(function () {
  const AUTO_HIDE_MS = 30 * 1000;   // otomatis disembunyikan lagi setelah 30 detik

  const SVG_OPEN = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/>' +
    '<circle cx="12" cy="12" r="3"/></svg>';
  const SVG_OFF = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20C5 20 1 12 1 12a18.5 18.5 0 0 1 5.06-5.94"/>' +
    '<path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>' +
    '<path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

  const BTN_STYLE = [
    "position:absolute", "right:6px", "top:50%", "transform:translateY(-50%)",
    "width:36px !important", "height:36px !important", "min-width:0 !important",
    "padding:0 !important", "margin:0 !important",
    "display:flex !important", "align-items:center", "justify-content:center",
    "background:transparent !important", "border:0 !important", "border-radius:6px",
    "box-shadow:none !important", "color:#64748b !important", "cursor:pointer", "line-height:1"
  ].join(";");

  function enhance(input) {
    if (!input || input.dataset.pwToggle === "1") return;
    input.dataset.pwToggle = "1";

    const wrap = document.createElement("div");
    wrap.className = "pw-wrap";
    wrap.style.cssText = "position:relative; display:block; width:100%;";
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    input.style.boxSizing = "border-box";
    input.style.paddingRight = "46px";   // ruang untuk ikon agar teks tidak tertimpa

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pw-toggle";
    btn.style.cssText = BTN_STYLE;
    wrap.appendChild(btn);

    let timer = null;

    function place() {
      // Sejajarkan ikon dengan tengah kolom (aman walau input punya margin)
      if (input.offsetHeight) btn.style.top = (input.offsetTop + input.offsetHeight / 2) + "px";
    }

    function setVisible(show) {
      let s = null, e = null;
      try { s = input.selectionStart; e = input.selectionEnd; } catch (err) { /* abaikan */ }
      input.type = show ? "text" : "password";
      btn.innerHTML = show ? SVG_OFF : SVG_OPEN;
      const label = show ? "Sembunyikan kata sandi" : "Tampilkan kata sandi";
      btn.setAttribute("aria-label", label);
      btn.setAttribute("aria-pressed", show ? "true" : "false");
      btn.title = label;
      try { if (s !== null) input.setSelectionRange(s, e); } catch (err) { /* abaikan */ }
      clearTimeout(timer);
      if (show) timer = setTimeout(() => setVisible(false), AUTO_HIDE_MS);
      place();
    }

    // Jaga fokus pada kolom saat tombol disentuh (keyboard HP tidak tertutup)
    btn.addEventListener("pointerdown", (ev) => ev.preventDefault());
    btn.addEventListener("click", () => setVisible(input.type === "password"));

    // Sembunyikan lagi saat pengguna meninggalkan aplikasi / berpindah tab
    document.addEventListener("visibilitychange", () => { if (document.hidden && input.type === "text") setVisible(false); });

    input.addEventListener("focus", place);
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(place).observe(input);
    setVisible(false);
  }

  function scan() {
    document.querySelectorAll('input[type="password"]:not([data-pw-toggle])').forEach(enhance);
  }

  function init() {
    scan();
    // Kolom kata sandi yang ditambahkan belakangan juga ikut dipasangi tombol
    if (typeof MutationObserver !== "undefined") new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
  }

  // Hanya untuk pengujian di Node
  if (typeof module !== "undefined") module.exports = { scan, enhance };
})();
