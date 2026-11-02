/**
 * Brug:
 *   npm run scrape -- [--race <slug>] [--year <år>] [--only stages|results|riders] [--dry-run] [--offline]
 *
 * Rækkefølge: alle løb, etaper og resultater (2025 → 2019), ryttere til sidst.
 * --offline bruger kun cachen (ingen FlareSolverr), fx for at genparse efter en parserrettelse.
 */

import { parseArgs } from 'node:util'
import { YEARS, fetchPolicy, requireEnv } from './config.ts'
import { Db } from './db.ts'
import { log, logFile } from './log.ts'
import { PcsClient, RunAborted } from './pcs/client.ts'
import { FlareSolverr } from './pcs/flaresolverr.ts'
import { type Only, type RunContext, scrapeRaceYear, scrapeRiders } from './scrape.ts'

const { values: args } = parseArgs({
  options: {
    race: { type: 'string' },
    year: { type: 'string' },
    only: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    offline: { type: 'boolean', default: false },
  },
})

const only = (args.only ?? null) as Only
if (only && !['stages', 'results', 'riders'].includes(only)) throw new Error('--only skal være stages, results eller riders')
const years = args.year ? [Number(args.year)] : YEARS
if (years.some((y) => !Number.isInteger(y))) throw new Error('--year skal være et årstal')
const dryRun = args['dry-run']

async function main(): Promise<number> {
  log.info(
    `start: år ${years.join(',')}${args.race ? `, løb ${args.race}` : ''}${only ? `, kun ${only}` : ''}` +
      `${dryRun ? ', DRY-RUN' : ''}${args.offline ? ', OFFLINE' : ''}; pause ${fetchPolicy.delayMinS}-${fetchPolicy.delayMaxS} s; log ${logFile}`,
  )

  // Databasen læses også ved --dry-run (løbslisten), men der skrives ikke.
  const needDbForList = !args.race || only === 'riders'
  const db = !dryRun || needDbForList ? new Db(requireEnv('DATABASE_URL')) : null
  const solver = args.offline ? null : new FlareSolverr(requireEnv('FLARESOLVERR_URL'), fetchPolicy.solverTimeoutMs)
  const client = new PcsClient(solver)
  const ctx: RunContext = { client, db: dryRun ? null : db, only, seenRiders: new Map() }
  const started = Date.now()

  try {
    if (solver) log.info(`FlareSolverr-session: ${await solver.createSession()}`)

    if (only !== 'riders') {
      const list = db ? await db.races2026() : []
      const races = args.race
        ? [{ pcsSlug: args.race, raceType: list.find((r) => r.pcsSlug === args.race)?.raceType ?? null }]
        : list
      log.info(`${races.length} løb × ${years.length} år`)
      for (const year of years) {
        for (const r of races) {
          try {
            await scrapeRaceYear(ctx, r.pcsSlug, r.raceType, year)
          } catch (err) {
            if (err instanceof RunAborted) throw err
            log.error(`[${year} ${r.pcsSlug}] fejlede, fortsætter med næste: ${err instanceof Error ? err.stack : String(err)}`)
          }
        }
      }
    }

    if (only === null || only === 'riders') {
      const targets = ctx.db
        ? await ctx.db.ridersNeedingDetails({ years, race: args.race })
        : [...ctx.seenRiders].map(([pcsSlug, firstName]) => ({ pcsSlug, firstName }))
      await scrapeRiders(ctx, targets)
    }
    return 0
  } catch (err) {
    if (err instanceof RunAborted) {
      log.error(`kørslen stoppet: ${err.message}`)
      return 2
    }
    throw err
  } finally {
    const s = client.stats
    log.info(
      `slut: ${Math.round((Date.now() - started) / 60000)} min, ${s.network} opslag, ${s.cacheHits} fra cache, ` +
        `${s.failures} fejl, ${s.skipped.length} sider sprunget over${s.skipped.length ? `: ${s.skipped.join(' ')}` : ''}`,
    )
    await client.close()
    await db?.close()
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    log.error(err instanceof Error ? (err.stack ?? err.message) : String(err))
    process.exit(1)
  },
)
