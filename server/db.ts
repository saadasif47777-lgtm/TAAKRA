import pg from 'pg'
import { need } from './config.js'

export function createPool() {
  return new pg.Pool({
    connectionString: need('DATABASE_URL'),
    max: 12,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 15_000,
  })
}

export const documentKeys = ['passport-photo', 'student-card', 'cnic-front', 'cnic-back'] as const
export type DocumentKey = typeof documentKeys[number]

export interface Registration {
  reference: string
  request_key: string
  payload_hash: string
  submitted_at: Date
  expires_at: Date
  name: string
  roll: string
  department: string
  semester: string
  category: string
  mobile: string
  sheet_row: number
  status: 'pending' | 'complete' | 'purging'
  drive_ids: string[] | null
  attempts: number
}

export const schema = `
CREATE TABLE IF NOT EXISTS registration_sheet_cursor (
  singleton boolean PRIMARY KEY CHECK (singleton),
  next_row integer NOT NULL
);
INSERT INTO registration_sheet_cursor (singleton, next_row) VALUES (true, 2)
ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS registrations (
  reference text PRIMARY KEY,
  request_key text UNIQUE NOT NULL,
  payload_hash text NOT NULL,
  roll_key text UNIQUE NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  name text NOT NULL,
  roll text NOT NULL,
  department text NOT NULL,
  semester text NOT NULL,
  category text NOT NULL,
  mobile text NOT NULL,
  sheet_row integer UNIQUE NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','complete','purging')),
  drive_ids text[],
  attempts integer NOT NULL DEFAULT 0,
  next_attempt timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS registration_documents (
  reference text NOT NULL REFERENCES registrations(reference) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('passport-photo','student-card','cnic-front','cnic-back')),
  extension text NOT NULL CHECK (extension IN ('jpg','png')),
  data bytea NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 5242880),
  PRIMARY KEY (reference, kind)
);
CREATE TABLE IF NOT EXISTS rate_windows (
  client_key text PRIMARY KEY,
  hits integer NOT NULL,
  resets_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS registrations_work ON registrations (next_attempt) WHERE status <> 'complete';
CREATE INDEX IF NOT EXISTS registrations_retention ON registrations (expires_at);
`

export async function migrateDatabase(pool: pg.Pool) {
  // PostgreSQL runs these statements as one transaction and serializes concurrent startup migrations.
  await pool.query(`SELECT pg_advisory_xact_lock(20270110);
${schema}`)
}
