/**
 * Rækkeantal i velo, til at tjekke en kørsel og genkørsel.
 *   npm run counts [-- --race <slug> --year <år>]
 */

import { parseArgs } from 'node:util'
import { requireEnv } from './config.ts'
import { Db } from './db.ts'

const { values: args } = parseArgs({ options: { race: { type: 'string' }, year: { type: 'string' } } })
const race = args.race ?? null
const year = args.year ? Number(args.year) : null

const db = new Db(requireEnv('DATABASE_URL'))
try {
  const { rows } = await db.pool.query(
    `with ra as (select id from velo.races
                  where ($1::text is null or pcs_slug = $1) and ($2::int is null or year = $2)),
          st as (select s.id from velo.stages s join ra on ra.id = s.race_id),
          re as (select r.* from velo.results r join st on st.id = r.stage_id)
     select (select count(*) from ra)                                   as races,
            (select count(*) from st)                                   as stages,
            (select count(*) from re)                                   as results,
            (select count(*) from re where km_in_break > 0)             as results_with_km_in_break,
            (select count(distinct rider_id) from re)                   as riders_in_results,
            (select count(*) from velo.riders)                          as riders_total,
            (select count(*) from velo.rider_specialties)               as rider_specialties_total`,
    [race, year],
  )
  console.table(rows[0])
} finally {
  await db.close()
}
