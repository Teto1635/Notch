/* Çentik — service worker
   Uygulama kabuğunu çevrimdışı açılış için saklar. Google / Firebase arka uç trafiğine dokunmaz.
   Aynı adreste (github.io) başka uygulamalar da yaşadığı için yalnızca kendi "centik-" önbelleklerini yönetir. */
const CACHE = "centik-v1";
const PAGE = "./index.html";
const SHELL = [PAGE, "./manifest.webmanifest", "./archivo.woff2", "./icon.svg", "./icon-192.png", "./icon-512.png", "./icon-maskable.png"];
const SCOPE = new URL(self.registration.scope);
const isHtml = (res) => res.ok && (res.headers.get("content-type") || "").includes("text/html");
const keep = (e, p) => { try { e.waitUntil(p); } catch (err) {} };   // yanıt verildikten sonra süren işi (önbelleğe yazma) canlı tutar

async function warm(force) {
  const c = await caches.open(CACHE);
  await Promise.all(SHELL.map(async (u) => {
    try {
      if (!force && (await c.match(u))) return;
      const res = await fetch(new Request(u, { cache: "reload" }));
      if (u === PAGE ? isHtml(res) : res.ok) await c.put(u, res);
    } catch (e) {}
  }));
}

/* Sayfa artık başka bir Firebase sürümü kullanıyorsa eski sürümün dosyaları silinir. */
async function pruneSdk(ver) {
  const c = await caches.open(CACHE);
  for (const req of await c.keys()) {
    const u = new URL(req.url);
    if (u.hostname === "www.gstatic.com" && u.pathname.startsWith("/firebasejs/") && !u.pathname.startsWith("/firebasejs/" + ver + "/")) await c.delete(req);
  }
}

self.addEventListener("install", (e) => {
  e.waitUntil(warm(true).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("centik-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Uygulama sayfası: önce ağ; 2,5 sn içinde düzgün bir yanıt gelmezse saklanan kopya. Çevrimiçiyken hep son sürüm açılır.
   Yalnızca HTML yanıtı saklanır; hata sayfası ya da başka türde bir yanıt kabuğun yerine geçemez. */
async function page(e) {
  const c = await caches.open(CACHE);
  const net = fetch(e.request);
  keep(e, net.then((res) => (isHtml(res) ? c.put(PAGE, res.clone()) : null)).catch(() => {}));
  const hit = await c.match(PAGE);
  if (!hit) return net;
  try {
    const res = await Promise.race([net, new Promise((_, no) => setTimeout(() => no(new Error("slow")), 2500))]);
    if (res.ok || res.type === "opaqueredirect") return res;
  } catch (err) {}
  return hit;
}

/* Diğer dosyalar ve Firebase SDK: önce saklanan kopya, yoksa ağ. */
async function asset(e, sameOrigin) {
  const c = await caches.open(CACHE);
  const hit = await c.match(e.request, { ignoreSearch: sameOrigin });
  if (hit) return hit;
  const res = await fetch(e.request);
  if (res.ok) keep(e, c.put(e.request, res.clone()).catch(() => {}));
  return res;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const u = new URL(req.url);
  const sameOrigin = u.origin === SCOPE.origin;
  const sdk = u.hostname === "www.gstatic.com" && u.pathname.startsWith("/firebasejs/");
  if (!sdk && !(sameOrigin && u.pathname.startsWith(SCOPE.pathname))) return;   // geri kalan her şey tarayıcıya bırakılır
  if (sameOrigin && req.mode === "navigate") {
    const rel = u.pathname.slice(SCOPE.pathname.length);
    if (rel === "" || rel === "index.html") e.respondWith(page(e));
    return;                                               // klasördeki başka bir belge (README vb.) kabuk sayılmaz
  }
  e.respondWith(asset(e, sameOrigin));
});

self.addEventListener("message", (e) => {
  const d = e.data || {};
  if (d.type !== "warm") return;
  e.waitUntil((async () => {
    await warm(false);                                    // başka bir uygulama önbelleği sildiyse geri doldur
    if (typeof d.sdk === "string" && /^\d+\.\d+\.\d+$/.test(d.sdk)) await pruneSdk(d.sdk);
  })().catch(() => {}));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const id = e.notification.data && e.notification.data.id;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const cl of list) {
      if (cl.url.startsWith(SCOPE.href)) { cl.postMessage({ type: "open", id }); return cl.focus(); }
    }
    return self.clients.openWindow(SCOPE.href + (id ? "#n=" + id : ""));
  }));
});
