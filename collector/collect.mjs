/**
 * CraftScout — collecteur de prix POE2Scout (v2, endpoints vérifiés à la source)
 * ------------------------------------------------------------------------------
 * Endpoints réels (lus dans le code source github.com/poe2scout/poe2scout) :
 *   GET /api/Realms                                  → liste des realms (snake_case)
 *   GET /api/{Realm}/Leagues                         → leagues, champs PascalCase (IsCurrent, DivinePrice…)
 *   GET /api/{Realm}/Leagues/{LeagueName}/Items      → TOUS les items avec CurrentPrice (en Exalted)
 *
 * Exécution : node collector/collect.mjs
 * Sorties   : data/latest.json   (prix du moment, mappés sur les clés de l'app)
 *             data/history.json  (un point par run, cap 5000)
 *             data/raw/*.json    (réponses brutes, pour debug du mapping)
 *
 * Aucune dépendance : Node 20+ (fetch natif).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const CONTACT_EMAIL = process.env.POE2SCOUT_CONTACT_EMAIL || "ton-email@exemple.com";
const BASE = "https://poe2scout.com/api";
const DATA_DIR = "data";
const RAW_DIR = `${DATA_DIR}/raw`;
const HISTORY_CAP = 5000;

/* ----------------------------------------------------------------
 * MAPPING : clé de l'app → nom(s) exact(s) de l'item (champ Text).
 * Plusieurs noms = moyenne des prix trouvés (utile pour les paires
 * Sinistral/Dextral). Les bases d'items restent manuelles dans l'app
 * (faible volume, non couvertes par l'API).
 * ---------------------------------------------------------------- */
const TARGETS = {
  divine:       ["Divine Orb"],
  exalt:        ["Exalted Orb"],
  greaterExalt: ["Greater Exalted Orb"],
  regal:        ["Regal Orb"],
  chaos:        ["Chaos Orb"],
  annul:        ["Orb of Annulment"],
  fracturing:   ["Fracturing Orb"],
  artificer:    ["Artificer's Orb"],
  putrefaction: ["Omen of Putrefaction"],
  echoes:       ["Omen of Abyssal Echoes"],
  necromancy:   ["Omen of Sinistral Necromancy", "Omen of Dextral Necromancy"],
  light:        ["Omen of Light"],
  dirExalt:     ["Omen of Sinistral Exaltation", "Omen of Dextral Exaltation"],
  whittling:    ["Omen of Whittling"],
  rib:          ["Preserved Rib"],
  boneJewel:    ["Preserved Collarbone", "Preserved Clavicle", "Preserved Vertebrae"],
};

/* ---------------------------------------------------------------- */

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": `CraftScout/0.2 (contact: ${CONTACT_EMAIL})`,
      "Accept": "application/json",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} sur ${url}`);
  return res.json();
}

async function dumpRaw(name, payload) {
  await mkdir(RAW_DIR, { recursive: true });
  await writeFile(`${RAW_DIR}/${name}.json`, JSON.stringify(payload, null, 2));
}

/** Lecture tolérante PascalCase / camelCase / snake_case. */
function field(obj, ...names) {
  for (const n of names) {
    if (obj?.[n] !== undefined && obj?.[n] !== null) return obj[n];
  }
  return undefined;
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  /* 1. Realm PoE2 (réponse en snake_case d'après la source) */
  let realm = "poe2";
  try {
    const realms = await fetchJson(`${BASE}/Realms`);
    await dumpRaw("realms", realms);
    const poe2 = (Array.isArray(realms) ? realms : []).find(
      r => field(r, "game_api_id", "GameApiId") === "poe2"
    );
    if (poe2) realm = field(poe2, "value", "Value") || realm;
  } catch (e) {
    console.warn(`/Realms indisponible (${e.message}), realm par défaut : ${realm}`);
  }
  console.log(`Realm : ${realm}`);

  /* 2. League courante (champs PascalCase : Value, IsCurrent, DivinePrice…) */
  const leagues = await fetchJson(`${BASE}/${encodeURIComponent(realm)}/Leagues`);
  await dumpRaw("leagues", leagues);
  const list = Array.isArray(leagues) ? leagues : [];
  const current =
    list.find(l => field(l, "IsCurrent", "isCurrent", "is_current") === true) ||
    list.find(l => !/standard/i.test(field(l, "Value", "value") || "")) ||
    list[0];
  if (!current) throw new Error("Aucune league renvoyée par l'API");
  const leagueName = field(current, "Value", "value");
  const divinePrice = field(current, "DivinePrice", "divinePrice", "divine_price");
  console.log(`League courante : ${leagueName} (Divine ≈ ${divinePrice} ex)`);

  /* 3. Tous les items de la league en un appel */
  const items = await fetchJson(
    `${BASE}/${encodeURIComponent(realm)}/Leagues/${encodeURIComponent(leagueName)}/Items`
  );
  if (!Array.isArray(items)) throw new Error("Réponse Items inattendue (pas un tableau)");
  console.log(`${items.length} items reçus`);
  // Dump compact : seulement les champs utiles, sinon le fichier raw est énorme
  await dumpRaw("items-sample", items.slice(0, 40));

  /* 4. Index par nom (Text pour la currency, Name pour les uniques) */
  const byName = new Map();
  for (const it of items) {
    const price = field(it, "CurrentPrice", "currentPrice", "current_price");
    if (typeof price !== "number" || !(price > 0)) continue;
    for (const n of [field(it, "Text", "text"), field(it, "Name", "name")]) {
      if (n && !byName.has(n.toLowerCase())) byName.set(n.toLowerCase(), price);
    }
  }

  /* 5. Mapper sur nos clés */
  const prices = {};
  const missing = [];
  for (const [key, names] of Object.entries(TARGETS)) {
    const found = names
      .map(n => byName.get(n.toLowerCase()))
      .filter(v => typeof v === "number");
    if (found.length) {
      prices[key] = {
        ex: Math.round((found.reduce((s, v) => s + v, 0) / found.length) * 100) / 100,
        source: names.filter(n => byName.has(n.toLowerCase())).join(" / "),
      };
    } else {
      missing.push(key);
    }
  }
  // Le Divine vient aussi de l'endpoint Leagues : on le préfère s'il est cohérent
  if (typeof divinePrice === "number" && divinePrice > 0) {
    prices.divine = { ex: Math.round(divinePrice * 100) / 100, source: "Leagues.DivinePrice" };
    const i = missing.indexOf("divine");
    if (i >= 0) missing.splice(i, 1);
  }

  /* 6. Écrire latest.json */
  const now = new Date().toISOString();
  const latest = { fetchedAt: now, league: leagueName, realm, unit: "exalted", prices, missing };
  await writeFile(`${DATA_DIR}/latest.json`, JSON.stringify(latest, null, 2));
  console.log(
    `latest.json écrit — ${Object.keys(prices).length} prix mappés` +
    (missing.length ? `, manquants : ${missing.join(", ")}` : "")
  );

  /* 7. Accumuler l'historique */
  let history = [];
  const histPath = `${DATA_DIR}/history.json`;
  if (existsSync(histPath)) {
    try { history = JSON.parse(await readFile(histPath, "utf8")); } catch { history = []; }
  }
  const point = { t: now };
  for (const [k, v] of Object.entries(prices)) point[k] = v.ex;
  history.push(point);
  if (history.length > HISTORY_CAP) history = history.slice(history.length - HISTORY_CAP);
  await writeFile(histPath, JSON.stringify(history));
  console.log(`history.json : ${history.length} points`);
}

main().catch(e => {
  console.error("ÉCHEC DU COLLECTEUR :", e);
  process.exit(1);
});
