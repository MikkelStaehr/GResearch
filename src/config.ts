import path from 'node:path'

export const ROOT = path.resolve(import.meta.dirname, '..')
/** Rå PCS-HTML. Kan flyttes med PCS_CACHE_DIR, fx til en større disk. */
export const CACHE_DIR = process.env.PCS_CACHE_DIR?.trim() || path.join(ROOT, 'cache', 'pcs')
export const LOG_DIR = path.join(ROOT, 'logs')

export const PCS_BASE = 'https://www.procyclingstats.com'

/** År der hentes, nyeste først, så de mest brugbare data er med hvis kørslen stopper undervejs. */
export const YEARS = [2025, 2024, 2023, 2022, 2021, 2020, 2019]

/** Antal placeringer pr. etape der gemmes (plus alle udbrydere). */
export const TOP_N = 30

/** stage_number for et endagsløbs ene etape. */
export const ONE_DAY_STAGE_NUMBER = 1

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw == null || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} skal være et tal ≥ 0, fik "${raw}"`)
  return n
}

export function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v || v.trim() === '') throw new Error(`Mangler miljøvariablen ${name} (se .env.example)`)
  return v.trim()
}

export const fetchPolicy = {
  delayMinS: numEnv('PCS_DELAY_MIN_S', 5),
  delayMaxS: numEnv('PCS_DELAY_MAX_S', 10),
  /** Ventetid efter Cloudflare-side eller FlareSolverr-fejl, før ny session og nyt forsøg. */
  failureWaitS: numEnv('PCS_FAILURE_WAIT_S', 300),
  /** Fejl i træk på samme side, før siden springes over. */
  maxPageFailures: 3,
  /** Fejl i træk samlet, før kørslen stoppes pænt. */
  maxConsecutiveFailures: 20,
  /** FlareSolverr's egen timeout pr. opslag. */
  solverTimeoutMs: 60_000,
}

if (fetchPolicy.delayMaxS < fetchPolicy.delayMinS) {
  throw new Error('PCS_DELAY_MAX_S skal være ≥ PCS_DELAY_MIN_S')
}
