import { clean, load, riderSlugFrom, toInt } from './common.ts'

export type KmsRow = { riderSlug: string; kmFirstGroup: number | null; kmBeforePeloton: number | null }

/**
 * race/<etape>/live/kms-in-the-break. Første tabel er etapen; den anden (kun på
 * etapeløb) er løbet samlet. "KM before peloton" er samme tal, som PCS i 2026
 * skriver i udbrudsikonets title, og som Bodega Bets gemmer som km_in_break.
 */
export function parseKmsPage(html: string): KmsRow[] {
  const $ = load(html)
  const table = $('table').first()
  if (!table.length) return []
  // Siden bruger ikke data-code; find kolonnerne via header-tekst.
  const headers = table.find('thead th').toArray().map((th) => clean($(th).text()).toLowerCase())
  const firstIdx = headers.findIndex((h) => h.includes('first group'))
  const pelotonIdx = headers.findIndex((h) => h.includes('before peloton'))
  if (pelotonIdx < 0) return []

  const rows: KmsRow[] = []
  table.find('tbody > tr').each((_, tr) => {
    const rider = riderSlugFrom($, tr)
    if (!rider) return
    const cells = $(tr).children('td').toArray()
    rows.push({
      riderSlug: rider.slug,
      kmFirstGroup: firstIdx >= 0 ? toInt($(cells[firstIdx]).text()) : null,
      kmBeforePeloton: toInt($(cells[pelotonIdx]).text()),
    })
  })
  return rows
}
