/**
 * Alle PCS-opslag går gennem her: filcache først, ellers FlareSolverr med
 * høflig pause, ét opslag ad gangen.
 *
 * Fejlpolitik (Cloudflare-side, 403/429/5xx eller FlareSolverr-fejl):
 *   vent PCS_FAILURE_WAIT_S (standard 5 min), ny session, prøv igen.
 *   3 fejl i træk på samme side  → log og spring siden over.
 *   20 fejl i træk samlet        → RunAborted; kørslen stoppes pænt og kan
 *                                   genoptages, da alt hentet ligger i cachen.
 */

import fs from 'node:fs'
import path from 'node:path'
import { CACHE_DIR, PCS_BASE, fetchPolicy } from '../config.ts'
import { log } from '../log.ts'
import { FlareSolverr, SolverError } from './flaresolverr.ts'

export type PcsPage =
  | { kind: 'ok'; path: string; html: string; fetchedAt: Date; fromCache: boolean }
  | { kind: 'missing'; path: string } // PCS svarede 404
  | { kind: 'skipped'; path: string } // opgivet efter gentagne fejl, eller ikke i cachen ved --offline

export class RunAborted extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function isCloudflarePage(html: string): boolean {
  const head = html.slice(0, 20_000)
  return (
    /<title>\s*(Just a moment|Attention Required|Please wait)/i.test(head) ||
    /id="challenge-(form|running|error-text)"|cf-browser-verification|window\._cf_chl_opt/i.test(head)
  )
}

function cacheFile(pcsPath: string): string {
  const safe = pcsPath.replace(/^\/+/, '').replace(/[^a-zA-Z0-9/_.-]/g, '_')
  return path.join(CACHE_DIR, ...safe.split('/')) + '.html'
}

export class PcsClient {
  private readonly solver: FlareSolverr | null
  private lastNetworkAt = 0
  private consecutiveFailures = 0
  readonly stats = { network: 0, cacheHits: 0, failures: 0, skipped: [] as string[] }

  /** solver = null betyder kun cache (--offline). */
  constructor(solver: FlareSolverr | null) {
    this.solver = solver
  }

  async close(): Promise<void> {
    await this.solver?.destroySession()
  }

  async get(pcsPath: string): Promise<PcsPage> {
    const file = cacheFile(pcsPath)
    if (fs.existsSync(file)) {
      this.stats.cacheHits++
      return { kind: 'ok', path: pcsPath, html: fs.readFileSync(file, 'utf8'), fetchedAt: fs.statSync(file).mtime, fromCache: true }
    }
    if (fs.existsSync(file + '.404')) return { kind: 'missing', path: pcsPath }

    if (!this.solver) {
      log.warn(`ikke i cachen (--offline): ${pcsPath}`)
      this.stats.skipped.push(pcsPath)
      return { kind: 'skipped', path: pcsPath }
    }

    const url = `${PCS_BASE}/${pcsPath}`
    for (let attempt = 1; ; attempt++) {
      await this.politeDelay()
      let problem: string
      try {
        const res = await this.solver.get(url)
        this.lastNetworkAt = Date.now()
        this.stats.network++
        if (res.status === 404) {
          this.consecutiveFailures = 0
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.writeFileSync(file + '.404', '')
          return { kind: 'missing', path: pcsPath }
        }
        if (res.status === 200 && res.html.length > 1000 && !isCloudflarePage(res.html)) {
          this.consecutiveFailures = 0
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.writeFileSync(file, res.html)
          return { kind: 'ok', path: pcsPath, html: res.html, fetchedAt: new Date(), fromCache: false }
        }
        problem = isCloudflarePage(res.html) ? 'Cloudflare-side' : `HTTP ${res.status} (${res.html.length} tegn)`
      } catch (err) {
        if (!(err instanceof SolverError)) throw err
        this.lastNetworkAt = Date.now()
        problem = err.message
      }

      this.stats.failures++
      this.consecutiveFailures++
      log.warn(`fejl ${attempt}/${fetchPolicy.maxPageFailures} på ${pcsPath}: ${problem} (${this.consecutiveFailures} i træk)`)
      if (this.consecutiveFailures >= fetchPolicy.maxConsecutiveFailures) {
        throw new RunAborted(`${this.consecutiveFailures} fejl i træk; stopper. Kør igen senere, alt hentet ligger i cachen.`)
      }
      log.warn(`venter ${fetchPolicy.failureWaitS} s og opretter ny FlareSolverr-session`)
      await sleep(fetchPolicy.failureWaitS * 1000)
      try {
        await this.solver.renewSession()
      } catch (err) {
        // Næste get() forsøger at oprette en session igen og tæller som fejl, hvis det ikke lykkes.
        log.warn(`kunne ikke oprette ny session: ${String(err)}`)
      }
      if (attempt >= fetchPolicy.maxPageFailures) {
        log.warn(`springer over efter ${attempt} fejl: ${pcsPath}`)
        this.stats.skipped.push(pcsPath)
        return { kind: 'skipped', path: pcsPath }
      }
    }
  }

  private async politeDelay(): Promise<void> {
    if (this.lastNetworkAt === 0) return
    const { delayMinS, delayMaxS } = fetchPolicy
    const targetMs = (delayMinS + Math.random() * (delayMaxS - delayMinS)) * 1000
    const waitMs = targetMs - (Date.now() - this.lastNetworkAt)
    if (waitMs > 0) await sleep(waitMs)
  }
}
