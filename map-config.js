// Config partagée entre index.html et settings.html (bornes de la carte)
const MAP_CONFIG_KEY = 'submersion.mapConfig';

const MAP_CONFIG_DEFAULTS = {
  minLon: -61.9,
  maxLon: -61.1,
  minLat: 15.85,
  maxLat: 16.55,
  minZoom: 9,
  maxZoom: 19,
  // Élévations LIDAR sous ce seuil (m) sont ramenées à 0 — filtre la houle
  // enregistrée sur la mer au moment du survol, pour éviter un rendu bruité
  // en mode Sombre (color-relief) près du niveau 0.
  swellFilterThreshold: 0.9,
  // Code INSEE de la commune dont la limite administrative est tracée sur la carte (vide = aucune)
  communeBoundary: '',
  communeBoundaryColor: '#ffffff',
  communeBoundaryWidth: 2.2,
  // 'solid', 'dashed' ou 'dotted'
  communeBoundaryStyle: 'solid',
  // Clé API OpenWeatherMap (gratuite) pour la couche radar nuages/pluie — vide = couche désactivée
  weatherApiKey: '',
  // Bassin suivi par la couche cyclones (NHC) — 'AT' Atlantique (usage normal, Guadeloupe)
  // ou 'EP' Pacifique Est (utile pour vérifier le bon fonctionnement hors saison Atlantique,
  // le Pacifique Est étant souvent actif quand l'Atlantique est calme).
  cycloneBasin: 'AT'
};

function loadMapConfig(){
  try {
    const raw = localStorage.getItem(MAP_CONFIG_KEY);
    if (!raw) return { ...MAP_CONFIG_DEFAULTS };
    const parsed = JSON.parse(raw);
    return { ...MAP_CONFIG_DEFAULTS, ...parsed };
  } catch (e) {
    return { ...MAP_CONFIG_DEFAULTS };
  }
}

function saveMapConfig(config){
  localStorage.setItem(MAP_CONFIG_KEY, JSON.stringify(config));
}

// Préréglages de caméra (positions nommées + vue par défaut)
const MAP_PRESETS_KEY = 'submersion.cameraPresets';

const BUILTIN_DEFAULT_VIEW = { lon: -61.53, lat: 16.25, zoom: 10.2, pitch: 55, bearing: -15 };

function loadCameraPresets(){
  try {
    const raw = localStorage.getItem(MAP_PRESETS_KEY);
    if (!raw) return { list: [], defaultId: null };
    const parsed = JSON.parse(raw);
    return {
      list: Array.isArray(parsed.list) ? parsed.list : [],
      defaultId: parsed.defaultId || null
    };
  } catch (e) {
    return { list: [], defaultId: null };
  }
}

function saveCameraPresets(data){
  localStorage.setItem(MAP_PRESETS_KEY, JSON.stringify(data));
}

const BUILTIN_DEFAULT_BASEMAP = 'ortho';
const BUILTIN_DEFAULT_LAYERS = { roads: false, flood: true, communeBoundary: true };
const BUILTIN_DEFAULT_SEA_LEVEL = 0;

function getDefaultView(){
  const { list, defaultId } = loadCameraPresets();
  const found = list.find(p => p.id === defaultId);
  return found ? found.camera : BUILTIN_DEFAULT_VIEW;
}

// Préréglage complet par défaut (caméra + fond de carte + couches + niveau de mer)
function getDefaultPreset(){
  const { list, defaultId } = loadCameraPresets();
  const found = list.find(p => p.id === defaultId);
  if (!found) {
    return { camera: BUILTIN_DEFAULT_VIEW, ...normalizePreset({}) };
  }
  return { camera: found.camera, ...normalizePreset(found) };
}

// Complète un préréglage éventuellement ancien (sans fond de carte / couches / niveau de mer / groupe)
function normalizePreset(preset){
  return {
    basemap: preset.basemap || BUILTIN_DEFAULT_BASEMAP,
    layers: { ...BUILTIN_DEFAULT_LAYERS, ...(preset.layers || {}) },
    seaLevel: typeof preset.seaLevel === 'number' ? preset.seaLevel : BUILTIN_DEFAULT_SEA_LEVEL,
    group: typeof preset.group === 'string' ? preset.group.trim() : ''
  };
}

// Export / import global de la config (bornes carte + préréglages caméra)
function exportConfigBundle(){
  return {
    type: 'submersion-config',
    version: 1,
    exportedAt: new Date().toISOString(),
    mapConfig: loadMapConfig(),
    cameraPresets: loadCameraPresets()
  };
}

function downloadConfigBundle(){
  const bundle = exportConfigBundle();
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `submersion-config-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Valide et applique un bundle importé. Lance une erreur si le format est invalide.
function importConfigBundle(bundle){
  if (!bundle || typeof bundle !== 'object') {
    throw new Error('Fichier invalide.');
  }
  if (!bundle.mapConfig || !bundle.cameraPresets) {
    throw new Error("Ce fichier ne contient pas une configuration Submersion valide.");
  }

  const mapConfig = { ...MAP_CONFIG_DEFAULTS, ...bundle.mapConfig };
  const presets = {
    list: Array.isArray(bundle.cameraPresets.list) ? bundle.cameraPresets.list : [],
    defaultId: bundle.cameraPresets.defaultId || null
  };

  saveMapConfig(mapConfig);
  saveCameraPresets(presets);
  return { mapConfig, presets };
}

function readAndImportConfigFile(file){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const bundle = JSON.parse(reader.result);
        resolve(importConfigBundle(bundle));
      } catch (e) {
        reject(e);
      }
    };
    reader.onerror = () => reject(new Error('Impossible de lire le fichier.'));
    reader.readAsText(file);
  });
}
