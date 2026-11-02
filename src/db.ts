/**
 * Skrivning til skemaet velo via pg direkte. velo er bevidst ikke eksponeret i
 * Supabase-API'et. Alle skrivninger er upserts, så en genkørsel ikke ændrer
 * rækkeantallet.
 */

import fs from 'node:fs'
import pg from 'pg'

export type RaceRow = {
  pcsSlug: string
  year: number
  name: string | null
  raceType: string
  startDate: string | null
  endDate: string | null
}

export type StageRowDb = {
  stageNumber: number
  stageDate: string | null
  distanceKm: number | null
  verticalMeters: number | null
  profileScore: number | null
  gradientFinalKm: number | null
  wonHow: string | null
  profileIcon: string | null
  profileLabel: string | null
  isTimeTrial: boolean
}

export type ResultRowDb = {
  riderSlug: string
  teamName: string | null
  position: number | null
  timeGapS: number | null
  kmInBreak: number | null
  dnf: boolean
  abandonType: string | null
  gcPositionAfter: number | null
  gcGapS: number | null
  sprintPoints: number | null
  mountainPoints: number | null
}

export type RiderStub = { pcsSlug: string; firstName: string | null; lastName: string | null }

export type RiderDetails = {
  pcsSlug: string
  firstName: string | null
  lastName: string | null
  birthDate: string | null
  weightKg: number | null
  heightM: number | null
}

export type SpecialtyRow = {
  oneday: number | null
  gc: number | null
  tt: number | null
  sprint: number | null
  climber: number | null
  hills: number | null
}

/**
 * TLS: med DATABASE_CA_CERT (sti til Supabase' CA-certifikat fra
 * Dashboard → Database → SSL) verificeres serveren mod det. Uden den bruges
 * pg's standard ud fra sslmode i DATABASE_URL.
 */
function poolConfig(url: string): pg.PoolConfig {
  const caPath = process.env.DATABASE_CA_CERT?.trim()
  if (!caPath) return { connectionString: url, max: 2 }
  const u = new URL(url)
  u.searchParams.delete('sslmode') // ellers overskriver sslmode ssl-objektet nedenfor
  return { connectionString: u.toString(), ssl: { ca: fs.readFileSync(caPath, 'utf8') }, max: 2 }
}

export class Db {
  readonly pool: pg.Pool

  constructor(url: string) {
    this.pool = new pg.Pool(poolConfig(url))
  }

  close(): Promise<void> {
    return this.pool.end()
  }

  /** Løbslisten: alle distinkte pcs_slug i velo.races for 2026, i kalenderrækkefølge. */
  async races2026(): Promise<Array<{ pcsSlug: string; raceType: string }>> {
    const { rows } = await this.pool.query<{ pcs_slug: string; race_type: string }>(
      `select pcs_slug, min(race_type) as race_type
         from velo.races
        where year = 2026 and pcs_slug is not null
        group by pcs_slug
        order by min(start_date) nulls last, pcs_slug`,
    )
    return rows.map((r) => ({ pcsSlug: r.pcs_slug, raceType: r.race_type }))
  }

  /** Skriver løb, etaper, ryttere (stub) og resultater for ét løb og år i én transaktion. */
  async writeRaceYear(
    race: RaceRow,
    stages: Array<{ stage: StageRowDb; results: ResultRowDb[] | null }>,
    riders: RiderStub[],
  ): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const raceId = (
        await client.query<{ id: string }>(
          `insert into velo.races (pcs_slug, year, name, race_type, start_date, end_date)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (pcs_slug, year) do update set
             name = coalesce(excluded.name, velo.races.name),
             race_type = excluded.race_type,
             start_date = coalesce(excluded.start_date, velo.races.start_date),
             end_date = coalesce(excluded.end_date, velo.races.end_date)
           returning id`,
          [race.pcsSlug, race.year, race.name, race.raceType, race.startDate, race.endDate],
        )
      ).rows[0].id

      const riderIds = new Map<string, string>()
      for (const r of riders) {
        const { rows } = await client.query<{ id: string }>(
          `insert into velo.riders (pcs_slug, first_name, last_name)
           values ($1, $2, $3)
           on conflict (pcs_slug) do update set
             first_name = coalesce(velo.riders.first_name, excluded.first_name),
             last_name = coalesce(velo.riders.last_name, excluded.last_name)
           returning id`,
          [r.pcsSlug, r.firstName, r.lastName],
        )
        riderIds.set(r.pcsSlug, rows[0].id)
      }

      for (const { stage: s, results } of stages) {
        const stageId = (
          await client.query<{ id: string }>(
            `insert into velo.stages (race_id, stage_number, stage_date, distance_km, vertical_meters,
                                      profile_score, gradient_final_km, won_how, profile_icon, profile_label, is_time_trial)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             on conflict (race_id, stage_number) do update set
               stage_date = excluded.stage_date,
               distance_km = excluded.distance_km,
               vertical_meters = excluded.vertical_meters,
               profile_score = excluded.profile_score,
               gradient_final_km = excluded.gradient_final_km,
               won_how = excluded.won_how,
               profile_icon = excluded.profile_icon,
               profile_label = excluded.profile_label,
               is_time_trial = excluded.is_time_trial
             returning id`,
            [raceId, s.stageNumber, s.stageDate, s.distanceKm, s.verticalMeters, s.profileScore,
              s.gradientFinalKm, s.wonHow, s.profileIcon, s.profileLabel, s.isTimeTrial],
          )
        ).rows[0].id

        if (!results) continue // --only stages
        const keep: string[] = []
        for (const r of results) {
          const riderId = riderIds.get(r.riderSlug)
          if (!riderId) throw new Error(`rytter ${r.riderSlug} mangler i stub-listen`)
          keep.push(riderId)
          await client.query(
            `insert into velo.results (stage_id, rider_id, team_name, position, time_gap_s, km_in_break, dnf,
                                       abandon_type, gc_position_after, gc_gap_s, sprint_points, mountain_points)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             on conflict (stage_id, rider_id) do update set
               team_name = excluded.team_name,
               position = excluded.position,
               time_gap_s = excluded.time_gap_s,
               km_in_break = excluded.km_in_break,
               dnf = excluded.dnf,
               abandon_type = excluded.abandon_type,
               gc_position_after = excluded.gc_position_after,
               gc_gap_s = excluded.gc_gap_s,
               sprint_points = excluded.sprint_points,
               mountain_points = excluded.mountain_points`,
            [stageId, riderId, r.teamName, r.position, r.timeGapS, r.kmInBreak, r.dnf, r.abandonType,
              r.gcPositionAfter, r.gcGapS, r.sprintPoints, r.mountainPoints],
          )
        }
        // Rækker fra en tidligere kørsel, som den nuværende parser ikke længere udvælger.
        await client.query(`delete from velo.results where stage_id = $1 and not (rider_id = any($2))`, [stageId, keep])
      }
      await client.query('commit')
    } catch (err) {
      await client.query('rollback')
      throw err
    } finally {
      client.release()
    }
  }

  /** Ryttere i resultaterne for de valgte år/løb, som mangler stamdata eller specialepoint. */
  async ridersNeedingDetails(filter: { years: number[]; race?: string }): Promise<Array<{ pcsSlug: string; firstName: string | null }>> {
    const { rows } = await this.pool.query<{ pcs_slug: string; first_name: string | null }>(
      `select distinct r.pcs_slug, r.first_name
         from velo.results res
         join velo.riders r on r.id = res.rider_id
         join velo.stages s on s.id = res.stage_id
         join velo.races ra on ra.id = s.race_id
        where ra.year = any($1::int[])
          and ($2::text is null or ra.pcs_slug = $2)
          and (r.birth_date is null
               or not exists (select 1 from velo.rider_specialties sp where sp.rider_id = r.id))
        order by r.pcs_slug`,
      [filter.years, filter.race ?? null],
    )
    return rows.map((r) => ({ pcsSlug: r.pcs_slug, firstName: r.first_name }))
  }

  async writeRider(d: RiderDetails, specialties: SpecialtyRow | null, capturedOn: string): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const { rows } = await client.query<{ id: string }>(
        `insert into velo.riders (pcs_slug, first_name, last_name, birth_date, weight_kg, height_m)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (pcs_slug) do update set
           first_name = coalesce(excluded.first_name, velo.riders.first_name),
           last_name = coalesce(excluded.last_name, velo.riders.last_name),
           birth_date = coalesce(excluded.birth_date, velo.riders.birth_date),
           weight_kg = coalesce(excluded.weight_kg, velo.riders.weight_kg),
           height_m = coalesce(excluded.height_m, velo.riders.height_m)
         returning id`,
        [d.pcsSlug, d.firstName, d.lastName, d.birthDate, d.weightKg, d.heightM],
      )
      if (specialties) {
        await client.query(
          `insert into velo.rider_specialties (rider_id, captured_on, one_day, gc, time_trial, sprint, climber, hills)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           on conflict (rider_id, captured_on) do update set
             one_day = excluded.one_day, gc = excluded.gc, time_trial = excluded.time_trial,
             sprint = excluded.sprint, climber = excluded.climber, hills = excluded.hills`,
          [rows[0].id, capturedOn, specialties.oneday, specialties.gc, specialties.tt,
            specialties.sprint, specialties.climber, specialties.hills],
        )
      }
      await client.query('commit')
    } catch (err) {
      await client.query('rollback')
      throw err
    } finally {
      client.release()
    }
  }
}
