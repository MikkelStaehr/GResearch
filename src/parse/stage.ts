/**
 * Parser en PCS-etapeside (eller resultatsiden for et endagsløb). Siden har alle
 * faner i samme HTML: etaperesultat, GC, point, bjerg m.fl., så GC efter
 * etapen kræver ikke et ekstra opslag.
 *
 * Resultattabellens logik bygger på parseResultsTable() og scrapeClassifications()
 * i Bodega Bets' lib/syncCyclingResults.ts (commit b021a60). Her slås kolonner op
 * via th[data-code] i stedet for header-tekst, og udbrydere genkendes på
 * svg_shield-ikonet alene, da PCS kun har km-tallet i ikonets title for 2026.
 */

import type { AnyNode } from 'domhandler'
import {
  type CheerioDoc, clean, columnIndex, keyValues, load, parsePcsDate, parseTimeCell,
  riderSlugFrom, stripTeamTier, toFloat, toInt,
} from './common.ts'

export type StageInfo = {
  title: string | null
  date: string | null
  distanceKm: number | null
  verticalMeters: number | null
  profileScore: number | null
  gradientFinalKm: number | null
  wonHow: string | null
  profileIcon: string | null
  profileLabel: string | null
}

export type StageRow = {
  riderSlug: string
  /** Som PCS skriver det i resultatlisten: "POGAČAR Tadej". */
  riderName: string
  teamName: string | null
  position: number | null
  timeGapS: number | null
  dnf: boolean
  abandonType: string | null
  /** PCS' udbrudsikon (svg_shield) i rækken. */
  inBreak: boolean
  gcPositionAfter: number | null
  gcGapS: number | null
  /** Dagens point i pointkonkurrencen; null hvis løbet ikke har klassementet. */
  sprintPoints: number | null
  mountainPoints: number | null
}

export type StagePage = {
  info: StageInfo
  isTtt: boolean
  /** Link til siden med udbruds-km, fx "race/tour-de-france-2024-stage-4/live/kms-in-the-break". */
  kmsPath: string | null
  /** Alle ryttere i etaperesultatet i PCS' rækkefølge. */
  rows: StageRow[]
}

const ABANDON = new Set(['DNF', 'DNS', 'OTL', 'DSQ', 'DF', 'NQ'])

function parseInfo($: CheerioDoc): StageInfo {
  const scope = $('.unitInfo').first()
  const kv = scope.length ? keyValues($, scope[0]) : new Map()
  const get = (k: string) => kv.get(k)?.text ?? null

  let profileIcon: string | null = null
  const parcours = kv.get('parcours type')
  if (parcours) {
    for (const node of parcours.nodes) {
      const cls = ($(node).find('span.icon.profile').attr('class') ?? '').split(/\s+/)
      profileIcon = cls.find((c) => /^p[0-5]$/.test(c)) ?? profileIcon
    }
  }

  const title = clean($('title').first().text()) || null
  return {
    title,
    date: parsePcsDate(get('date')),
    distanceKm: toFloat(get('distance')),
    verticalMeters: toInt(get('vertical meters')),
    // "187 (final: 56 )" → 187
    profileScore: toInt(get('profile score')),
    gradientFinalKm: toFloat(get('gradient final km')),
    wonHow: clean(get('won how')) || null,
    profileIcon,
    profileLabel: clean(get('parcours type')) || null,
  }
}

/** Resultatbokse (div.resultCont) med deres h4-overskrift ('' for etaperesultatet). */
function resultBlocks($: CheerioDoc): Array<{ heading: string; el: AnyNode }> {
  return $('div.resultCont')
    .toArray()
    .map((el) => ({ heading: clean($(el).children('h4').first().text()).toLowerCase(), el }))
}

type ClassEntry = { position: number | null; gapS: number | null; today: number | null }

/** GC-, point- eller bjergtabel → slug → placering, tidsforskel og dagens point. */
function parseClassification($: CheerioDoc, block: AnyNode): Map<string, ClassEntry> {
  const out = new Map<string, ClassEntry>()
  const table = $(block).find('table').first()
  if (!table.length) return out
  const col = columnIndex($, table[0])
  let prevGap: number | null = null
  table.find('tbody > tr').each((_, tr) => {
    const cells = $(tr).children('td').toArray()
    const rider = riderSlugFrom($, tr)
    if (!rider || out.has(rider.slug)) return
    const cell = (code: string) => (col.has(code) ? $(cells[col.get(code)!]).text() : null)
    const position = toInt(cell('rnk'))
    let gapS: number | null = null
    if (col.has('timelag')) {
      const t = parseTimeCell(cell('timelag'))
      gapS = position === 1 ? 0 : t === 'same' ? prevGap : t
      prevGap = gapS
    }
    const today = col.has('pnt_won') ? toInt(cell('pnt_won')) ?? 0 : null
    out.set(rider.slug, { position, gapS, today })
  })
  return out
}

function parseStageTable($: CheerioDoc, block: AnyNode): StageRow[] {
  const table = $(block).find('table').first()
  const col = columnIndex($, table[0])
  if (!col.has('rider')) return []
  const rows: StageRow[] = []
  const seen = new Set<string>()
  let prevGap: number | null = null

  table.find('tbody > tr').each((_, tr) => {
    const cells = $(tr).children('td').toArray()
    const rider = riderSlugFrom($, tr)
    if (!rider || seen.has(rider.slug)) return
    seen.add(rider.slug)
    const cell = (code: string) => (col.has(code) ? $(cells[col.get(code)!]).text() : null)

    const rnk = clean(cell('rnk')).toUpperCase()
    const abandon = ABANDON.has(rnk) ? rnk : null
    const position = abandon ? null : toInt(rnk)

    let timeGapS: number | null = null
    if (!abandon) {
      const t = parseTimeCell(cell('timelag'))
      // Vinderens celle er sluttiden, ikke en forskel.
      timeGapS = position === 1 ? 0 : t === 'same' ? prevGap : t
      prevGap = timeGapS
    }

    const gcTime = parseTimeCell(cell('gc_timelag'))
    rows.push({
      riderSlug: rider.slug,
      riderName: rider.name,
      teamName: stripTeamTier(cell('riderteam')),
      position,
      timeGapS,
      dnf: abandon != null,
      abandonType: abandon,
      inBreak: $(tr).find('.svg_shield').length > 0,
      gcPositionAfter: toInt(cell('gc')),
      gcGapS: gcTime === 'same' ? null : gcTime,
      sprintPoints: null,
      mountainPoints: null,
    })
  })
  return rows
}

/**
 * Holdtidskørsel: PCS viser hold med holdtid og rytterne under hvert hold, evt.
 * med eget tidstab ("+0:41"). Hver rytter får holdets placering og holdets
 * tidsforskel plus sit eget tidstab.
 */
function parseTttList($: CheerioDoc, block: AnyNode): StageRow[] {
  const rows: StageRow[] = []
  $(block).find('ul.ttt-results > li').each((_, li) => {
    const teamLink = $(li).find('a[href^="team/"]').first()
    if (!teamLink.length) return
    const teamRank = toInt($(li).find('div.w10').first().text())
    const timeDivs = $(li).find('div.timeSpeed > div')
    // Holdets tidsforskel står i 2. kolonne, fx "0:12,34" (hundrededele efter komma).
    const teamGap = parseTimeCell(clean($(timeDivs[1]).text()).split(',')[0])
    $(li).find('table tr').each((__, tr) => {
      const rider = riderSlugFrom($, tr)
      if (!rider) return
      const extra = parseTimeCell($(tr).find('a[href^="rider/"] font').text())
      const base = typeof teamGap === 'number' ? teamGap : teamRank === 1 ? 0 : null
      rows.push({
        riderSlug: rider.slug,
        riderName: rider.name,
        teamName: stripTeamTier(teamLink.text()),
        position: teamRank,
        timeGapS: base == null ? null : base + (typeof extra === 'number' ? extra : 0),
        dnf: false,
        abandonType: null,
        inBreak: false,
        gcPositionAfter: null,
        gcGapS: null,
        sprintPoints: null,
        mountainPoints: null,
      })
    })
  })
  return rows
}

export function parseStagePage(html: string): StagePage {
  const $ = load(html)
  const info = parseInfo($)
  const blocks = resultBlocks($)

  const stageBlock = blocks.find((b) => b.heading === '')
  const isTtt = !!stageBlock && $(stageBlock.el).find('ul.ttt-results').length > 0
  const rows = !stageBlock ? [] : isTtt ? parseTttList($, stageBlock.el) : parseStageTable($, stageBlock.el)

  const gcBlock = blocks.find((b) => b.heading === 'general classification')
  const ptsBlock = blocks.find((b) => b.heading === 'points classification')
  const komBlock = blocks.find((b) => b.heading === 'mountains classification')
  const gc = gcBlock ? parseClassification($, gcBlock.el) : null
  const pts = ptsBlock ? parseClassification($, ptsBlock.el) : null
  const kom = komBlock ? parseClassification($, komBlock.el) : null

  for (const r of rows) {
    const g = gc?.get(r.riderSlug)
    if (g) {
      r.gcPositionAfter = g.position
      r.gcGapS = g.gapS
    }
    // Ryttere uden for pointtabellen scorede 0 på etapen.
    if (pts) r.sprintPoints = pts.get(r.riderSlug)?.today ?? 0
    if (kom) r.mountainPoints = kom.get(r.riderSlug)?.today ?? 0
  }

  const kmsPath = $('a[href$="/live/kms-in-the-break"]').first().attr('href')?.replace(/^\/+/, '') ?? null
  return { info, isTtt, kmsPath, rows }
}
