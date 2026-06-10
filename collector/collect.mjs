/**
 * CraftScout — collecteur de prix POE2Scout
 * ------------------------------------------
 * Exécution : node collector/collect.mjs
 * Sorties   : data/latest.json        (prix du moment, mappés sur les clés de l'app)
 *             data/history.json       (séries temporelles, ajout d'un point par run, cap 5000)
 *             data/raw/*.json         (réponses brutes de l'API, pour debug/mapping)
 *
 * Aucune dépendance : Node 20+ (fetch natif).
 *
 * IMPORTANT : renseigne ton email dans CONTACT_EMAIL (politesse demandée par l'API
 * POE2Scout pour identifier les consommateurs). En GitHub Actions, il est lu depuis
 * la variable d'environnement POE2SCOUT_CONTACT_EMAIL si définie.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const CONTACT_EMAIL = process.env.POE2SCOUT_CONTACT_EMAIL || "ton-email@exemple.com";
const BASE = "https://poe2scout.com/api";
const DATA_DIR = "data";
const RAW_DIR = `${DATA_DIR}/raw`;
const HISTORY_CAP = 5000;

/* ----------------------------------------------------------------
 * MAPPING : clé de l'app  →  nom exact de l'item côté POE2Scout.
 * Les bases d'items (Vile Robe fracturée, rares prometteurs…) ne sont
 * volontairement PAS ici : faible volume, l'API ne les couvre pas —
 * elles restent éditables à la main dans l'app.
 * Si un nom ne matche pas, il apparaîtra dans latest.json → missing,
 * et la réponse brute correspondante est dans data/raw/ pour corriger.
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
  necromancy:   ["Omen of Sinistral Necromancy", "Omen of Dextral Necromancy"], // moyenne des deux
  light:        ["Omen of Light"],
  dirExalt:     ["Omen of Sinistral Exaltation", "Omen of Dextral Exaltation"], // moyenne des deux
  whittling:    ["Omen of Whittling"],
  rib:          ["Preserved Rib"],
  boneJewel:    ["Preserved Collarbone", "Preserved Clavicle"], // premier nom trouvé
};

/* ---------------------------------------------------------------- */

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": `CraftScout/0.1 (contact: ${CONTACT_EMAIL})`,
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

/** Extraction de prix tolérante : les schémas varient selon les versions de l'API. */
function extractPrice(item) {
  const candidates = [
    item?.currentPrice,
    item?.price,
    item?.latest_price?.price,
    item?.latestPrice?.price,
    item?.priceLogs?.[0]?.price,
  ];
  for (const c of candidates) {
    const n = typeof c === "string" ? parseFloat(c) : c;
    if (typeof n === "number" && isFinite(n) && n > 0) return n;
  }
  return null;
}

function extractName(item) {
  return item?.name || item?.text || item?.itemMetadata?.name || item?.apiId || null;
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  /* 1. Leagues : trouver la league courante */
  const leagues = await fetchJson(`${BASE}/leagues`);
  await dumpRaw("leagues", leagues);
  const leagueList = Array.isArray(leagues) ? leagues : leagues?.leagues || [];
  const current =
    leagueList.find(l => l?.isCurrent || l?.IsCurrent) ||
    leagueList.find(l => !/standard/i.test(l?.value || l?.name || "")) ||
    leagueList[0];
  const leagueName = current?.value || current?.name || "Standard";
  console.log(`League courante détectée : ${leagueName}`);

  /* 2. Catégories d'items currency */
  let categories = [];
  try {
    const cats = await fetchJson(`${BASE}/items/categories`);
    await dumpRaw("categories", cats);
    categories = (cats?.currency_categories || cats?.currencyCategories || cats || [])
      .map(c => c?.apiId || c?.id || c)
      .filter(c => typeof c === "string");
  } catch (e) {
    console.warn("Endpoint catégories indisponible, fallback :", e.message);
  }
  if (!categories.length) {
    // Fallback raisonnable d'après le repo poe2scout
    categories = ["currency", "essences", "ritual", "abyss", "fragments", "runes"];
  }
  console.log(`Catégories à parcourir : ${categories.join(", ")}`);

  /* 3. Récupérer tous les items currency par catégorie */
  const allItems = [];
  for (const cat of categories) {
    try {
      const page = await fetchJson(
        `${BASE}/items/currency/${encodeURIComponent(cat)}?league=${encodeURIComponent(leagueName)}&perPage=250`
      );
      await dumpRaw(`items-${cat}`, page);
      const items = page?.items || page?.data || (Array.isArray(page) ? page : []);
      console.log(`  ${cat}: ${items.length} items`);
      allItems.push(...items);
    } catch (e) {
      console.warn(`  ${cat}: échec (${e.message})`);
    }
  }

  /* 4. Mapper sur nos clés */
  const byName = new Map();
  for (const it of allItems) {
    const n = extractName(it);
    const p = extractPrice(it);
    if (n && p !== null && !byName.has(n.toLowerCase())) byName.set(n.toLowerCase(), p);
  }

  const prices = {};
  const missing = [];
  for (const [key, names] of Object.entries(TARGETS)) {
    const found = names
      .map(n => byName.get(n.toLowerCase()))
      .filter(v => typeof v === "number");
    if (found.length) {
      prices[key] = {
        ex: Math.round((found.reduce((s, v) => s + v, 0) / found.length) * 100) / 100,
        source: names.join(" / "),
      };
    } else {
      missing.push(key);
    }
  }

  /* 5. Écrire latest.json */
  const now = new Date().toISOString();
  const latest = { fetchedAt: now, league: leagueName, unit: "exalted", prices, missing };
  await writeFile(`${DATA_DIR}/latest.json`, JSON.stringify(latest, null, 2));
  console.log(`latest.json écrit — ${Object.keys(prices).length} prix mappés, ${missing.length} manquants${missing.length ? " (" + missing.join(", ") + ")" : ""}`);

  /* 6. Accumuler l'historique */
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
