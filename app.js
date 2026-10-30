const SUPABASE_URL = "https://lfkzcrrjfkhuwkiqzstb.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_ZypkjbI-gMZtJuHuwta1pw_nuZbfkqo";

const configured = !SUPABASE_URL.startsWith("GANTI_") && !SUPABASE_PUBLISHABLE_KEY.startsWith("GANTI_");
const $ = (id) => document.getElementById(id);

let supabaseClient = null;
let currentUser = null;
let currentProfile = null;
let allEmployees = [];
let lastRecapData = [];
let lastRecapMeta = { from: "", to: "", keyword: "" };
const photoThumbCache = new Map();                     

// Variabel untuk kamera & jam live
let mediaStream = null;
let capturedBlob = null;
let currentCheckType = "check_in";
let clockInterval = null;


function message(id, text, error=false) {
  const el = $(id); 
  if(el){ el.textContent = text; el.style.color = error ? "#b91c1c" : "#0e7490"; }
}

function show(el, yes=true){ 
  const elem = $(el); 
  if(elem) elem.classList.toggle("hidden", !yes); 
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

function fmtDate(value){ return value ? new Date(value).toLocaleString("id-ID") : "—"; }
function fmtTimeOnly(value){ return value ? new Date(value).toLocaleTimeString("id-ID", {hour: '2-digit', minute:'2-digit'}) : "—"; }
function fmtDateOnly(value){ return value ? new Date(value).toLocaleDateString("id-ID") : "—"; }
function toLocalDateKey(value) {
  if (!value) return "";
  const d = new Date(value);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getLocation() {
  return new Promise((resolve,reject)=>{
    if(!navigator.geolocation) return reject(new Error("Browser tidak mendukung GPS/lokasi."));
    navigator.geolocation.getCurrentPosition(
      p=>resolve({lat:p.coords.latitude, lon:p.coords.longitude, accuracy:p.coords.accuracy}),
      e=>reject(new Error("Lokasi gagal diperoleh. Aktifkan GPS dan izin lokasi. ("+e.message+")")),
      {enableHighAccuracy:true, maximumAge:0, timeout:30000}
    );
  });
}

// --- PETA LOKASI LIVE (Leaflet + OpenStreetMap) ---
let liveMap = null, liveMarker = null, liveAccuracyCircle = null;
let liveWatchId = null, liveFollow = true, liveFirstFix = true;

function setLiveMapStatus(text, error=false) {
  const el = $("liveMapStatus");
  if (el) { el.textContent = text; el.style.color = error ? "#b91c1c" : ""; }
}

function startLiveMap() {
  if (typeof L === "undefined") { setLiveMapStatus("Peta gagal dimuat. Periksa koneksi internet.", true); return; }
  if (!navigator.geolocation) { setLiveMapStatus("Browser tidak mendukung GPS/lokasi.", true); return; }

  if (!liveMap) {
    liveMap = L.map("liveMap", { zoomControl: true }).setView([-2.5, 118], 5);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap"
    }).addTo(liveMap);
    // Pengguna menggeser peta sendiri: hentikan auto-ikuti sampai menekan "Pusatkan"
    liveMap.on("dragstart", () => { liveFollow = false; });
  }
  // Peta dibuat saat kontainer baru ditampilkan; hitung ulang ukurannya
  setTimeout(() => liveMap && liveMap.invalidateSize(), 150);

  if (liveWatchId !== null) return; // sudah berjalan
  liveFirstFix = true;
  liveFollow = true;
  setLiveMapStatus("Mencari lokasi…");

  liveWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      const ll = [latitude, longitude];

      if (!liveMarker) {
        liveMarker = L.circleMarker(ll, { radius: 9, color: "#fff", weight: 3, fillColor: "#2563eb", fillOpacity: 1 }).addTo(liveMap);
        liveAccuracyCircle = L.circle(ll, { radius: accuracy, color: "#2563eb", weight: 1, fillColor: "#2563eb", fillOpacity: 0.12 }).addTo(liveMap);
      } else {
        liveMarker.setLatLng(ll);
        liveAccuracyCircle.setLatLng(ll).setRadius(accuracy);
      }

      if (liveFirstFix) { liveMap.setView(ll, 17); liveFirstFix = false; }
      else if (liveFollow) { liveMap.panTo(ll); }

      const jam = new Date(pos.timestamp).toLocaleTimeString("id-ID");
      const lemah = accuracy > 100 ? " — sinyal GPS lemah, coba di tempat terbuka" : "";
      setLiveMapStatus(`Akurasi ±${Math.round(accuracy)} m • diperbarui ${jam}${lemah}`, accuracy > 100);
    },
    (err) => {
      const msg = err.code === 1
        ? "Izin lokasi ditolak. Aktifkan izin lokasi untuk situs ini di pengaturan browser."
        : err.code === 2 ? "Lokasi tidak tersedia. Pastikan GPS aktif."
        : "Waktu pencarian lokasi habis. Coba lagi.";
      setLiveMapStatus(msg, true);
      stopLiveMap(false);
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
  );
}

function stopLiveMap(clearMarker = false) {
  if (liveWatchId !== null) { navigator.geolocation.clearWatch(liveWatchId); liveWatchId = null; }
  if (clearMarker && liveMap) {
    if (liveMarker) { liveMap.removeLayer(liveMarker); liveMarker = null; }
    if (liveAccuracyCircle) { liveMap.removeLayer(liveAccuracyCircle); liveAccuracyCircle = null; }
    setLiveMapStatus("Mencari lokasi…");
  }
}

if ($("recenterMapBtn")) $("recenterMapBtn").onclick = () => {
  liveFollow = true;
  if (liveMarker && liveMap) { liveMap.setView(liveMarker.getLatLng(), Math.max(liveMap.getZoom(), 17)); }
  else { stopLiveMap(false); startLiveMap(); }   // coba lagi setelah error / izin ditolak
};

async function loadProfile() {
  const {data, error} = await supabaseClient
    .from("profiles")
    .select("id, full_name, email, role, jabatan, nik, phone")
    .eq("id", currentUser.id)
    .single();
  if(error) throw error;
  currentProfile = data;
}

// --- LIVE CLOCK ---
function startLiveClock() {
  function updateClock() {
    const now = new Date();
    const dateOptions = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };
    const dateStr = now.toLocaleDateString('id-ID', dateOptions);
    const timeStr = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' WIB';

    if ($("liveDateStr")) $("liveDateStr").textContent = `📅 ${dateStr}`;
    if ($("liveClockStr")) $("liveClockStr").textContent = `⏰ ${timeStr}`;
  }
  updateClock();
  if (clockInterval) clearInterval(clockInterval);
  clockInterval = setInterval(updateClock, 1000);
}

// --- REFRESH UI ---
async function refreshUI() {
  const registerOpen = !!$("registerPanel") && !$("registerPanel").classList.contains("hidden");
  const forgotOpen = !!$("forgotPanel") && !$("forgotPanel").classList.contains("hidden");
  show("loginPanel", !currentUser && !registerOpen && !forgotOpen);
  if (currentUser) { show("registerPanel", false); show("forgotPanel", false); }
  show("appPanel", !!currentUser);
  if(!currentUser) {
    if (clockInterval) clearInterval(clockInterval);
    return;
  }

  const name = currentProfile?.full_name || currentUser.email;
  const role = currentProfile?.role || "belum diatur";

  const isEmployee = (role === "employee");
  const isAdmin = (role === "admin");

  // Tampilkan logo di header khusus untuk karyawan
  const headerLogo = $("headerLogo");
  if (headerLogo) {
    headerLogo.style.display = isEmployee ? "block" : "none";
  }

  // Ubah teks header atas berdasarkan peran
  if (isEmployee) {
    $("welcome").textContent = "PT. Agrinas Palma Nusantara";
  } else {
    $("welcome").textContent = "Dashboard Admin";
  }
  
  // Tampilkan grup menu sidebar yang sesuai peran
  document.querySelectorAll(".admin-only").forEach(el => el.classList.toggle("hidden", !isAdmin));
  document.querySelectorAll(".emp-item").forEach(el => el.classList.toggle("hidden", !(isEmployee || isAdmin)));

  show("adminArea", isAdmin);

  if(isEmployee || isAdmin) {
    if($("employeeWelcomeMsg")) $("employeeWelcomeMsg").textContent = `Selamat Datang, ${name}!`;
    startLiveClock();
  } else if (clockInterval) clearInterval(clockInterval);

  const savedTab = localStorage.getItem("activeTab");
  const validEmpTabs = ["tabEmpHome", "tabEmpHistory", "tabEmpProfile"];
  const validAdminTabs = ["tabSummary", "tabEmployees", "tabRecap"];

  if(isEmployee) {
    switchEmployeeTab(validEmpTabs.includes(savedTab) ? savedTab : "tabEmpHome");
    await loadEmployeeDashboardStats();
    await loadMyRows();
    loadEmployeeProfileData();
  }

  if(isAdmin) {
    if(validAdminTabs.includes(savedTab)) switchAdminTab(savedTab);
    else switchEmployeeTab(validEmpTabs.includes(savedTab) ? savedTab : "tabEmpHome");
    await loadEmployeesData();
  }
}

// --- KARYAWAN: BERANDA, STATISTIK & KAMERA ---
async function loadEmployeeDashboardStats() {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const {data, error} = await supabaseClient
    .from("attendance")
    .select("created_at, check_type")
    .eq("user_id", currentUser.id)
    .gte("created_at", startOfMonth);

  if(error) return;

  const records = data || [];
  const checkIns = records.filter(r => r.check_type === 'check_in');
  const totalHadir = checkIns.length;

  let totalTerlambat = 0;
  checkIns.forEach(r => {
    const checkInTime = new Date(r.created_at);
    if (checkInTime.getHours() > 8 || (checkInTime.getHours() === 8 && checkInTime.getMinutes() > 0)) {
      totalTerlambat++;
    }
  });

  if($("statHadirBulanIni")) $("statHadirBulanIni").textContent = totalHadir;
  if($("statTerlambatBulanIni")) $("statTerlambatBulanIni").textContent = totalTerlambat;
}

function loadEmployeeProfileData() {
  if(!currentProfile) return;
  if($("profName")) $("profName").textContent = currentProfile.full_name || "-";
  if($("profJabatan")) $("profJabatan").textContent = currentProfile.jabatan || "Belum diatur";
  if($("profEmail")) $("profEmail").textContent = currentProfile.email || currentUser.email || "-";
  if($("profNik")) $("profNik").textContent = currentProfile.nik || "Belum diatur";
  if($("profPhone")) $("profPhone").textContent = currentProfile.phone || "Belum diatur";
}

async function loadMyRows() {
  const {data, error} = await supabaseClient.from("attendance").select("id,created_at,check_type,activity,latitude,longitude,photo_path").eq("user_id", currentUser.id).order("created_at",{ascending:false}).limit(30);
  if(error){ message("attendanceMsg", error.message, true); return; }
  
  if ($("myRows")) {
    $("myRows").innerHTML = (data||[]).map(r=>`
      <tr>
        <td>${escapeHtml(fmtDate(r.created_at))}</td>
        <td>${r.check_type==="check_in"?"Check-in":"Check-out"}</td>
        <td>${escapeHtml(r.activity||"-")}</td>
        <td>${Number(r.latitude).toFixed(5)}, ${Number(r.longitude).toFixed(5)}</td>
        <td>${r.photo_path?`<button type="button" class="secondary" data-photo="${escapeHtml(r.photo_path)}">Lihat foto</button>`:"—"}</td>
      </tr>
    `).join("");
    $("myRows").querySelectorAll("[data-photo]").forEach(b=>b.onclick=()=>openPhoto(b.dataset.photo));
  }
}

async function openPhoto(path) {
  const {data, error} = await supabaseClient.storage.from("attendance-photos").createSignedUrl(path, 60);
  if(error){ alert("Foto tidak dapat dibuka: "+error.message); return; }
  window.open(data.signedUrl, "_blank", "noopener");
}

// Bersihkan semua sisa sesi sebelumnya (foto, kegiatan, pesan, tabel) agar tidak terbawa ke akun lain
function resetAttendanceForm() {
  stopLiveMap(true);
  const prev = $("photoPreview");
  if (prev && prev.src && prev.src.startsWith("blob:")) { try { URL.revokeObjectURL(prev.src); } catch(e) {} }
  capturedBlob = null;
  currentCheckType = "check_in";
  if (prev) { prev.removeAttribute("src"); }
  if ($("selfieInput")) $("selfieInput").value = "";
  if ($("activityInput")) $("activityInput").value = "";
  show("photoPreview", false);
  show("captureBtn", false);
  show("retakeBtn", false);
  show("attendanceBtn", false);
  show("cameraSection", false);
  show("activityGroup", false);
  show("camInstruction", true);
  message("attendanceMsg", "");
  if ($("myRows")) $("myRows").innerHTML = "";
  ["curPassword", "chgPassword", "chgPassword2"].forEach(id => { if ($(id)) $(id).value = ""; });
  message("changePwMsg", "");
}

function initCamera(type) {
  currentCheckType = type;
  const isCheckIn = (type === "check_in");

  // Reset foto sebelumnya bila pengguna berganti antara check-in / check-out
  capturedBlob = null;
  if ($("photoPreview")) { $("photoPreview").src = ""; }
  if ($("selfieInput")) { $("selfieInput").value = ""; }

  show("activityGroup", isCheckIn);
  show("cameraSection", true);
  show("camInstruction", false);
  show("photoPreview", false);
  show("captureBtn", true);
  show("retakeBtn", false);
  show("attendanceBtn", false);
  message("attendanceMsg", `Klik "Ambil Foto Selfie" untuk membuka kamera depan (${isCheckIn ? "Check-in" : "Check-out"}).`);
}

if ($("btnCheckIn")) $("btnCheckIn").onclick = () => initCamera("check_in");
if ($("btnCheckOut")) $("btnCheckOut").onclick = () => initCamera("check_out");

// Tombol ini membuka aplikasi kamera bawaan HP (kamera depan)
function openNativeCamera() {
  const input = $("selfieInput");
  if (!input) return;
  input.value = "";   // supaya memilih/mengambil foto yang sama tetap memicu event change
  input.click();
}
if ($("captureBtn")) $("captureBtn").onclick = openNativeCamera;
if ($("retakeBtn")) $("retakeBtn").onclick = openNativeCamera;

// Perkecil foto (maks 1024px) agar unggahan cepat & hemat kuota
async function compressImage(file, maxSide = 1024, quality = 0.8) {
  let bitmap;
  if (window.createImageBitmap) {
    try { bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }); } catch (e) {}
  }
  if (!bitmap) {
    bitmap = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("File gambar tidak dapat dibaca."));
      img.src = URL.createObjectURL(file);
    });
  }
  const w = bitmap.width, h = bitmap.height;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  if (bitmap.close) bitmap.close();
  return await new Promise((resolve, reject) => {
    canvas.toBlob(b => b ? resolve(b) : reject(new Error("Gagal memproses foto.")), "image/jpeg", quality);
  });
}

if ($("selfieInput")) $("selfieInput").onchange = async (ev) => {
  const file = ev.target.files && ev.target.files[0];
  if (!file) { message("attendanceMsg", "Pengambilan foto dibatalkan. Klik \"Ambil Foto Selfie\" untuk mencoba lagi.", true); return; }
  if (!file.type.startsWith("image/")) { message("attendanceMsg", "File harus berupa foto.", true); return; }

  // Foto harus baru diambil (bukan foto lama dari galeri)
  if (file.lastModified && Date.now() - file.lastModified > 10 * 60 * 1000) {
    message("attendanceMsg", "Foto terlalu lama. Silakan ambil foto selfie yang baru langsung dari kamera.", true);
    ev.target.value = "";
    return;
  }

  try {
    message("attendanceMsg", "Memproses foto…");
    capturedBlob = await compressImage(file);
    $("photoPreview").src = URL.createObjectURL(capturedBlob);
    show("photoPreview", true);
    show("captureBtn", false);
    show("retakeBtn", true);
    show("attendanceBtn", true);
    message("attendanceMsg", "Foto selfie berhasil diambil. Silakan klik kirim absensi.");
  } catch (e) {
    capturedBlob = null;
    message("attendanceMsg", e.message || "Gagal memproses foto.", true);
  }
};

async function submitAttendance() {
  const isCheckIn = (currentCheckType === "check_in");
  const activity = isCheckIn ? $("activityInput").value.trim() : "-";

  if (!capturedBlob) {
    message("attendanceMsg", "Harap ambil foto selfie terlebih dahulu.", true);
    return;
  }
  if (isCheckIn && !activity) {
    message("attendanceMsg", "Harap isi kegiatan / pekerjaan utama Anda.", true);
    return;
  }

  $("attendanceBtn").disabled = true;
  try {
    message("attendanceMsg", "Meminta lokasi GPS…");
    const loc = await getLocation();
    
    const path = `${currentUser.id}/${Date.now()}-${crypto.randomUUID()}.jpg`;
    message("attendanceMsg", "Mengunggah foto selfie…");
    
    const { error: uploadError } = await supabaseClient.storage.from("attendance-photos").upload(path, capturedBlob, { contentType: "image/jpeg", upsert: false });
    if (uploadError) throw uploadError;

    const { error } = await supabaseClient.from("attendance").insert({
      user_id: currentUser.id, 
      check_type: currentCheckType,
      activity: activity,
      latitude: loc.lat, 
      longitude: loc.lon, 
      accuracy_m: loc.accuracy,
      photo_path: path, 
      client_captured_at: new Date().toISOString()
    });

    if (error) {
      await supabaseClient.storage.from("attendance-photos").remove([path]);
      throw error;
    }

    message("attendanceMsg", `Absensi ${isCheckIn ? 'Check-in' : 'Check-out'} berhasil tersimpan! Akurasi GPS: ${Math.round(loc.accuracy)} meter.`);
    
    capturedBlob = null;
    $("photoPreview").src = "";
    show("photoPreview", false);
    show("cameraSection", false);
    show("camInstruction", true);
    show("attendanceBtn", false);
    if (isCheckIn) $("activityInput").value = "";
    
    await loadEmployeeDashboardStats();
    await loadMyRows();
  } catch(e) {
    message("attendanceMsg", e.message || "Absensi gagal disimpan.", true);
  } finally {
    $("attendanceBtn").disabled = false;
  }
}

if ($("attendanceBtn")) $("attendanceBtn").onclick = submitAttendance;

// --- NAVIGASI TAB KARYAWAN & ADMIN ---
function setActiveNav(targetId) {
  // Simpan tab aktif agar tetap sama setelah berpindah tab browser / reload
  try { localStorage.setItem("activeTab", targetId); } catch(e) {}
  document.querySelectorAll(".nav-item[data-target]").forEach(b =>
    b.classList.toggle("active", b.dataset.target === targetId)
  );
}

function switchEmployeeTab(targetId) {
  document.querySelectorAll(".admin-tab-content").forEach(el => el.classList.add("hidden"));
  document.querySelectorAll(".emp-tab-content").forEach(el => el.classList.add("hidden"));
  show(targetId, true);
  setActiveNav(targetId);
  if(targetId === "tabEmpHome") { loadEmployeeDashboardStats(); startLiveMap(); }
  else stopLiveMap(false);   // hemat baterai saat bukan di Beranda
  if(targetId === "tabEmpHistory") loadMyRows();
  if(targetId === "tabEmpProfile") loadEmployeeProfileData();
}

function switchAdminTab(targetId) {
  // Sembunyikan semua tab admin, lalu tampilkan hanya tab yang dituju
  document.querySelectorAll(".admin-tab-content").forEach(el => el.classList.add("hidden"));
  document.querySelectorAll(".emp-tab-content").forEach(el => el.classList.add("hidden"));
  stopLiveMap(false);
  show(targetId, true);
  setActiveNav(targetId);

  // Muat data sesuai tab yang aktif
  if(targetId === "tabSummary") loadSummaryData();
  if(targetId === "tabEmployees") loadEmployeesData();
  if(targetId === "tabRecap") loadRecapData();
}

// --- ADMIN TABS & DASHBOARD ---
async function loadSummaryData() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  console.log("Memuat ulang data ringkasan...");
  
  const { data, error } = await supabaseClient.from("attendance")
    .select("id, created_at, check_type, activity, photo_path, profiles(full_name, email)")
    .gte("created_at", todayStart.toISOString())
    .order("created_at", { ascending: false });
  
  if (error) {
    console.error("Gagal memuat ringkasan:", error.message);
    return;
  }

  const rows = data || [];
  console.log("Jumlah data ringkasan didapat:", rows.length);

  const checkIns = rows.filter(r => r.check_type === 'check_in').length;
  const checkOuts = rows.filter(r => r.check_type === 'check_out').length;
  
  if ($("statCheckIn")) $("statCheckIn").textContent = checkIns;
  if ($("statCheckOut")) $("statCheckOut").textContent = checkOuts;

  if ($("summaryRows")) {
    if (rows.length === 0) {
      $("summaryRows").innerHTML = `<tr><td colspan="5" style="text-align: center; color: #64748b;">Belum ada data absensi hari ini.</td></tr>`;
    } else {
      $("summaryRows").innerHTML = rows.slice(0, 15).map(r => `
        <tr>
          <td>${escapeHtml(fmtTimeOnly(r.created_at))}</td>
          <td>${escapeHtml(r.profiles?.full_name || r.profiles?.email || "-")}</td>
          <td>${r.check_type === "check_in" ? "Check-in" : "Check-out"}</td>
          <td>${escapeHtml(r.activity || "-")}</td>
          <td>${r.photo_path ? `<button type="button" class="secondary" data-photo="${escapeHtml(r.photo_path)}">Foto</button>` : "—"}</td>
        </tr>
      `).join("");
      $("summaryRows").querySelectorAll("[data-photo]").forEach(b => b.onclick = () => openPhoto(b.dataset.photo));
    }
  }
}

// --- MANAJEMEN KARYAWAN ---
async function loadEmployeesData() {
  const {data, error} = await supabaseClient.from("employee_registry").select("*").order("full_name");
  if(error) { alert("Gagal memuat karyawan: "+error.message); return; }
  allEmployees = data || [];
  renderEmployeeTable(allEmployees);
}

function renderEmployeeTable(list) {
  if (!$("employeeRows")) return;
  const roleName = (r) => r === "employee" ? "Karyawan" : r === "admin" ? "Admin" : (r || "-");
  $("employeeRows").innerHTML = list.map(e => `
    <tr>
      <td>${escapeHtml(e.full_name)}</td>
      <td>${escapeHtml(e.email)}</td>
      <td>${escapeHtml(e.jabatan || "-")}</td>
      <td>${escapeHtml(roleName(e.role))}</td>
      <td>${e.user_id ? "Sudah mendaftar" : "Belum mendaftar"}</td>
      <td>
        <button type="button" class="secondary" onclick="editEmployee('${e.id}')">Edit</button>
        <button type="button" class="secondary" style="color:red;" onclick="deleteEmployee('${e.id}')">Hapus</button>
      </td>
    </tr>
  `).join("");
}

if ($("searchEmp")) {
  $("searchEmp").oninput = (e) => {
    const keyword = e.target.value.toLowerCase();
    const filtered = allEmployees.filter(emp => (emp.full_name||"").toLowerCase().includes(keyword) || (emp.email||"").toLowerCase().includes(keyword));
    renderEmployeeTable(filtered);
  };
}

if ($("openAddEmpBtn")) {
  $("openAddEmpBtn").onclick = () => {
    $("modalTitle").textContent = "Tambah Karyawan";
    $("empId").value = "";
    $("empNameInput").value = "";
    $("empEmailInput").value = "";
    $("empEmailInput").disabled = false;
    $("empNikInput").value = "";
    $("empJabatanInput").value = "";
    $("empNamaPekerjaanInput").value = "";
    $("empPhoneInput").value = "";
    $("empRoleInput").value = "employee";
    show("empModal", true);
  };
}

if ($("closeEmpModal")) $("closeEmpModal").onclick = () => show("empModal", false);

window.editEmployee = (id) => {
  const emp = allEmployees.find(x => x.id === id);
  if(!emp) return;
  $("modalTitle").textContent = "Edit Karyawan";
  $("empId").value = emp.id;
  $("empNameInput").value = emp.full_name || "";
  $("empEmailInput").value = emp.email || "";
  $("empEmailInput").disabled = true; // email login tidak diubah dari sini
  $("empNikInput").value = emp.nik || "";
  $("empJabatanInput").value = emp.jabatan || "";
  $("empNamaPekerjaanInput").value = emp.nama_pekerjaan || "";
  $("empPhoneInput").value = emp.phone || "";
  $("empRoleInput").value = emp.role || "employee";
  show("empModal", true);
};

if ($("saveEmpBtn")) {
  $("saveEmpBtn").onclick = async () => {
    const id = $("empId").value;
    const full_name = $("empNameInput").value.trim();
    const email = $("empEmailInput").value.trim().toLowerCase();
    const nik = $("empNikInput").value.trim();
    const jabatan = $("empJabatanInput").value.trim();
    const nama_pekerjaan = $("empNamaPekerjaanInput").value.trim();
    const phone = $("empPhoneInput").value.trim();
    const role = $("empRoleInput").value;

    if(!full_name || !email) { alert("Nama dan email wajib diisi!"); return; }

    const fields = { full_name, nik: nik || null, jabatan: jabatan || null, nama_pekerjaan: nama_pekerjaan || null, phone: phone || null, role };

    $("saveEmpBtn").disabled = true;
    try {
      if(id) {
        const {error} = await supabaseClient.from("employee_registry").update(fields).eq("id", id);
        if(error) { alert("Gagal update: " + error.message); return; }
      } else {
        const {error} = await supabaseClient.from("employee_registry").insert({ ...fields, email });
        if(error) {
          alert(error.code === "23505" ? "Email ini sudah terdaftar." : "Gagal menambah: " + error.message);
          return;
        }
        alert(`Karyawan ditambahkan.\n\nMinta ${full_name} membuka halaman login, klik "Daftar akun", lalu mendaftar dengan email ${email} dan kata sandi pilihannya.`);
      }
      show("empModal", false);
      loadEmployeesData();
    } finally {
      $("saveEmpBtn").disabled = false;
    }
  };
}

window.deleteEmployee = async (id) => {
  const emp = allEmployees.find(x => x.id === id);
  if(!emp) return;
  if(emp.user_id && emp.user_id === currentUser.id) { alert("Tidak bisa menghapus akun yang sedang login."); return; }
  if(!confirm(`Hapus ${emp.full_name} dari daftar karyawan?`)) return;

  if(emp.user_id) { // sudah mendaftar: hapus profilnya juga
    const {error} = await supabaseClient.from("profiles").delete().eq("id", emp.user_id);
    if(error) { alert("Gagal menghapus profil: " + error.message); return; }
  }
  const {error} = await supabaseClient.from("employee_registry").delete().eq("id", id);
  if(error) { alert("Gagal menghapus: " + error.message); return; }
  loadEmployeesData();
};

// "2026-10-29" -> "29/10/2026"
function fmtKeyToDisplay(key) {
  if (!key) return "";
  const [y, m, d] = key.split("-");
  return `${d}/${m}/${y}`;
}

function recapPeriodRange() {
  const keys = lastRecapData.map(r => r.dateKey).sort();
  return {
    start: lastRecapMeta.from || keys[0] || "",
    end: lastRecapMeta.to || keys[keys.length - 1] || ""
  };
}

function recapPeriodText() {
  const { start, end } = recapPeriodRange();
  if (!start && !end) return "-";
  return start === end ? fmtKeyToDisplay(start) : `${fmtKeyToDisplay(start)} s/d ${fmtKeyToDisplay(end)}`;
}

function groupRecapByEmployee() {
  const map = new Map();
  lastRecapData.forEach(r => {
    if (!map.has(r.userId)) {
      // Nama Pekerjaan diambil dari data karyawan (employee_registry)
      const emp = allEmployees.find(e => e.user_id === r.userId);
      map.set(r.userId, { name: r.name, jabatan: r.jabatan, namaPekerjaan: emp?.nama_pekerjaan || "-", rows: [] });
    }
    map.get(r.userId).rows.push(r);
  });
  return Array.from(map.values());
}

function countHadir(rows) {
  return rows.filter(r => r.checkIn !== "-").length;
}

function recapFileName(groups, ext) {
  const safe = (s) => String(s).replace(/[^\w\-]+/g, "_").replace(/^_+|_+$/g, "");
  const who = groups.length === 1 ? safe(groups[0].name) : "Semua_Karyawan";
  const { start, end } = recapPeriodRange();
  return `Rekap_Absensi_${who}_${start}_sd_${end}.${ext}`;
}

// --- Helper koordinat & foto untuk export ---
function makeLoc(lat, lon) {
  if (lat == null || lon == null) return null;
  const la = Number(lat), lo = Number(lon);
  return (Number.isFinite(la) && Number.isFinite(lo)) ? { lat: la, lon: lo } : null;
}
function fmtCoord(loc) { return loc ? `${loc.lat.toFixed(6)}, ${loc.lon.toFixed(6)}` : "-"; }
function mapsUrl(loc) { return `https://www.google.com/maps?q=${loc.lat},${loc.lon}`; }

// Teks pengganti jika foto tidak ada / gagal dimuat
function photoCellText(path) {
  if (!path) return "-";
  return photoThumbCache.has(path) ? "" : "Gagal dimuat";
}

// Skala gambar agar muat dalam kotak maxW x maxH tanpa mengubah rasio
function fitSize(t, maxW, maxH) {
  const k = Math.min(maxW / t.w, maxH / t.h);
  return { w: t.w * k, h: t.h * k };
}

async function blobToThumb(blob, maxW = 240) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("Gambar tidak valid")); img.src = url; });
    const scale = Math.min(1, maxW / img.width);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    return { dataUrl: canvas.toDataURL("image/jpeg", 0.75), w: canvas.width, h: canvas.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function loadPhotoThumb(path) {
  if (!path || photoThumbCache.has(path)) return;
  try {
    const { data, error } = await supabaseClient.storage.from("attendance-photos").download(path);
    if (error || !data) throw (error || new Error("File kosong"));
    photoThumbCache.set(path, await blobToThumb(data));
  } catch (err) {
    console.warn("Foto gagal dimuat:", path, err);
  }
}

// Unduh semua foto check-in/check-out yang ada di rekap (5 sekaligus)
async function preloadRecapPhotos() {
  const paths = [...new Set(lastRecapData.flatMap(r => [r.photoIn, r.photoOut]).filter(Boolean))]
    .filter(p => !photoThumbCache.has(p));
  const queue = [...paths];
  let done = 0;
  const worker = async () => {
    while (queue.length) {
      await loadPhotoThumb(queue.shift());
      done++;
      message("adminMsg", `Mengunduh foto… ${done}/${paths.length}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, paths.length) }, worker));
}

function setExportBusy(busy) {
  ["exportExcelBtn", "exportPdfBtn", "refreshRecapBtn"].forEach(id => { if ($(id)) $(id).disabled = busy; });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// --- Muat & tampilkan rekap ---
async function loadRecapData() {
  const from = $("fromDate")?.value || "";
  const to = $("toDate")?.value || "";
  const keyword = ($("recapSearch")?.value || "").trim();

  if (from && to && from > to) {
    message("adminMsg", "Tanggal 'Dari' tidak boleh lebih besar dari 'Sampai'.", true);
    return;
  }

  if (!allEmployees.length) await loadEmployeesData();

  let query = supabaseClient
    .from("attendance")
    .select("id,user_id,created_at,check_type,activity,photo_path,latitude,longitude,profiles(full_name,email,jabatan)")
    .order("created_at", { ascending: false })
    .limit(1000);

  // Pencarian berdasarkan nama (atau email) karyawan
  if (keyword) {
    const kw = keyword.toLowerCase();
    const ids = allEmployees
      .filter(emp => (emp.full_name || "").toLowerCase().includes(kw) || (emp.email || "").toLowerCase().includes(kw))
      .map(emp => emp.user_id).filter(Boolean);

    if (!ids.length) {
      lastRecapData = [];
      lastRecapMeta = { from, to, keyword };
      if ($("recapRows")) $("recapRows").innerHTML = "";
      message("adminMsg", `Karyawan dengan nama "${keyword}" tidak ditemukan.`, true);
      return;
    }
    query = query.in("user_id", ids);
  }

  if (from) query = query.gte("created_at", new Date(from + "T00:00:00").toISOString());
  if (to) query = query.lt("created_at", new Date(new Date(to + "T00:00:00").getTime() + 86400000).toISOString());

  const { data, error } = await query;
  if (error) { message("adminMsg", error.message, true); return; }

  // Data datang dari yang terbaru ke terlama:
  // check-in = catatan paling awal (ditimpa terus), check-out = catatan paling akhir (diisi sekali)
  const grouped = {};
  (data || []).forEach(r => {
    const dateKey = toLocalDateKey(r.created_at);
    const key = `${dateKey}_${r.user_id}`;
    if (!grouped[key]) {
      grouped[key] = {
        userId: r.user_id,
        dateKey,
        date: fmtKeyToDisplay(dateKey),
        name: r.profiles?.full_name || r.profiles?.email || r.user_id,
        jabatan: r.profiles?.jabatan || "-",
        checkIn: "-",
        checkOut: "-",
        activity: r.activity || "-",
        photoIn: "",
        photoOut: "",
        locIn: null,
        locOut: null
      };
    }
    const g = grouped[key];
    if (r.check_type === 'check_in') {
      g.checkIn = fmtTimeOnly(r.created_at);
      if (r.activity) g.activity = r.activity;
      g.photoIn = r.photo_path || "";
      g.locIn = makeLoc(r.latitude, r.longitude);
    }
    if (r.check_type === 'check_out' && g.checkOut === "-") {
      g.checkOut = fmtTimeOnly(r.created_at);
      g.photoOut = r.photo_path || "";
      g.locOut = makeLoc(r.latitude, r.longitude);
    }
  });

  // Urut per karyawan, lalu tanggal dari yang paling awal
  lastRecapData = Object.values(grouped).sort((a, b) =>
    a.name.localeCompare(b.name, "id") || a.dateKey.localeCompare(b.dateKey)
  );
  lastRecapMeta = { from, to, keyword };

  if ($("recapRows")) {
    $("recapRows").innerHTML = lastRecapData.map(r => `
      <tr>
        <td>${escapeHtml(r.date)}</td>
        <td>${escapeHtml(r.name)}</td>
        <td>${escapeHtml(r.checkIn)}</td>
        <td>${escapeHtml(r.checkOut)}</td>
        <td>${escapeHtml(r.activity)}</td>
        <td>${r.photoIn ? `<button type="button" class="secondary" data-photo="${escapeHtml(r.photoIn)}">Lihat Foto</button>` : "—"}</td>
      </tr>
    `).join("");
    $("recapRows").querySelectorAll("[data-photo]").forEach(b => b.onclick = () => b.dataset.photo && openPhoto(b.dataset.photo));
  }

  const jumlahKaryawan = groupRecapByEmployee().length;
  let msg = `Ditemukan ${lastRecapData.length} baris rekap dari ${jumlahKaryawan} karyawan.`;
  if ((data || []).length >= 1000) msg += " Data dibatasi 1000 catatan, persempit rentang tanggal atau nama karyawan.";
  message("adminMsg", msg, (data || []).length >= 1000);
}

if ($("refreshRecapBtn")) $("refreshRecapBtn").onclick = loadRecapData;
if ($("recapSearch")) $("recapSearch").onkeydown = (e) => { if (e.key === "Enter") loadRecapData(); };

// --- Export Excel (ExcelJS, dengan foto tertanam) ---
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => { s.remove(); reject(new Error("Gagal memuat " + src)); };
    document.head.appendChild(s);
  });
}

// Coba beberapa CDN bergantian sampai ExcelJS berhasil dimuat
async function ensureExcelJS() {
  if (window.ExcelJS) return true;
  const urls = [
    "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js",
    "https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js",
    "https://unpkg.com/exceljs@4.4.0/dist/exceljs.min.js"
  ];
  for (const url of urls) {
    try {
      await loadScript(url);
      if (window.ExcelJS) return true;
    } catch (err) {
      console.warn(err.message);
    }
  }
  return false;
}

async function buildRecapExcel() {
  const groups = groupRecapByEmployee();
  const period = recapPeriodText();
  const wb = new ExcelJS.Workbook();
  wb.creator = "AbsensiPro";
  wb.created = new Date();

  const usedNames = new Set();
  const thin = { style: "thin" };
  const border = { top: thin, left: thin, bottom: thin, right: thin };
  const LAST_COL = "H";
  const HEADERS = ["Tanggal", "Jam Check-in", "Foto Check-in", "Lokasi Check-in", "Jam Check-out", "Foto Check-out", "Lokasi Check-out", "Kegiatan"];
  const PHOTO_W = 100, PHOTO_H = 72;

  groups.forEach((g, idx) => {
    // Nama sheet: maks 31 karakter, tanpa karakter terlarang, harus unik
    let sheetName = (g.name || "Karyawan").replace(/[\\\/\?\*\[\]:]/g, "").slice(0, 28) || "Karyawan";
    if (usedNames.has(sheetName.toLowerCase())) sheetName = `${sheetName.slice(0, 25)}_${idx + 1}`;
    usedNames.add(sheetName.toLowerCase());

    const ws = wb.addWorksheet(sheetName, {
      pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
    });
    ws.columns = [{ width: 18 }, { width: 13 }, { width: 16 }, { width: 24 }, { width: 13 }, { width: 16 }, { width: 24 }, { width: 45 }];

    // Kop
    ws.mergeCells(`A1:${LAST_COL}1`);
    ws.getCell("A1").value = "LAPORAN REKAP ABSENSI KARYAWAN";
    ws.getCell("A1").font = { bold: true, size: 14 };
    ws.getCell("A1").alignment = { horizontal: "center" };
    ws.mergeCells(`A2:${LAST_COL}2`);
    ws.getCell("A2").value = "PT. AGRINAS PALMA NUSANTARA";
    ws.getCell("A2").font = { bold: true, size: 11 };
    ws.getCell("A2").alignment = { horizontal: "center" };

    const info = [
      ["Nama Pekerjaan", g.namaPekerjaan],
      ["Nama", g.name],
      ["Jabatan", g.jabatan],
      ["Periode", period],
      ["Jumlah Hari Hadir", `${countHadir(g.rows)} hari`]
    ];
    info.forEach(([label, val], i) => {
      const r = 4 + i;
      ws.getCell(`A${r}`).value = label;
      ws.getCell(`A${r}`).font = { bold: true };
      ws.mergeCells(`B${r}:${LAST_COL}${r}`);
      ws.getCell(`B${r}`).value = `: ${val}`;
    });

    // Header tabel (baris 10; info karyawan di baris 4-8)
    const headRow = ws.getRow(10);
    HEADERS.forEach((t, i) => {
      const c = headRow.getCell(i + 1);
      c.value = t;
      c.font = { bold: true, color: { argb: "FFFFFFFF" } };
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF155E75" } };
      c.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      c.border = border;
    });
    headRow.height = 22;

    // Isi tabel
    g.rows.forEach(r => {
      const row = ws.addRow([
        r.date,
        r.checkIn,
        photoCellText(r.photoIn),
        "",
        r.checkOut,
        photoCellText(r.photoOut),
        "",
        r.activity
      ]);
      row.height = 60; // ~80 px, cukup untuk foto

      [[4, r.locIn], [7, r.locOut]].forEach(([col, loc]) => {
        const cell = row.getCell(col);
        if (loc) {
          cell.value = { text: fmtCoord(loc), hyperlink: mapsUrl(loc) };
          cell.font = { color: { argb: "FF0563C1" }, underline: true };
        } else {
          cell.value = "-";
        }
      });

      row.eachCell({ includeEmpty: true }, (cell, col) => {
        cell.border = border;
        cell.alignment = { vertical: "middle", horizontal: col === 8 ? "left" : "center", wrapText: true };
      });

      // Tempel foto di kolom C (indeks 2) dan F (indeks 5)
      [[2, r.photoIn], [5, r.photoOut]].forEach(([colIdx, path]) => {
        const t = path && photoThumbCache.get(path);
        if (!t) return;
        const { w, h } = fitSize(t, PHOTO_W, PHOTO_H);
        const imgId = wb.addImage({ base64: t.dataUrl, extension: "jpeg" });
        ws.addImage(imgId, {
          tl: { col: colIdx + 0.07, row: row.number - 1 + 0.05 },
          ext: { width: w, height: h }
        });
      });
    });
  });

  const buf = await wb.xlsx.writeBuffer();
  downloadBlob(
    new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    recapFileName(groups, "xlsx")
  );
}

if ($("exportExcelBtn")) {
  $("exportExcelBtn").onclick = async () => {
    if (!lastRecapData.length) { alert("Tidak ada data untuk diexport. Klik 'Tampilkan Rekap' terlebih dahulu."); return; }
    if (!(await ensureExcelJS())) {
  alert("Library ExcelJS gagal dimuat dari semua sumber. Periksa koneksi internet atau firewall, lalu coba lagi.");
  return;
}
    setExportBusy(true);
    try {
      await preloadRecapPhotos();
      message("adminMsg", "Menyusun file Excel…");
      await buildRecapExcel();
      message("adminMsg", "File Excel berhasil dibuat.");
    } catch (err) {
      message("adminMsg", "Export Excel gagal: " + (err.message || err), true);
    } finally {
      setExportBusy(false);
    }
  };
}

// --- Export PDF (landscape, dengan foto) ---
async function buildRecapPdf() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const groups = groupRecapByEmployee();
  const period = recapPeriodText();

  groups.forEach((g, idx) => {
    if (idx > 0) doc.addPage();

    // Kop laporan
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.text("LAPORAN REKAP ABSENSI KARYAWAN", pageW / 2, 14, { align: "center" });
    doc.setFontSize(11);
    doc.text("PT. AGRINAS PALMA NUSANTARA", pageW / 2, 20, { align: "center" });
    doc.setLineWidth(0.6);
    doc.line(14, 24, pageW - 14, 24);

    // Identitas karyawan
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    const info = [
      ["Nama Pekerjaan", g.namaPekerjaan],
      ["Nama", g.name],
      ["Jabatan", g.jabatan],
      ["Periode", period],
      ["Jumlah Hari Hadir", `${countHadir(g.rows)} hari`]
    ];
    info.forEach(([label, val], i) => {
      const y = 31 + i * 6;
      doc.text(label, 14, y);
      doc.text(`: ${val}`, 55, y);
    });

    doc.autoTable({
      startY: 31 + info.length * 6 + 2,
      head: [["No", "Tanggal", "Check-in", "Foto\nCheck-in", "Lokasi\nCheck-in", "Check-out", "Foto\nCheck-out", "Lokasi\nCheck-out", "Kegiatan"]],
      body: g.rows.map((r, i) => [
        i + 1, r.date, r.checkIn, photoCellText(r.photoIn), fmtCoord(r.locIn),
        r.checkOut, photoCellText(r.photoOut), fmtCoord(r.locOut), r.activity
      ]),
      theme: "grid",
      styles: { fontSize: 8, valign: "middle", minCellHeight: 20 },
      headStyles: { fillColor: [21, 94, 117], halign: "center", minCellHeight: 8 },
      columnStyles: {
        0: { cellWidth: 10 }, 1: { cellWidth: 20 }, 2: { cellWidth: 14 }, 3: { cellWidth: 24 },
        4: { cellWidth: 34 }, 5: { cellWidth: 14 }, 6: { cellWidth: 24 }, 7: { cellWidth: 34 }
      },
      didParseCell: (data) => {
        if (data.section !== "body") return;
        const r = g.rows[data.row.index];
        const loc = data.column.index === 4 ? r?.locIn : data.column.index === 7 ? r?.locOut : null;
        if (loc) data.cell.styles.textColor = [5, 99, 193];
      },
      didDrawCell: (data) => {
        if (data.section !== "body") return;
        const r = g.rows[data.row.index];
        if (!r) return;
        const c = data.column.index;

        if (c === 3 || c === 6) { // foto
          const t = photoThumbCache.get(c === 3 ? r.photoIn : r.photoOut);
          if (!t) return;
          const { w, h } = fitSize(t, 22, 17);
          doc.addImage(
            t.dataUrl, "JPEG",
            data.cell.x + (data.cell.width - w) / 2,
            data.cell.y + (data.cell.height - h) / 2,
            w, h
          );
        }
        if (c === 4 || c === 7) { // koordinat -> tautan Google Maps
          const loc = c === 4 ? r.locIn : r.locOut;
          if (loc) doc.link(data.cell.x, data.cell.y, data.cell.width, data.cell.height, { url: mapsUrl(loc) });
        }
      }
    });
  });

  // Footer di setiap halaman
  const total = doc.internal.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.text(`Dicetak: ${new Date().toLocaleString("id-ID")}  |  Halaman ${i} dari ${total}`, 14, pageH - 8);
  }

  doc.save(recapFileName(groups, "pdf"));
}

if ($("exportPdfBtn")) {
  $("exportPdfBtn").onclick = async () => {
    if (!lastRecapData.length) { alert("Tidak ada data untuk diexport. Klik 'Tampilkan Rekap' terlebih dahulu."); return; }
    setExportBusy(true);
    try {
      await preloadRecapPhotos();
      message("adminMsg", "Menyusun file PDF…");
      await buildRecapPdf();
      message("adminMsg", "File PDF berhasil dibuat.");
    } catch (err) {
      message("adminMsg", "Export PDF gagal: " + (err.message || err), true);
    } finally {
      setExportBusy(false);
    }
  };
}

// --- AUTH & BOOT ---
async function boot() {
  if(!configured) { 
    show("setupNotice", true); 
    if ($("loginBtn")) $("loginBtn").disabled = true; 
    message("loginMsg", "Lengkapi konfigurasi Supabase di app.js terlebih dahulu.", true); 
    return; 
  }
  show("setupNotice", false);
  
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
  
  const {data:{session}} = await supabaseClient.auth.getSession();

  if(session) {
    currentUser = session.user;
    try {
      await loadProfile(); 
      await refreshUI();
    } catch(e) {
      message("loginMsg", "Profil belum tersedia di database. Minta admin menambahkannya. ("+e.message+")", true); 
      await supabaseClient.auth.signOut();
      currentUser = null;
      currentProfile = null;
      await refreshUI();
    }
  }

  supabaseClient.auth.onAuthStateChange(async (_event, session) => {
    const prevUserId = currentUser?.id || null;
    currentUser = session?.user || null;

    // Event seperti TOKEN_REFRESHED / SIGNED_IN saat kembali ke tab browser:
    // user sama dan profil sudah termuat, jadi tidak perlu render ulang UI.
    if(currentUser && prevUserId === currentUser.id && currentProfile && _event !== "USER_UPDATED") {
      return;
    }

    // Akun berganti (atau login baru): buang sisa form akun sebelumnya
    if(!currentUser || prevUserId !== currentUser.id) {
      resetAttendanceForm();
    }

    if(currentUser) {
      try {
        await loadProfile(); 
        await refreshUI();
      } catch(e) {
        message("loginMsg", "Profil belum tersedia di database. ("+e.message+")", true); 
        await supabaseClient.auth.signOut();
        currentUser = null;
        currentProfile = null;
        await refreshUI();
      }
    } else {
      currentProfile = null;
      try { localStorage.removeItem("activeTab"); } catch(e) {}
      ["email", "password"].forEach(id => { if ($(id)) $(id).value = ""; });
      await refreshUI();
    }
  });
}

if ($("loginBtn")) {
  $("loginBtn").onclick = async () => {
    message("loginMsg", "Memeriksa akun…");
    const {error} = await supabaseClient.auth.signInWithPassword({
      email: $("email").value.trim(),
      password: $("password").value
    });
    if(error) message("loginMsg", error.message, true);
  };
}

// Event Listener Navigasi Menu Sidebar / Bottom Bar
document.querySelectorAll(".nav-item[data-target]").forEach(btn => {
  btn.onclick = () => {
    const target = btn.dataset.target;
    const targetEl = $(target);
    if (!targetEl) return;

    // Tentukan jenis tab dari class elemennya, bukan dari awalan nama
    if (targetEl.classList.contains("emp-tab-content")) {
      switchEmployeeTab(target);
    } else {
      switchAdminTab(target);
    }
  };
});

// Penanganan Keluar
if ($("logoutBtnNav")) {
  $("logoutBtnNav").onclick = async () => {
    await supabaseClient.auth.signOut();
  };
}
if ($("logoutBtnHeader")) {
  $("logoutBtnHeader").onclick = async () => {
    await supabaseClient.auth.signOut();
  };
}

// --- LUPA / RESET / UBAH KATA SANDI ---
if ($("showForgot")) $("showForgot").onclick = (e) => {
  e.preventDefault();
  $("forgotEmail").value = $("email")?.value.trim() || "";
  message("forgotMsg", "");
  show("loginPanel", false);
  show("forgotPanel", true);
};
if ($("backToLogin")) $("backToLogin").onclick = (e) => {
  e.preventDefault();
  show("forgotPanel", false);
  show("loginPanel", true);
};

// 1) Reset tanpa email: verifikasi email + NIK yang didaftarkan admin
if ($("forgotBtn")) {
  $("forgotBtn").onclick = async () => {
    const email = $("forgotEmail").value.trim().toLowerCase();
    const nik = $("forgotNik").value.trim();
    const pw = $("forgotNewPw").value;
    const pw2 = $("forgotNewPw2").value;

    if(!email || !nik) { message("forgotMsg", "Email dan NIK wajib diisi.", true); return; }
    if(pw.length < 8) { message("forgotMsg", "Kata sandi baru minimal 8 karakter.", true); return; }
    if(pw !== pw2) { message("forgotMsg", "Ulangi kata sandi tidak sama.", true); return; }

    $("forgotBtn").disabled = true;
    try {
      message("forgotMsg", "Memverifikasi data…");
      const {data, error} = await supabaseClient.rpc("reset_password_by_registry", {
        p_email: email, p_nik: nik, p_new_password: pw
      });
      if(error) { message("forgotMsg", "Gagal: " + error.message, true); return; }
      if(!data?.ok) { message("forgotMsg", data?.message || "Verifikasi gagal.", true); return; }

      ["forgotEmail","forgotNik","forgotNewPw","forgotNewPw2"].forEach(id => $(id).value = "");
      message("forgotMsg", "");
      show("forgotPanel", false);
      show("loginPanel", true);
      if ($("email")) $("email").value = email;
      message("loginMsg", "Kata sandi berhasil diubah. Silakan masuk dengan kata sandi baru.");
    } finally {
      $("forgotBtn").disabled = false;
    }
  };
}

// 3) Ubah kata sandi dari menu Profil (sudah login)
if ($("changePasswordBtn")) {
  $("changePasswordBtn").onclick = async () => {
    const cur = $("curPassword").value;
    const pw = $("chgPassword").value;
    const pw2 = $("chgPassword2").value;

    if(!cur || !pw) { message("changePwMsg", "Semua kolom wajib diisi.", true); return; }
    if(pw.length < 8) { message("changePwMsg", "Kata sandi baru minimal 8 karakter.", true); return; }
    if(pw !== pw2) { message("changePwMsg", "Ulangi kata sandi baru tidak sama.", true); return; }
    if(pw === cur) { message("changePwMsg", "Kata sandi baru harus berbeda dari yang lama.", true); return; }

    $("changePasswordBtn").disabled = true;
    try {
      message("changePwMsg", "Memverifikasi kata sandi saat ini…");
      const email = currentProfile?.email || currentUser.email;
      const {error: verifyErr} = await supabaseClient.auth.signInWithPassword({ email, password: cur });
      if(verifyErr) { message("changePwMsg", "Kata sandi saat ini salah.", true); return; }

      message("changePwMsg", "Menyimpan kata sandi baru…");
      const {error} = await supabaseClient.auth.updateUser({ password: pw });
      if(error) { message("changePwMsg", error.message, true); return; }

      $("curPassword").value = "";
      $("chgPassword").value = "";
      $("chgPassword2").value = "";
      message("changePwMsg", "Kata sandi berhasil diubah.");
    } finally {
      $("changePasswordBtn").disabled = false;
    }
  };
}

// --- PENDAFTARAN AKUN KARYAWAN ---
if ($("showRegister")) $("showRegister").onclick = (e) => {
  e.preventDefault();
  show("loginPanel", false);
  show("registerPanel", true);
};
if ($("showLogin")) $("showLogin").onclick = (e) => {
  e.preventDefault();
  show("registerPanel", false);
  show("loginPanel", true);
};

if ($("registerBtn")) {
  $("registerBtn").onclick = async () => {
    const email = $("regEmail").value.trim().toLowerCase();
    const pw = $("regPassword").value;
    const pw2 = $("regPassword2").value;

    if(!email || !pw) { message("regMsg", "Email dan kata sandi wajib diisi.", true); return; }
    if(pw.length < 8) { message("regMsg", "Kata sandi minimal 8 karakter.", true); return; }
    if(pw !== pw2) { message("regMsg", "Ulangi kata sandi tidak sama.", true); return; }

    $("registerBtn").disabled = true;
    try {
      message("regMsg", "Memeriksa email…");
      const {data: status, error: chkErr} = await supabaseClient.rpc("registration_status", {p_email: email});
      if(chkErr) { message("regMsg", chkErr.message, true); return; }
      if(status === "not_registered") { message("regMsg", "Email ini belum didaftarkan oleh admin. Hubungi admin Anda.", true); return; }
      if(status === "already_registered") { message("regMsg", "Email ini sudah mendaftar. Silakan masuk.", true); return; }

      message("regMsg", "Membuat akun…");
      const {data, error} = await supabaseClient.auth.signUp({ email, password: pw });
      if(error) { message("regMsg", error.message, true); return; }

      if(data.session) {
        message("regMsg", "Pendaftaran berhasil. Mengalihkan…");
      } else {
        message("regMsg", "Pendaftaran berhasil. Cek email Anda untuk konfirmasi, lalu masuk.");
      }
    } finally {
      $("registerBtn").disabled = false;
    }
  };
}

document.addEventListener("DOMContentLoaded", boot);
