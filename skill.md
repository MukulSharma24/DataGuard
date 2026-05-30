# DataGuard — Product & Technical Write-Up

---

## 1. Product Scope

DataGuard is a PII (Personally Identifiable Information) discovery and governance tool. It connects to PostgreSQL and MongoDB databases, scans every column and field for personal data, presents findings for human review, and builds a permanent, auditable data catalogue.

The product answers the core compliance question:
> *"What personal data exists in our databases, where exactly is it stored, how confident are we, and how can a reviewer confirm it?"*

This is the answer regulators require under India's **DPDP Act**, the **GDPR**, and similar data protection frameworks.

**What DataGuard does:**
- Discovers schemas, tables, collections, and fields dynamically — no prior knowledge of the database structure is required
- Classifies PII using a hybrid pattern classifier (keyword dictionaries + regex) with an optional Gemini 2.5 Flash LLM layer
- Presents every finding with a confidence level, detection reason, and masked sample values
- Guides a reviewer through a confirm / reject / reclassify workflow
- Publishes confirmed findings to a permanent, searchable data catalogue
- Visualises the PII landscape by source, category, and field on a data map

**What DataGuard does not do:**
- Enforce data retention, deletion, or minimisation policies
- Manage consent or data subject requests
- Replace a full enterprise DLP or DSPM platform

---

## 2. Assumptions Made

1. **Target databases are accessible over the network.** The scanner connects directly using the supplied credentials. VPN or SSH tunnelling is the operator's responsibility.
2. **The app database (PostgreSQL) is managed separately from scan targets.** DataGuard stores its own state in a dedicated PostgreSQL instance and never modifies target databases.
3. **Column/field names are primarily in English.** The pattern classifier uses English keyword dictionaries. Non-English column names rely on the LLM layer.
4. **PII is not 100% encrypted or tokenised in the scanned database.** Fully tokenised values are detected by name only (with MEDIUM confidence) and flagged as hashed/encrypted in the detection reason.
5. **Sample values are sufficient for classification.** Up to 100 non-null values per column are sampled. For uniform columns (e.g. `email`), 3–5 samples confirm the type with high certainty.
6. **The evaluator has admin access to the target databases.** The connector needs SELECT permission on all tables and collections to scan them.

---

## 3. Setup Instructions

See **README3.md** for the full step-by-step setup guide.

**Quick summary:**
```bash
# 1. Create app database
psql postgres -c "CREATE USER dataguard WITH PASSWORD 'dataguard_secret';"
psql postgres -c "CREATE DATABASE dataguard OWNER dataguard;"

# 2. Configure backend
cd backend && cp .env.example .env

# 3. Install and migrate
npm install && npm run migrate

# 4. Start backend (port 4000)
npm run dev

# 5. Start frontend in a new terminal (port 3000)
cd ../frontend && npm install && npm run dev
```

---

## 4. Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `APP_DB_*` | Yes | Connection to DataGuard's own PostgreSQL |
| `ENCRYPTION_KEY` | Yes | AES-256-CBC key for encrypting stored target credentials |
| `JWT_SECRET` | Yes | HS256 signing key for session tokens |
| `PORT` | No | Backend port (default: 4000) |
| `CORS_ORIGIN` | No | Frontend origin (default: http://localhost:3000) |
| `GEMINI_API_KEY` | No | Enables LLM classification layer (Gemini 2.5 Flash) |
| `REDIS_URL` | No | Enables BullMQ job queue for async scan processing |

---

## 5. Commands to Run

```bash
# Backend
npm run dev        # development with hot-reload (nodemon)
npm start          # production
npm run migrate    # run database migrations (one-time)
npm run worker     # start BullMQ scan worker (requires REDIS_URL)
npm test           # run classifier unit tests (38 tests)

# Frontend
npm run dev        # development server on port 3000
npm run build      # production build
npm start          # serve production build
```

---

## 6. How to Connect PostgreSQL and MongoDB

### PostgreSQL
The PostgreSQL connector (`backend/src/connectors/postgresConnector.js`) uses `pg.Pool`. It:
- Connects using the standard PostgreSQL wire protocol
- Reads `information_schema.schemata` to discover all non-system schemas
- Reads `information_schema.tables` and `information_schema.columns` per schema
- Does **not** modify, insert, or delete any data in the target database

**Minimum permissions required on the target database:**
```sql
GRANT CONNECT ON DATABASE your_db TO scan_user;
GRANT USAGE ON SCHEMA public TO scan_user;          -- repeat for each schema
GRANT SELECT ON ALL TABLES IN SCHEMA public TO scan_user;
```

### MongoDB
The MongoDB connector (`backend/src/connectors/mongodbConnector.js`) uses the official `mongodb` driver. It:
- Connects using a standard MongoDB URI
- Uses `listCollections()` to discover all collections dynamically
- Uses `find().limit(N)` with projection to sample documents
- Recursively flattens nested documents to dot-path notation (e.g. `user.contact.email`) up to depth 8

Both connectors handle connection timeouts, empty tables/collections, and SSL configuration.

---

## 7. How to Run a Scan

1. **Add a Source** — `/sources` → Add Source → fill in connection details → Test → Save
2. **Create a Profile** — `/profiles` → New Profile → select source, configure options → Create
3. **Trigger the Scan** — click Run Scan on the profile card
4. **Watch the Log** — the scan detail page shows a live-updating log (polled every 3 seconds)
5. **Review Findings** — expand table groups → click Review on each finding → Confirm / Reject / Reclassify
6. **Publish** — click "Publish N finding(s) to Catalogue"

The scan runs asynchronously. The API returns a `scan_run_id` immediately with status `running`. The frontend polls `/api/scans/:id` every 3 seconds until terminal status is reached.

---

## 8. Supported PII Categories

| Category | Detection Targets |
|---|---|
| `NAME` | first_name, last_name, full_name, fname, lname, fn, ln, cust_nm, display_name, surname |
| `EMAIL` | email, email_address, emailId, emailAddr, mail, work_email |
| `PHONE` | phone, mobile, mob, cell, ph, phn, pno, cno, mbl, contact_no |
| `ADDRESS` | address, street, city, state, pincode, zip, addr1, addr2, haddr, colony, nagar, village |
| `DOB` | date_of_birth, dob, birthdate, dob_dt, born_on, bd, bday, age |
| `GENDER` | gender, sex, gndr, gnd, gen |
| `AADHAAR` | aadhaar, aadhar, aadhaar_no, uid (Indian context) |
| `PAN` | pan, pan_no, pan_number, pan_card |
| `BANK_ACCOUNT` | account_number, ifsc_code, card_no, bank_acc, iban, swift, acct, walletid |
| `USER_ID` | user_id, login, customer_id, emp_id, member_id, pid, handle, deviceid, ip_addr |
| `CREDENTIAL` | password, passwd, pwd, api_key, token, secret, pwd_hash, access_token |

Every finding also includes:
- Source database and schema/collection path
- Detected category
- Confidence level (HIGH / MEDIUM / LOW) and numeric score (0–100)
- Detection reason (field-name match, regex match, value-sample match, or combined)
- Up to 3 masked sample values

---

## 9. Detection Logic

The classifier (`backend/src/classifier/piiClassifier.js`) runs a four-stage pipeline on every field.

### Stage 1 — Field Name Normalisation
```
"firstName"       → ["first", "name"]
"email_address"   → ["email", "address"]
"cust_nm"         → ["cust", "nm"]
"user.contact.ph" → ["ph"]   ← MongoDB: only leaf segment used
```
Steps: split camelCase → lowercase → strip non-alphanumeric → tokenise.

### Stage 2 — Keyword Set Matching
Each PII category has a dictionary of token sets. A field matches if any token set from the dictionary is a **subset** of the field's normalised tokens.

```
NAME tokens: [["name"], ["fname"], ["firstname"], ["fn"], ["nm"], ...]
"first_name" → tokens: ["first", "name"] → contains ["name"] → NAME match (strong)

PHONE tokens: [["phone"], ["mobile"], ["ph"], ["mob"], ["mbl"], ...]
"ph" → tokens: ["ph"] → exact match → PHONE match (strong)
```

Two tiers exist:
- **Strong match**: complete token set subset → higher base score
- **Weak match**: any single keyword appears as a substring → lower base score

### Stage 3 — Value-Level Regex
Sample values are tested against format-specific patterns:

| Category | Pattern |
|---|---|
| EMAIL | RFC-5321-style regex (`user@domain.tld`) |
| PHONE | Indian mobile (`+91`/`91`/`0` + 6–9 leading digit) + international `+[cc][number]` |
| PAN | `AAAAA9999A` exactly |
| AADHAAR | 12 digits, optionally space/hyphen-separated in groups of 4 |
| DOB | ISO 8601, DD/MM/YYYY, DD-MM-YYYY, YYYY/MM/DD |
| BANK_ACCOUNT | Card pattern (16 digits), IFSC (`AAAA0XXXXXX`), generic account number |
| NAME | 2–4 capitalised words with letters/hyphens/apostrophes |
| GENDER | Exact enum: `male`, `female`, `m`, `f`, `other`, `transgender`, `non-binary` |

### Stage 4 — Confidence Scoring

| Signal combination | Score | Level |
|---|---|---|
| Strong name match + value regex match | 90 | HIGH |
| Strong name match only | 60 | MEDIUM |
| Weak name match + value regex match | 55 | MEDIUM |
| Value regex match only | 50 | MEDIUM |
| Weak name match only | 25 | LOW |

**False positive suppressors applied before scoring:**
- Columns ending in `_count`, `_cnt`, `_total`, `_sum`, `_score`, `_rank` → suppressed (counters)
- Columns starting with `is_`, `has_`, `can_`, `was_`, `did_` → suppressed (boolean flags)
- Exact matches for `id`, `status`, `type`, `flag`, `balance`, `created_at`, `updated_at` → suppressed
- DOB detection suppressed for columns containing `join`, `hired`, `opened`, `start`, `end`, `last`, `updated`

**Hashed/encrypted value detection:**
Values matching MD5, SHA-1, SHA-256, bcrypt, or base64 patterns are detected by name only, with the detection reason noting "Values appear hashed/encrypted".

### Optional LLM Layer (Gemini 2.5 Flash)

When `GEMINI_API_KEY` is set, each table is sent to the LLM as a single batch call (one API call per table, not per column). The LLM sees column names, SQL types, and **masked** sample values — raw PII never leaves the environment.

**Merge strategy:**
- Pattern HIGH → always kept; LLM can only add a confirmation note
- Pattern MEDIUM + LLM agrees → upgraded to HIGH
- Pattern MEDIUM + LLM disagrees → reclassified to LLM category, stays MEDIUM
- Pattern LOW + LLM agrees → upgraded to MEDIUM
- Pattern LOW + LLM disagrees → **dropped** (both uncertain)
- Pattern null + LLM HIGH → added at MEDIUM (75 score; no regex proof)
- Pattern null + LLM MEDIUM/LOW → added at LOW (45 score)

The LLM cache is keyed on `sha256(column_name | sql_type | masked_samples)` — repeated scans of unchanged columns never make a redundant API call.

**Deterministic scanning:** All sampling queries use `ORDER BY ctid` to ensure the same physical rows are returned on every run for unchanged data. Combined with `temperature: 0` on the LLM, identical inputs always produce identical outputs.

---

## 10. Confidence Scoring Approach

Confidence is expressed as both a numeric score (0–100) and a banded level:

| Band | Score range | Meaning |
|---|---|---|
| HIGH | 85–100 | Strong name match confirmed by regex or LLM — very likely PII |
| MEDIUM | 40–84 | One signal only — probably PII, needs human review |
| LOW | 20–39 | Weak signal — possibly PII, review recommended |

Low-confidence findings are **never silently discarded**. They appear in the review UI with their detection reason clearly labelled (e.g. "Weak name match — no value regex match"). The reviewer decides.

---

## 11. Data Storage Model

DataGuard uses five tables in its own PostgreSQL database.

### `data_sources`
Stores registered target databases. `connection_config` holds AES-256-CBC encrypted JSON containing host, port, database, user, and password. The encrypted value is the only form ever written to disk.

### `scan_profiles`
Reusable configuration per source. `config` is a JSONB column storing include/exclude schemas, include/exclude collections, sampleSize, and batchSize.

### `scan_runs`
One row per scan execution. `log` is an append-only text column updated incrementally during the scan — the scan survives mid-run crashes because findings are saved per table, not at the end. `classifier_stats` (JSONB) stores `patternDetected`, `llmAdded`, `highCount`, `mediumCount`, `lowCount`, `rows_sampled`, and `scan_duration_ms`.

### `findings`
One row per detected PII field per scan run. `sample_values_masked` stores up to 3 masked values (never raw PII). `review_status` drives the workflow: `unreviewed` → `confirmed` / `rejected` / `reclassified`.

### `catalogue_entries`
The immutable published record. Populated via `INSERT INTO ... SELECT` from confirmed findings. Once published, entries are never modified or deleted by the application — this is the auditable inventory.

### `users`
`password_hash` stores bcrypt (cost 12) hashes. Plaintext passwords are never stored. Role is either `admin` (read + write) or `viewer` (read only).

### Key constraints
- `ON DELETE CASCADE` on all foreign keys — deleting a source removes all related profiles, scans, findings, and catalogue entries cleanly
- Unique constraint on `(finding_id)` in `catalogue_entries` — publishing is idempotent
- Unique constraint on `(scan_run_id, schema_name, table_name, field_path)` in `findings` — prevents duplicate findings from retried scans

---

## 12. What Is Mocked, Seeded, or Incomplete

| Item | Status | Notes |
|---|---|---|
| Seed databases | Demo only | `seed/postgres_seed.sql` and `seed/mongodb_seed.js` provide fake PII for local demos. The scanner does not depend on them. |
| Scheduling | Not implemented | Scans are triggered manually. A cron/event-based scheduler would be a production addition. |
| `reviewed_by` field | Populated by free text | There is no verification that the user identity matches the logged-in user. Requires full RBAC to be reliable. |
| Audit trail | Partial | HTTP requests are logged by Morgan. There is no structured audit log of "who confirmed finding X at time Y" tied to a verified identity. |
| Incremental MongoDB scans | Not implemented | MongoDB rescans all documents every time. PostgreSQL benefits from `pg_stat_user_tables` change detection. |
| WebSocket/SSE | Not implemented | Scan log is polled every 3 seconds from the frontend. |
| LLM cache persistence | In-memory only | The column cache is cleared on server restart. The first scan after restart re-classifies all columns via the LLM. |
| CSV export | Not implemented | Catalogue data is available via API; no export UI. |

---

## 13. Security and Privacy Considerations

### Credentials at Rest
Target database passwords are encrypted with AES-256-CBC (random IV per encryption, IV prepended to ciphertext) before being written to `data_sources.connection_config`. The `ENCRYPTION_KEY` must be protected — losing it renders all stored sources unusable.

### Credentials in Transit
Passwords are stripped from all log output by the logger middleware, which redacts any key matching `/password|secret|key|token|credential|auth/i`. They are never returned by any API endpoint after initial save.

### Sample Values
Only masked values are stored (e.g. `j***@gmail.com`, `******9012`). Raw PII is used in-memory only during classification and immediately discarded. The masking function is applied before any value is written to the database or sent to the LLM.

### LLM Data Egress
When `GEMINI_API_KEY` is configured, masked column samples are sent to Google's Gemini API. The structural pattern survives masking and is sufficient for classification (`r***@gmail.com` is clearly an email; `******9012` is clearly a 12-digit number). **Do not enable LLM mode on databases containing production PII unless this is permitted by your data governance policy.**

### Authentication
JWT tokens are issued as `httpOnly`, `sameSite: lax` cookies. They cannot be read by JavaScript even in the presence of an XSS vulnerability. Passwords are verified using `bcrypt.compare` (cost 12, ~300ms). The login endpoint always runs bcrypt even when the email does not exist, preventing user enumeration via timing.

### SQL Injection Prevention
All user-supplied values use parameterised queries (`$1`, `$2`, ...). Table and column names used in dynamic sampling queries are passed through `sanitiseIdentifier()`, which double-quotes identifiers after validating the character set.

### Rate Limiting
All `/api/*` routes: 200 requests per 15 minutes per IP. Scan trigger (`POST /api/scans`): 10 per minute per IP.

### Known Caveats

1. **SSL certificate validation disabled for scan targets** — `rejectUnauthorized: false` is used for PostgreSQL scan targets to support self-signed certificates in development environments. This should be made configurable in production.
2. **Single-process scan execution** — scans run in the Node.js event loop via `setImmediate`. For very large databases, a dedicated worker process (BullMQ + Redis) should be used.
3. **No field-level access control** — any authenticated user with `viewer` role can read all findings across all sources. Multi-tenancy would require tenant-scoped Row-Level Security in PostgreSQL.

---

## 14. What Would Be Built Next for Production

### Priority 1 — Security and Access Control
- **Full RBAC with multi-tenancy** — `tenant_id` on `data_sources`, PostgreSQL Row-Level Security, per-user API key rotation
- **Structured audit log** — immutable record of every review action tied to verified user identity and timestamp
- **SSL configuration for scan targets** — make `rejectUnauthorized` configurable per source

### Priority 2 — Operational Reliability
- **Scheduled scans** — cron-based or event-triggered re-scanning with configurable frequency
- **Incremental MongoDB scans** — change-stream or document count delta detection, mirroring the PostgreSQL `pg_stat_user_tables` approach
- **Persistent LLM cache** — store the column classification cache in Redis or the app database so server restarts do not trigger full re-classification
- **Scan log streaming** — replace 3-second polling with Server-Sent Events or WebSocket

### Priority 3 — Compliance Features
- **Data subject request (DSR) support** — given a user ID or email, locate all PII fields containing data for that individual across all sources
- **Retention policy enforcement** — tag catalogue entries with retention schedules and surface upcoming breaches
- **Data minimisation recommendations** — flag columns that appear to store PII but have no documented purpose
- **Deletion simulation** — model the downstream impact of deleting a finding (which tables reference it?)

### Priority 4 — Classifier Improvements
- **International PII patterns** — SSN (US), NI number (UK), passport formats for other jurisdictions
- **JSON blob scanning** — recursively parse TEXT columns that store JSON, extending coverage to schema-less PII
- **Distributed sampling for very large tables** — currently samples beginning/middle/end slices; a proper random sample with `TABLESAMPLE SYSTEM` would be more statistically rigorous
- **Confidence calibration** — collect reviewer feedback to adjust scoring weights over time

### Priority 5 — Developer Experience
- **CSV / PDF export** of catalogue and scan results for compliance reporting
- **Webhook notifications** — Slack, email, or PagerDuty alerts when high-confidence PII is found in a new table
- **Terraform / Helm chart** — infrastructure-as-code deployment templates
