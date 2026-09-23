const http = require("http");
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { exec } = require("child_process");
const { WebSocketServer } = require("ws");
const { formidable } = require("formidable");

const baseDir = __dirname;
const PORT = 8765;

// Cache disque des tuiles IGN (ortho/plan/routes) — ces fonds de carte changent
// rarement, on évite donc de les retélécharger à chaque rechargement de la page.
const IGN_CACHE_DIR = path.join(baseDir, "ign-cache");
if (!fs.existsSync(IGN_CACHE_DIR)) fs.mkdirSync(IGN_CACHE_DIR);

// Photos jointes aux repères d'événement signalés depuis le terrain (agent.html)
const EVENT_PHOTOS_DIR = path.join(baseDir, "event-photos");
if (!fs.existsSync(EVENT_PHOTOS_DIR)) fs.mkdirSync(EVENT_PHOTOS_DIR);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".geojson": "application/geo+json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

// PNG 1x1 transparent — renvoyé pour les tuiles terrain hors de la zone couverte
// par les données LIDAR (évite les 404 quand la vue dépasse leur emprise).
const BLANK_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAAfFcSAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

// Proxy vers le WMTS IGN (data.geopf.fr) avec cache disque — les fonds de carte IGN
// changent rarement, et le service renvoie 404 (sans image) pour les tuiles sans
// donnée à cet endroit ; on met les deux cas en cache pour éviter de les redemander.
function ignCachePaths(query){
  const hash = crypto.createHash("sha1").update(query).digest("hex");
  return {
    image: path.join(IGN_CACHE_DIR, hash + ".img"),
    blank: path.join(IGN_CACHE_DIR, hash + ".blank"),
    meta: path.join(IGN_CACHE_DIR, hash + ".ct"),
  };
}

// Récupère une tuile IGN pour cette query (depuis le cache si présente, sinon
// la télécharge et la met en cache) puis appelle cb(cached: boolean).
function fetchIgnTile(query, cb){
  const cachePaths = ignCachePaths(query);

  if (fs.existsSync(cachePaths.blank) || fs.existsSync(cachePaths.image)) {
    cb(true);
    return;
  }

  https.get(`https://data.geopf.fr/wmts?${query}`, (ignRes) => {
    if (ignRes.statusCode !== 200) {
      ignRes.resume();
      fs.writeFile(cachePaths.blank, "", () => cb(false));
      return;
    }
    const contentType = ignRes.headers["content-type"] || "image/png";
    const chunks = [];
    ignRes.on("data", (chunk) => chunks.push(chunk));
    ignRes.on("end", () => {
      const body = Buffer.concat(chunks);
      fs.writeFile(cachePaths.image, body, () => {
        fs.writeFile(cachePaths.meta, contentType, () => cb(false));
      });
    });
  }).on("error", () => {
    fs.writeFile(cachePaths.blank, "", () => cb(false));
  });
}

function proxyIgnTile(req, res){
  const query = req.url.split("?")[1] || "";
  const cachePaths = ignCachePaths(query);

  function serveFromCache(){
    if (fs.existsSync(cachePaths.blank)) {
      res.writeHead(200, { "Content-Type": "image/png", "Access-Control-Allow-Origin": "*" });
      res.end(BLANK_PNG);
      return true;
    }
    if (fs.existsSync(cachePaths.image)) {
      const contentType = fs.existsSync(cachePaths.meta) ? fs.readFileSync(cachePaths.meta, "utf8") : "image/png";
      res.writeHead(200, { "Content-Type": contentType, "Access-Control-Allow-Origin": "*" });
      res.end(fs.readFileSync(cachePaths.image));
      return true;
    }
    return false;
  }

  if (serveFromCache()) return;
  fetchIgnTile(query, () => serveFromCache());
}

// Génère les indices de tuiles WMTS (TILEMATRIX/TILEROW/TILECOL) couvrant une bbox
// lon/lat, pour un niveau de zoom donné (grille Web Mercator standard, 256px/tuile).
function tilesForBbox(minLon, maxLon, minLat, maxLat, z){
  const lon2col = (lon) => Math.floor((lon + 180) / 360 * Math.pow(2, z));
  const lat2row = (lat) => {
    const rad = lat * Math.PI / 180;
    return Math.floor((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * Math.pow(2, z));
  };
  const colMin = lon2col(minLon), colMax = lon2col(maxLon);
  const rowMin = lat2row(maxLat), rowMax = lat2row(minLat);
  const tiles = [];
  for (let row = rowMin; row <= rowMax; row++) {
    for (let col = colMin; col <= colMax; col++) {
      tiles.push({ z, row, col });
    }
  }
  return tiles;
}

const IGN_PREFETCH_LAYERS = [
  { layer: "ORTHOIMAGERY.ORTHOPHOTOS", format: "image/jpeg" },
  { layer: "GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2", format: "image/png" },
  { layer: "TRANSPORTNETWORKS.ROADS", format: "image/png" },
];

// Précharge dans le cache disque toutes les tuiles IGN (ortho/plan/routes) couvrant
// une bbox sur une plage de zoom — répond en Server-Sent Events pour suivre la progression.
function prefetchIgnTiles(req, res){
  const params = new URLSearchParams(req.url.split("?")[1] || "");
  const minLon = parseFloat(params.get("minLon"));
  const maxLon = parseFloat(params.get("maxLon"));
  const minLat = parseFloat(params.get("minLat"));
  const maxLat = parseFloat(params.get("maxLat"));
  const minZoom = parseInt(params.get("minZoom"), 10);
  const maxZoom = parseInt(params.get("maxZoom"), 10);

  if ([minLon, maxLon, minLat, maxLat].some(Number.isNaN) || Number.isNaN(minZoom) || Number.isNaN(maxZoom)) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Paramètres invalides.");
    return;
  }

  const jobs = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    tilesForBbox(minLon, maxLon, minLat, maxLat, z).forEach((t) => {
      IGN_PREFETCH_LAYERS.forEach((l) => jobs.push({ ...t, ...l }));
    });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Access-Control-Allow-Origin": "*",
  });

  const total = jobs.length;
  let done = 0;
  let cachedCount = 0;

  function sendProgress(){
    res.write(`data: ${JSON.stringify({ done, total, cached: cachedCount })}\n\n`);
  }

  function runNext(){
    if (done >= total) {
      res.write(`data: ${JSON.stringify({ done, total, cached: cachedCount, finished: true })}\n\n`);
      res.end();
      return;
    }
    const job = jobs[done];
    const query = `SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${job.layer}&STYLE=normal&FORMAT=${encodeURIComponent(job.format)}&TILEMATRIXSET=PM&TILEMATRIX=${job.z}&TILEROW=${job.row}&TILECOL=${job.col}`;
    fetchIgnTile(query, (wasCached) => {
      done++;
      if (wasCached) cachedCount++;
      sendProgress();
      runNext();
    });
  }

  runNext();
}

// Cache mémoire court (2 min) du flux cyclones NHC — évite de spammer le
// service ArcGIS à chaque ouverture du panneau ou tick de rafraîchissement.
const NHC_CACHE_MS = 2 * 60 * 1000;
const nhcCache = {}; // par bassin : { AT: {at, data}, EP: {at, data} }

const NHC_BASE = "https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer";
// Slots de couches ArcGIS pour les tempêtes actives par bassin (5 créneaux, décalage de 26
// par créneau) : chaque slot expose points de prévision / trace de prévision / cône
// d'incertitude / trace passée. AT = Atlantique (base 6), EP = Pacifique Est (base 136).
const NHC_BASIN_BASE = { AT: 6, EP: 136 };

function nhcLayersForBasin(basin){
  const base = NHC_BASIN_BASE[basin] || NHC_BASIN_BASE.AT;
  return [0, 1, 2, 5, 6].flatMap((o) => [0, 26, 52, 78, 104].map((slot) => base + o + slot));
}

function fetchNhcLayer(layerId){
  return new Promise((resolve) => {
    const url = `${NHC_BASE}/${layerId}/query?where=1%3D1&outFields=*&f=geojson`;
    https.get(url, (r) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => {
        try {
          resolve({ layerId, data: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } catch (e) {
          resolve({ layerId, data: null });
        }
      });
    }).on("error", () => resolve({ layerId, data: null }));
  });
}

async function proxyNhcCyclones(req, res){
  try {
    const params = new URLSearchParams(req.url.split("?")[1] || "");
    const basin = NHC_BASIN_BASE[params.get("basin")] ? params.get("basin") : "AT";

    const cached = nhcCache[basin];
    if (cached && Date.now() - cached.at < NHC_CACHE_MS) {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(cached.data));
      return;
    }

    const results = await Promise.all(nhcLayersForBasin(basin).map(fetchNhcLayer));
    const byLayer = {};
    results.forEach(({ layerId, data }) => { byLayer[layerId] = data; });

    nhcCache[basin] = { at: Date.now(), data: byLayer };
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(byLayer));
  } catch (e) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Erreur proxy NHC");
  }
}

// --- Suivi terrain temps réel (agents en mission + repères photo d'événement) ---
// État en mémoire uniquement (process courant) : pas de persistance disque, c'est
// un usage ponctuel pendant une intervention/un événement, pas un historique.
const agentsState = new Map();  // agentName -> { lat, lng, accuracy, timestamp }
const eventMarkers = new Map(); // id -> { id, agentName, lat, lng, timestamp, photoUrl, note }
const wsClients = new Set();

function broadcast(msg, exceptWs){
  const payload = JSON.stringify(msg);
  for (const client of wsClients) {
    if (client === exceptWs || client.readyState !== 1) continue;
    client.send(payload);
  }
}

function handleAgentMessage(ws, raw){
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }

  if (msg.type === "hello") {
    if (msg.role === "agent" && typeof msg.agentName === "string" && msg.agentName.trim()) {
      ws.agentName = msg.agentName.trim().slice(0, 40);
    }
    if (msg.role === "viewer") {
      ws.send(JSON.stringify({
        type: "snapshot",
        agents: Array.from(agentsState.values()),
        events: Array.from(eventMarkers.values()),
      }));
    }
    return;
  }

  if (msg.type === "position") {
    if (typeof msg.agentName !== "string" || !msg.agentName.trim()) return;
    if (typeof msg.lat !== "number" || typeof msg.lng !== "number") return;
    const agentName = msg.agentName.trim().slice(0, 40);
    const entry = {
      agentName,
      lat: msg.lat,
      lng: msg.lng,
      accuracy: typeof msg.accuracy === "number" ? msg.accuracy : null,
      timestamp: typeof msg.timestamp === "number" ? msg.timestamp : Date.now(),
    };
    agentsState.set(agentName, entry);
    broadcast({ type: "position", ...entry }, ws);
    return;
  }

  if (msg.type === "event-marker") {
    if (typeof msg.agentName !== "string" || !msg.agentName.trim()) return;
    if (typeof msg.lat !== "number" || typeof msg.lng !== "number") return;
    if (typeof msg.photoUrl !== "string" || !msg.photoUrl.startsWith("/event-photos/")) return;
    const id = typeof msg.id === "string" && msg.id ? msg.id : crypto.randomUUID();
    const entry = {
      id,
      agentName: msg.agentName.trim().slice(0, 40),
      lat: msg.lat,
      lng: msg.lng,
      timestamp: typeof msg.timestamp === "number" ? msg.timestamp : Date.now(),
      photoUrl: msg.photoUrl,
      note: typeof msg.note === "string" ? msg.note.slice(0, 500) : "",
    };
    eventMarkers.set(id, entry);
    broadcast({ type: "event-marker", ...entry }, ws);
    return;
  }
}

function handleAgentClose(ws){
  wsClients.delete(ws);
  if (ws.agentName && agentsState.has(ws.agentName)) {
    agentsState.delete(ws.agentName);
    broadcast({ type: "agent-offline", agentName: ws.agentName });
  }
}

// Sauvegarde la photo jointe à un signalement d'événement (multipart/form-data,
// champ fichier "photo" + champs texte agentName/lat/lng/note) et répond son URL
// publique. Le WebSocket ne transporte ensuite que cette URL, pas le binaire.
async function handleUploadEvent(req, res){
  const form = formidable({
    uploadDir: EVENT_PHOTOS_DIR,
    keepExtensions: true,
    maxFileSize: 8 * 1024 * 1024,
    filter: (part) => !part.name || part.name !== "photo" || (part.mimetype || "").startsWith("image/"),
  });

  let fields, files;
  try {
    [fields, files] = await form.parse(req);
  } catch (e) {
    res.writeHead(413, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ error: "Fichier trop volumineux ou invalide." }));
    return;
  }

  const file = Array.isArray(files.photo) ? files.photo[0] : files.photo;
  if (!file) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ error: "Aucune photo reçue." }));
    return;
  }

  const agentName = (Array.isArray(fields.agentName) ? fields.agentName[0] : fields.agentName || "agent").trim();
  const slug = agentName.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  const ALLOWED_EXT = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
  const rawExt = path.extname(file.originalFilename || "").toLowerCase();
  const ext = ALLOWED_EXT.includes(rawExt) ? rawExt : ".jpg";
  const id = `evt-${Date.now()}-${slug}`;
  const finalPath = path.join(EVENT_PHOTOS_DIR, id + ext);

  fs.rename(file.filepath, finalPath, (err) => {
    if (err) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Échec de l'enregistrement de la photo." }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ id, url: `/event-photos/${id}${ext}` }));
  });
}

// Certificat HTTPS auto-signé (dev/reseau local) — genere via openssl dans certs/.
// navigator.geolocation exige un contexte securise (https ou localhost) : sans
// certificat, la PWA terrain ne peut pas obtenir la position sur une IP LAN.
const CERT_KEY_PATH = path.join(baseDir, "certs", "server.key");
const CERT_CRT_PATH = path.join(baseDir, "certs", "server.crt");
const hasCerts = fs.existsSync(CERT_KEY_PATH) && fs.existsSync(CERT_CRT_PATH);

function requestHandler(req, res){
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";

  if (urlPath === "/ign-proxy") {
    proxyIgnTile(req, res);
    return;
  }

  if (urlPath === "/ign-prefetch") {
    prefetchIgnTiles(req, res);
    return;
  }

  if (urlPath === "/nhc-cyclones") {
    proxyNhcCyclones(req, res);
    return;
  }

  if (urlPath === "/upload-event" && req.method === "POST") {
    handleUploadEvent(req, res);
    return;
  }

  const filePath = path.join(baseDir, urlPath);

  if (!filePath.startsWith(baseDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (urlPath.startsWith("/terrain-tiles/")) {
        res.writeHead(200, { "Content-Type": "image/png", "Access-Control-Allow-Origin": "*" });
        res.end(BLANK_PNG);
        return;
      }
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(data);
  });
}

const server = hasCerts
  ? https.createServer({ key: fs.readFileSync(CERT_KEY_PATH), cert: fs.readFileSync(CERT_CRT_PATH) }, requestHandler)
  : http.createServer(requestHandler);

// WebSocket temps réel (positions agents + repères d'événement), attaché au même
// serveur HTTP/HTTPS sur le chemin /agent-ws (pas de port séparé).
const wss = new WebSocketServer({ noServer: true });
wss.on("connection", (ws) => {
  wsClients.add(ws);
  ws.on("message", (data) => handleAgentMessage(ws, data));
  ws.on("close", () => handleAgentClose(ws));
});

server.on("upgrade", (req, socket, head) => {
  const urlPath = req.url.split("?")[0];
  if (urlPath !== "/agent-ws") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

function lanAddresses(){
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
}

server.listen(PORT, "0.0.0.0", () => {
  const scheme = server instanceof https.Server ? "https" : "http";
  const url = `${scheme}://localhost:${PORT}/index.html`;
  console.log(`CARTO PCS : serveur demarre sur ${url}`);
  lanAddresses().forEach((ip) => {
    console.log(`  Reseau local : ${scheme}://${ip}:${PORT}/index.html  (supervision)`);
    console.log(`                 ${scheme}://${ip}:${PORT}/agent.html  (terrain)`);
  });
  if (!hasCerts) {
    console.log("Pas de certificat HTTPS (certs/server.key + certs/server.crt absents) : la geolocalisation mobile ne fonctionnera pas hors localhost.");
  }
  console.log("Laissez cette fenetre ouverte. Fermez-la pour arreter le serveur.");

  const openCmd =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(openCmd);
});
