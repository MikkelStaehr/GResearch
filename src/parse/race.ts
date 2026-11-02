import { clean, load } from './common.ts'

export type StageRef = {
  /** PCS-sti til etapen, fx "race/tour-de-france-2024-stage-7". */
  path: string
  stageNumber: number
  label: string
  isTimeTrial: boolean
}

export type RaceInfo = {
  name: string | null
  /** Etaper fra PCS' etape-dropdown. Tom for endagsløb. */
  stages: StageRef[]
  /** Etaper PCS deler i a/b (fx "stage-1a"), som ikke passer i (race_id, stage_number). */
  splitStages: string[]
}

/** "2024 » 111th Tour de France (2.UWT)" → "Tour de France". */
export function raceNameFromH1(h1: string): string | null {
  const name = clean(h1)
    .replace(/^.*»\s*/, '')
    .replace(/^\d+(st|nd|rd|th)\s+/i, '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim()
  return name || null
}

/** Parser race/<slug>/<år>. For etapeløb viser PCS slutetapen; for endagsløb resultatet. */
export function parseRacePage(html: string, year: number): RaceInfo {
  const $ = load(html)
  const name = raceNameFromH1($('h1').first().text())

  const stageRe = new RegExp(`^race/[a-z0-9-]+-${year}-(prologue|stage-(\\d+)([a-z]?))$`)
  let best: StageRef[] = []
  let bestSplit: string[] = []
  $('select').each((_, sel) => {
    const stages: StageRef[] = []
    const split: string[] = []
    $(sel).find('option').each((__, opt) => {
      const value = $(opt).attr('value') ?? ''
      const m = value.match(stageRe)
      if (!m) return
      if (m[3]) {
        split.push(value)
        return
      }
      const label = clean($(opt).text())
      const isPrologue = m[1] === 'prologue'
      stages.push({
        path: value,
        stageNumber: isPrologue ? 0 : parseInt(m[2], 10),
        label,
        isTimeTrial: isPrologue || /\((ITT|TTT)\)/.test(label),
      })
    })
    if (stages.length + split.length > best.length + bestSplit.length) {
      best = stages
      bestSplit = split
    }
  })

  return { name, stages: best, splitStages: bestSplit }
}
