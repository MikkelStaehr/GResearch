/**
 * FlareSolverr-klient med én genbrugt session.
 *
 * Bygger på flaresolverrFetch() i Bodega Bets' lib/pcsFetch.ts (commit b021a60),
 * udvidet med sessions.create/destroy, så Cloudflare-cookien genbruges på tværs
 * af opslag i stedet for at løse en challenge pr. side. Sessionen har sit eget
 * navn, så den ikke deler browser eller cookie med Bodega Bets' sync.
 */

export type SolverResult = { status: number; html: string }

/** FlareSolverr selv fejlede (nede, timeout, challenge ikke løst). */
export class SolverError extends Error {}

type SolverResponse = {
  status?: string
  message?: string
  session?: string
  solution?: { status?: number; response?: string }
}

export class FlareSolverr {
  private readonly endpoint: string
  private readonly timeoutMs: number
  private session: string | null = null
  private sessionCounter = 0

  constructor(baseUrl: string, timeoutMs: number) {
    this.endpoint = `${baseUrl.replace(/\/$/, '')}/v1`
    this.timeoutMs = timeoutMs
  }

  private async call(body: Record<string, unknown>): Promise<SolverResponse> {
    let res: Response
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        // Lidt længere end FlareSolverr's egen timeout, så den når at svare.
        signal: AbortSignal.timeout(this.timeoutMs + 30_000),
      })
    } catch (err) {
      throw new SolverError(`FlareSolverr kunne ikke kontaktes: ${String(err)}`)
    }
    let data: SolverResponse
    try {
      data = (await res.json()) as SolverResponse
    } catch {
      throw new SolverError(`FlareSolverr svarede HTTP ${res.status} uden JSON`)
    }
    if (!res.ok || data.status !== 'ok') {
      throw new SolverError(`FlareSolverr ${body.cmd}: ${data.message ?? `HTTP ${res.status}`}`)
    }
    return data
  }

  async createSession(): Promise<string> {
    this.sessionCounter++
    const id = `gresearch-${process.pid}-${Date.now()}-${this.sessionCounter}`
    await this.call({ cmd: 'sessions.create', session: id })
    this.session = id
    return id
  }

  async destroySession(): Promise<void> {
    if (!this.session) return
    const id = this.session
    this.session = null
    try {
      await this.call({ cmd: 'sessions.destroy', session: id })
    } catch {
      // En død session kan ikke lukkes; det er fint.
    }
  }

  /** Lukker den nuværende session (hvis den lever) og opretter en ny. */
  async renewSession(): Promise<string> {
    await this.destroySession()
    return this.createSession()
  }

  async get(url: string): Promise<SolverResult> {
    if (!this.session) await this.createSession()
    const data = await this.call({
      cmd: 'request.get',
      url,
      session: this.session,
      maxTimeout: this.timeoutMs,
    })
    const sol = data.solution
    return { status: sol?.status ?? 200, html: sol?.response ?? '' }
  }
}
