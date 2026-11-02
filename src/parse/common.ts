import * as cheerio from 'cheerio'
import type { AnyNode, Element } from 'domhandler'

export type CheerioDoc = cheerio.CheerioAPI

export const load = (html: string): CheerioDoc => cheerio.load(html)

export const clean = (s: string | null | undefined): string => (s ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim()

export function toInt(raw: string | null | undefined): number | null {
  const m = clean(raw).match(/-?\d+/)
  return m ? parseInt(m[0], 10) : null
}

export function toFloat(raw: string | null | undefined): number | null {
  const m = clean(raw).match(/-?\d+(?:\.\d+)?/)
  return m ? parseFloat(m[0]) : null
}

/**
 * Tidsforskel i en PCS-celle. Udvidet fra parseGapToSeconds() i Bodega Bets'
 * lib/syncCyclingResults.ts (commit b021a60): ",," betyder samme tid som
 * rytteren foran og returneres som 'same', så kalderen kan føre tiden videre.
 * Bodega Bets' version gav null for ",,". Første tid i cellen bruges, fordi
 * PCS nogle gange render tiden to gange i samme celle.
 */
export function parseTimeCell(raw: string | null | undefined): number | 'same' | null {
  const txt = clean(raw)
  if (!txt || txt === '-' || txt === '—') return null
  if (txt.startsWith(',,')) return 'same'
  const m = txt.match(/(\d{1,3}):(\d{2})(?::(\d{2}))?/)
  if (!m) return null
  const [h, mi, s] = m[3] != null ? [+m[1], +m[2], +m[3]] : [0, +m[1], +m[2]]
  return h * 3600 + mi * 60 + s
}

/** Holdnavn uden PCS' tier-tag (" (WT)", " (PRT)" …). Fra Bodega Bets' lib/cyclingRiderEnrichment.ts. */
export function stripTeamTier(name: string | null | undefined): string | null {
  const s = clean(name).replace(/\s*\([A-Z]{2,4}\)\s*$/, '').trim()
  return s || null
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
}

/** "2 July 2024" eller "21st September 1998 (28)" → "2024-07-02" / "1998-09-21". */
export function parsePcsDate(raw: string | null | undefined): string | null {
  const m = clean(raw).match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})/)
  if (!m) return null
  const month = MONTHS[m[2].toLowerCase()]
  if (!month) return null
  return `${m[3]}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}`
}

/** Slug fra et link som "rider/tadej-pogacar". */
export function riderSlugFrom($: CheerioDoc, scope: AnyNode): { slug: string; name: string } | null {
  const a = $(scope).find('a[href^="rider/"]').first()
  const m = (a.attr('href') ?? '').match(/^rider\/([^/?#]+)/)
  if (!m) return null
  return { slug: m[1], name: clean(a.clone().children().remove().end().text()) }
}

/**
 * Nøgle/værdi-par fra PCS' infobokse: <div class="bold">Label:</div> efterfulgt
 * af værdi-divs frem til næste <br> eller næste label.
 */
export function keyValues($: CheerioDoc, scope: AnyNode | CheerioDoc): Map<string, { text: string; nodes: Element[] }> {
  const out = new Map<string, { text: string; nodes: Element[] }>()
  const root = typeof scope === 'function' ? scope.root() : $(scope)
  root.find('div.bold').each((_, el) => {
    const label = clean($(el).text()).replace(/:$/, '').toLowerCase()
    if (!label || out.has(label)) return
    const nodes: Element[] = []
    let n = el.next
    while (n) {
      if (n.type === 'tag') {
        const tag = n as Element
        if (tag.name === 'br') break
        if (tag.name === 'div' && $(tag).hasClass('bold')) break
        nodes.push(tag)
      }
      n = n.next
    }
    out.set(label, { text: clean(nodes.map((x) => $(x).text()).join(' ')), nodes })
  })
  return out
}

/** Kolonne-indeks ud fra thead th[data-code]. */
export function columnIndex($: CheerioDoc, table: AnyNode): Map<string, number> {
  const idx = new Map<string, number>()
  $(table).find('thead th').each((i, th) => {
    const code = $(th).attr('data-code')
    if (code && !idx.has(code)) idx.set(code, i)
  })
  return idx
}
