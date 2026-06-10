# CraftScout — calculateur de rentabilité de craft PoE2

Outil compagnon pour la league **Runes of Aldur (0.5)** : classement des crafts par
profit moyen par tentative, prix tirés de l'API publique POE2Scout, historique
accumulé automatiquement, alertes de prix.

## Contenu du repo

```
index.html                      → l'application (page statique, zéro dépendance)
collector/collect.mjs           → le collecteur de prix (Node 20, zéro dépendance)
.github/workflows/collect.yml   → exécution horaire du collecteur via GitHub Actions
data/                           → créé automatiquement par le collecteur
  latest.json                   → prix du moment
  history.json                  → un point par heure, cap 5000
  raw/                          → réponses brutes de l'API (debug du mapping)
```

## Déploiement (une fois, ~10 minutes)

1. **Créer un repo GitHub** (public, pour que GitHub Pages soit gratuit), y pousser
   tout le contenu de ce dossier.

2. **Renseigner ton email de contact** (politesse demandée par l'API POE2Scout) :
   repo → Settings → Secrets and variables → Actions → onglet **Variables** →
   New repository variable → nom `POE2SCOUT_CONTACT_EMAIL`, valeur ton email.

3. **Lancer le collecteur une première fois à la main** :
   onglet Actions → "Collecte des prix POE2Scout" → Run workflow.
   Vérifier dans les logs que des prix sont mappés. S'il y a des items dans
   `missing`, regarder les noms exacts dans `data/raw/items-*.json` et corriger
   le tableau `TARGETS` en haut de `collector/collect.mjs`.

4. **Activer GitHub Pages** : Settings → Pages → Source = "Deploy from a branch",
   branche `main`, dossier `/ (root)`. L'app sera servie sur
   `https://TON-PSEUDO.github.io/NOM-DU-REPO/` et lira `data/latest.json` en
   chemin relatif — pas de CORS, pas de serveur.

5. C'est tout. Le cron tourne toutes les heures, chaque exécution committe les
   nouveaux prix, et l'historique grossit tout seul. Le bandeau sous le titre de
   l'app indique "PRIX LIVE" + la fraîcheur des données quand tout fonctionne.

## Ce qui reste manuel (par design)

- **Les bases d'items** (Vile Robe fracturée, rares prometteurs, uniques bas
  niveau…) : l'API POE2Scout ne couvre que les items à fort volume. Ces prix se
  saisissent dans l'app, section "Bases & items de départ".
- **Les probabilités et valeurs de revente** des paliers : ce sont des hypothèses
  à calibrer avec l'expérience réelle (et le price check en jeu).

## Test local du collecteur (optionnel)

```bash
POE2SCOUT_CONTACT_EMAIL=ton@email.fr node collector/collect.mjs
```

Puis ouvrir `index.html` via un petit serveur local (`npx serve .` ou
`python3 -m http.server`) — le `fetch` de fichiers locaux ne marche pas en
ouvrant le fichier directement.

## Pistes V3 (plus tard)

- Ledger personnel : log des tentatives réelles → calibration automatique des
  probabilités et reventes.
- Alertes persistées (actuellement en mémoire) + notification.
- Flipping : détection d'écarts unitaire/bulk sur l'exchange.
