# GResearch

Henter historiske data (2019–2025) fra ProCyclingStats (PCS) til skemaet `velo` i Supabase. Dataene er intern reference til ProjectVelo og vises ingen steder.

- Løbslisten er alle distinkte `pcs_slug` i `velo.races` med `year = 2026`.
- Årene hentes nyeste først (2025 → 2019). Løb, etaper og resultater hentes for alle år, før rytterne hentes til sidst.
- Al hentning går gennem FlareSolverr på DigitalOcean-VM'en med én fast session, så Cloudflare-cookien genbruges. Der er én forespørgsel ad gangen og en tilfældig pause på 5–10 sek.
- Rå HTML gemmes i `cache/pcs/<sti>.html`. Findes filen, bruges den uden netværk, så en afbrudt kørsel kan startes igen, og parseren kan rettes og køres igen uden nye opslag.

## Hvad der hentes

| PCS-side | Giver |
| --- | --- |
| `race/<slug>/<år>` | løbsnavn og etapeliste. For endagsløb er det også resultatsiden |
| `race/<slug>-<år>-stage-<N>` | dato, distance, højdemeter, profile score, gradient final km, won how, profilikon (`p0`–`p5`), parcours type, resultat, GC efter etapen, dagens sprint- og bjergpoint |
| `…/live/kms-in-the-break` | udbruds-km. Siden hentes kun for etaper, hvor PCS har markeret udbrydere |
| `rider/<slug>` | fødselsdato, vægt, højde og specialepoint (One day, GC, TT, Sprint, Climber, Hills) |

**Resultatrækker:** de 30 bedste pr. etape plus alle med PCS' udbrudsikon. I en holdtidskørsel får hver rytter holdets placering og holdets tidsforskel plus sit eget tidstab.

**`km_in_break`** er PCS' "KM before peloton", men kun for ryttere med udbrudsikonet. Det er samme tal, som Bodega Bets gemmer i `public.cycling_results` for 2026. Fra 2020 får ryttere uden ikon 0. PCS har ikke udbruds-km for 2019, så dér er værdien `null` for alle.

**`rider_specialties.captured_on`** er den dato, rytterens side blev hentet. Derfor giver en genkørsel fra cachen samme række.

## Installation på VM'en

Kræver Node 22.18 eller nyere (24 anbefales). Projektet kører TypeScript direkte i Node og har ingen build-trin.

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs tmux git
node --version   # v24.x
```

### Få projektet over på VM'en

På VM'en:

```bash
git clone https://github.com/MikkelStaehr/GResearch.git ~/gresearch
cd ~/gresearch
npm ci
```

Senere opdateringer hentes med `git pull && npm ci`. Cachen, loggene og `.env` ligger uden for git og bevares.

### Miljøvariabler

Opret `~/gresearch/.env` på VM'en (filen kommer ikke i git) med samme navne som i `.env.example`:

```bash
cp .env.example .env
nano .env
chmod 600 .env
```

| Variabel | |
| --- | --- |
| `DATABASE_URL` | Postgres-forbindelsesstreng til Supabase (session pooler). Scraperen skriver direkte via `pg`, og `velo` er ikke eksponeret i API'et |
| `DATABASE_CA_CERT` | valgfri sti til Supabase' CA-certifikat (Dashboard → Database → SSL Configuration). Med den verificeres databasens certifikat |
| `FLARESOLVERR_URL` | den FlareSolverr, der allerede kører på VM'en, fx `http://localhost:8191` |
| `PCS_DELAY_MIN_S` / `PCS_DELAY_MAX_S` | pause mellem opslag. Standard 5 og 10 sek. |
| `PCS_FAILURE_WAIT_S` | ventetid efter Cloudflare-side eller FlareSolverr-fejl. Standard 300 sek. |
| `PCS_CACHE_DIR` | valgfri anden placering af cachen. Standard er `./cache/pcs` |

Tjek, at FlareSolverr svarer:

```bash
curl -s http://localhost:8191/        # {"msg": "FlareSolverr is ready!", ...}
```

## Kommandoer

```bash
npm run scrape -- [--race <slug>] [--year <år>] [--only stages|results|riders] [--dry-run] [--offline]
npm run counts -- [--race <slug>] [--year <år>]
```

- `--only stages`: løb og etaper.
- `--only results`: løb, etaper og resultater, inkl. udbruds-km.
- `--only riders`: kun ryttere og specialepoint for ryttere i `velo.results`, der mangler dem.
- `--dry-run`: henter (via cachen) og parser, og printer eksempelrækker uden at skrive til databasen.
- `--offline`: kun cachen, ingen FlareSolverr. Bruges til at køre parseren igen efter en rettelse.

Der logges én linje pr. løb og år: etaper, resultatrækker, ryttere, rækker med `km_in_break`, manglende felter, tidsforbrug og antal opslag. Alt skrives også til `logs/run-<tidspunkt>.log`.

## Test på VM'en (fase 3)

Cloudflare blokerer efter IP, så testen skal køres fra VM'en.

```bash
cd ~/gresearch
# 1) Hent og parse etaper og resultater uden at skrive. ~40 sider, ca. 8 min.
#    Viser, om FlareSolverr kommer igennem Cloudflare fra VM'ens IP.
npm run scrape -- --race tour-de-france --year 2024 --only results --dry-run
# 2) Skriv løb, etaper, resultater og ryttere til velo. Etapesiderne kommer
#    nu fra cachen; ryttersiderne (~150-200) tager ca. 30-40 min.
npm run scrape -- --race tour-de-france --year 2024
npm run counts -- --race tour-de-france --year 2024
# 3) Kør igen. Alt kommer fra cachen uden opslag, og rækkeantallet skal være uændret
npm run scrape -- --race tour-de-france --year 2024
npm run counts -- --race tour-de-france --year 2024
```

## Fuld kørsel i tmux

```bash
tmux new -s gresearch
cd ~/gresearch && npm run scrape 2>&1 | tee -a logs/console.log
# Kobl fra med Ctrl-b og derefter d. Kørslen fortsætter, når du logger ud.
tmux attach -t gresearch      # kobl på igen
tail -f logs/run-*.log        # følg med uden at koble på
```

**Exit-koder:**

- `0`: færdig.
- `2`: stoppet pænt efter 20 fejl i træk. Kør samme kommando igen senere; alt hentet ligger i cachen.
- `1`: anden fejl, se loggen.

**Fejlpolitik:**

- Ved Cloudflare-side, 403/429/5xx eller fejl fra FlareSolverr venter scraperen 5 min, opretter en ny session og prøver igen.
- Efter 3 fejl i træk på samme side springes siden over og logges.
- Sprungne sider hentes ved næste kørsel.

## Estimat

Dette er et skøn ud fra 29 løb (10 etapeløb og 19 endagsløb) gange 7 år:

| Del | Opslag |
| --- | --- |
| Løbssider | ~200 |
| Etapesider | ~760 |
| kms-sider (kun etaper med udbrud) | ~750 |
| Ryttersider | ~1.500–2.500 |
| **I alt** | **~3.200–4.200** |

Hvert opslag tager ca. 11 sek. (7,5 sek. pause i snit plus ca. 3–4 sek. i FlareSolverr). Det giver:

- **Løb, etaper og resultater:** ca. 5–6 timer.
- **Ryttere:** ca. 5–8 timer.
- **I alt:** ca. 10–14 timer.

Hver Cloudflare-blokering lægger 5 min oveni. Cachen fylder ca. 1–1,5 GB.

## Oprindelse

Parserne bygger på Bodega Bets' scraper (`lib/syncCyclingResults.ts`, `lib/pcsFetch.ts`, `lib/cyclingRiderEnrichment.ts`, commit `b021a60`). Koden er kopieret og tilpasset, så de to projekter ikke afhænger af hinanden.
