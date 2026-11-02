import { FIRST_BREAK_DATA_YEAR, ONE_DAY_STAGE_NUMBER, TOP_N } from './config.ts'
import type { Db, ResultRowDb, RiderStub, StageRowDb } from './db.ts'
import { log } from './log.ts'
import type { PcsClient } from './pcs/client.ts'
import { parseKmsPage } from './parse/kms.ts'
import { parseRacePage } from './parse/race.ts'
import { parseRiderPage } from './parse/rider.ts'
import { type StagePage, type StageRow, parseStagePage } from './parse/stage.ts'

export type Only = 'stages' | 'results' | 'riders' | null

export type RunContext = {
  client: PcsClient
  /** null ved --dry-run: der parses og printes, men skrives ikke. */
  db: Db | null
  only: Only
  /** Ryttere set i denne kørsel (bruges af rytterfasen ved --dry-run). */
  seenRiders: Map<string, string | null>
}

const fmtDuration = (ms: number) => `${Math.floor(ms / 60000)}m${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s`

/** "VAN DER POEL Mathieu" → efternavn med versaler først, så fornavn. */
export function splitListedName(listed: string): { firstName: string | null; lastName: string | null } {
  const tokens = listed.split(' ').filter(Boolean)
  const isUpper = (t: string) => /\p{L}/u.test(t) && t === t.toUpperCase()
  let i = 0
  while (i < tokens.length && isUpper(tokens[i])) i++
  const last = tokens.slice(0, i).join(' ')
  const first = tokens.slice(i).join(' ')
  // Midlertidig store/små-bogstavsform; rytterfasen retter efternavnet ud fra ryttersiden.
  const titled = last.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase())
  return { firstName: first || null, lastName: titled || null }
}

/** Efternavn ud fra ryttersidens fulde navn: "Mathieu van der Poel" minus fornavnet "Mathieu". */
export function lastNameFromFull(fullName: string | null, firstName: string | null): string | null {
  if (!fullName || !firstName) return null
  const prefix = firstName + ' '
  return fullName.startsWith(prefix) ? fullName.slice(prefix.length).trim() || null : null
}

/** Top 30 i PCS' rækkefølge plus alle med udbrudsikon. */
function selectRows(rows: StageRow[]): StageRow[] {
  const top = new Set(rows.filter((r) => r.position != null).slice(0, TOP_N).map((r) => r.riderSlug))
  return rows.filter((r) => top.has(r.riderSlug) || r.inBreak)
}

type ParsedStage = { stageNumber: number; isTimeTrial: boolean; page: StagePage; kms: Map<string, number | null> | null }

export async function scrapeRaceYear(ctx: RunContext, slug: string, raceType2026: string | null, year: number): Promise<void> {
  const started = Date.now()
  const net0 = ctx.client.stats.network
  const tag = `[${year} ${slug}]`
  const withResults = ctx.only !== 'stages'

  const racePage = await ctx.client.get(`race/${slug}/${year}`)
  if (racePage.kind !== 'ok') {
    log.warn(`${tag} løbssiden ${racePage.kind === 'missing' ? 'findes ikke (404)' : 'kunne ikke hentes'}; springer over`)
    return
  }
  const race = parseRacePage(racePage.html, year)
  const isStageRace = race.stages.length > 0
  const raceType = raceType2026 ?? (isStageRace ? 'stage_race' : 'one_day')
  if (raceType2026 && (raceType2026 === 'stage_race') !== isStageRace) {
    log.warn(`${tag} race_type i 2026 er ${raceType2026}, men PCS viser ${isStageRace ? `${race.stages.length} etaper` : 'et endagsløb'}`)
  }
  for (const s of race.splitStages) log.warn(`${tag} delt etape springes over (passer ikke i stage_number): ${s}`)

  // Etapesider. For endagsløb er løbssiden selv resultatsiden.
  const parsed: ParsedStage[] = []
  const refs = isStageRace
    ? race.stages
    : [{ path: racePage.path, stageNumber: ONE_DAY_STAGE_NUMBER, label: '', isTimeTrial: false }]
  for (const ref of refs) {
    const page = isStageRace ? await ctx.client.get(ref.path) : racePage
    if (page.kind !== 'ok') {
      log.warn(`${tag} etape ${ref.stageNumber}: siden ${page.kind === 'missing' ? 'findes ikke (404)' : 'blev sprunget over'}`)
      continue
    }
    const sp = parseStagePage(page.html)
    if (sp.rows.length === 0) {
      log.warn(`${tag} etape ${ref.stageNumber}: ingen resultater på PCS (ikke kørt?)`)
      continue
    }
    const isTimeTrial = ref.isTimeTrial || sp.isTtt || /\((ITT|TTT)\)|prologue/i.test(sp.info.title ?? '')
    parsed.push({ stageNumber: ref.stageNumber, isTimeTrial, page: sp, kms: null })
  }
  if (parsed.length === 0) {
    log.warn(`${tag} ikke kørt (ingen etaper med resultater på PCS); springer over`)
    return
  }

  // Udbruds-km: kun for etaper, hvor PCS har markeret udbrydere.
  if (withResults) {
    for (const p of parsed) {
      if (!p.page.rows.some((r) => r.inBreak)) continue
      const kmsPath = p.page.kmsPath ?? (isStageRace ? `${refs.find((r) => r.stageNumber === p.stageNumber)!.path}/live/kms-in-the-break` : `race/${slug}-${year}-result/live/kms-in-the-break`)
      const kmsPage = await ctx.client.get(kmsPath)
      if (kmsPage.kind === 'ok') p.kms = new Map(parseKmsPage(kmsPage.html).map((k) => [k.riderSlug, k.kmBeforePeloton]))
    }
  }

  // Rækker til databasen.
  const dates = parsed.map((p) => p.page.info.date).filter((d): d is string => !!d).sort()
  const riders = new Map<string, RiderStub>()
  const missing = new Map<string, number>()
  const miss = (field: string) => missing.set(field, (missing.get(field) ?? 0) + 1)
  let resultCount = 0
  let breakCount = 0

  const stages = parsed.map((p) => {
    const i = p.page.info
    const stage: StageRowDb = {
      stageNumber: p.stageNumber,
      stageDate: i.date,
      distanceKm: i.distanceKm,
      verticalMeters: i.verticalMeters,
      profileScore: i.profileScore,
      gradientFinalKm: i.gradientFinalKm,
      wonHow: i.wonHow,
      profileIcon: i.profileIcon,
      profileLabel: i.profileLabel,
      isTimeTrial: p.isTimeTrial,
    }
    for (const [k, v] of Object.entries(stage)) if (v == null) miss(`stages.${k}`)

    if (!withResults) return { stage, results: null }
    const results: ResultRowDb[] = selectRows(p.page.rows).map((r) => {
      if (!riders.has(r.riderSlug)) riders.set(r.riderSlug, { pcsSlug: r.riderSlug, ...splitListedName(r.riderName) })
      ctx.seenRiders.set(r.riderSlug, riders.get(r.riderSlug)!.firstName)
      // Kun ryttere med PCS' udbrudsikon får km. PCS har udbruds-km fra 2020; for 2019 er alle null.
      const kmInBreak = year < FIRST_BREAK_DATA_YEAR ? null : r.inBreak ? (p.kms?.get(r.riderSlug) ?? null) : 0
      if (r.inBreak && kmInBreak == null) miss('results.km_in_break (udbryder uden km)')
      if (kmInBreak) breakCount++
      if (!r.dnf && r.timeGapS == null) miss('results.time_gap_s')
      if (!r.teamName) miss('results.team_name')
      if (isStageRace && !r.dnf && r.gcPositionAfter == null) miss('results.gc_position_after')
      return {
        riderSlug: r.riderSlug,
        teamName: r.teamName,
        position: r.position,
        timeGapS: r.timeGapS,
        kmInBreak,
        dnf: r.dnf,
        abandonType: r.abandonType,
        gcPositionAfter: isStageRace ? r.gcPositionAfter : null,
        gcGapS: isStageRace ? r.gcGapS : null,
        sprintPoints: r.sprintPoints,
        mountainPoints: r.mountainPoints,
      }
    })
    resultCount += results.length
    return { stage, results }
  })

  const raceRow = { pcsSlug: slug, year, name: race.name, raceType, startDate: dates[0] ?? null, endDate: dates.at(-1) ?? null }
  if (ctx.db) {
    await ctx.db.writeRaceYear(raceRow, stages, [...riders.values()])
  } else {
    console.log(`${tag} DRY-RUN races:`, JSON.stringify(raceRow))
    for (const s of stages.slice(0, 3)) console.log(`${tag} DRY-RUN stages:`, JSON.stringify(s.stage))
    for (const r of stages.flatMap((s) => s.results ?? []).slice(0, 3)) console.log(`${tag} DRY-RUN results:`, JSON.stringify(r))
  }

  const missText = [...missing].map(([k, v]) => `${k} ${v}`).join(', ') || 'ingen'
  log.info(
    `${tag} ${stages.length} etaper, ${resultCount} resultatrækker, ${riders.size} ryttere, ` +
      `${breakCount} med km_in_break, mangler: ${missText}; ${fmtDuration(Date.now() - started)} ` +
      `(${ctx.client.stats.network - net0} opslag)`,
  )
}

export async function scrapeRiders(ctx: RunContext, targets: Array<{ pcsSlug: string; firstName: string | null }>): Promise<void> {
  const started = Date.now()
  log.info(`ryttere: ${targets.length} at hente`)
  let done = 0
  let specialties = 0
  const missing = { birth_date: 0, weight_kg: 0, height_m: 0 }
  for (const t of targets) {
    const page = await ctx.client.get(`rider/${t.pcsSlug}`)
    done++
    if (page.kind !== 'ok') {
      log.warn(`rytter ${t.pcsSlug}: ${page.kind === 'missing' ? 'findes ikke (404)' : 'sprunget over'}`)
      continue
    }
    const r = parseRiderPage(page.html)
    if (!r.birthDate) missing.birth_date++
    if (r.weightKg == null) missing.weight_kg++
    if (r.heightM == null) missing.height_m++
    if (r.specialties) specialties++
    const details = {
      pcsSlug: t.pcsSlug,
      firstName: t.firstName,
      lastName: lastNameFromFull(r.fullName, t.firstName),
      birthDate: r.birthDate,
      weightKg: r.weightKg,
      heightM: r.heightM,
    }
    // Specialepoint dateres med datoen, siden blev hentet, så en genkørsel fra cachen giver samme række.
    const capturedOn = page.fetchedAt.toISOString().slice(0, 10)
    if (ctx.db) await ctx.db.writeRider(details, r.specialties, capturedOn)
    else if (done <= 3) console.log('DRY-RUN riders:', JSON.stringify(details), JSON.stringify({ capturedOn, ...r.specialties }))
    if (done % 50 === 0) log.info(`ryttere: ${done}/${targets.length} (${fmtDuration(Date.now() - started)})`)
  }
  log.info(
    `ryttere færdig: ${done} behandlet, ${specialties} med specialepoint, mangler: ` +
      `birth_date ${missing.birth_date}, weight_kg ${missing.weight_kg}, height_m ${missing.height_m}; ${fmtDuration(Date.now() - started)}`,
  )
}
