import { clean, keyValues, load, parsePcsDate, toFloat, toInt } from './common.ts'

export type Specialties = {
  oneday: number | null
  gc: number | null
  tt: number | null
  sprint: number | null
  climber: number | null
  hills: number | null
}

export type RiderPage = {
  fullName: string | null
  birthDate: string | null
  weightKg: number | null
  heightM: number | null
  specialties: Specialties | null
}

/** rider/<slug>: fødselsdato, vægt, højde og PCS' specialepoint. */
export function parseRiderPage(html: string): RiderPage {
  const $ = load(html)
  const kv = keyValues($, $)
  const get = (k: string) => kv.get(k)?.text ?? null

  // Specialepoint: <ul class="pps"> med ét <li> pr. speciale; typen står i linkets type=-parameter.
  const sp: Specialties = { oneday: null, gc: null, tt: null, sprint: null, climber: null, hills: null }
  let found = false
  $('ul.pps li').each((_, li) => {
    const href = $(li).find('.xtitle a').attr('href') ?? ''
    const type = (href.match(/[?&]type=([a-z]+)/)?.[1] ?? clean($(li).find('.xtitle').text()).toLowerCase()) as keyof Specialties
    if (!(type in sp)) return
    sp[type] = toInt($(li).find('.xvalue').text())
    found = true
  })

  return {
    fullName: clean($('h1').first().text()) || null,
    birthDate: parsePcsDate(get('date of birth')),
    weightKg: toFloat(get('weight')),
    heightM: toFloat(get('height')),
    specialties: found ? sp : null,
  }
}
