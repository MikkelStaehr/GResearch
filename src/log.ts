import fs from 'node:fs'
import path from 'node:path'
import { LOG_DIR } from './config.ts'

fs.mkdirSync(LOG_DIR, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
export const logFile = path.join(LOG_DIR, `run-${stamp}.log`)

function write(level: string, msg: string): void {
  const line = `${new Date().toISOString()} ${level} ${msg}`
  if (level === 'WARN' || level === 'ERROR') console.error(line)
  else console.log(line)
  fs.appendFileSync(logFile, line + '\n')
}

export const log = {
  info: (msg: string) => write('INFO', msg),
  warn: (msg: string) => write('WARN', msg),
  error: (msg: string) => write('ERROR', msg),
}
