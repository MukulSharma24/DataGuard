# DataGuard — Complete Internal Technical Reference

This document covers every internal decision, mechanism, precaution, and trade-off in the DataGuard scanner. Written for technical reviewers and interviewers who want to understand how the system actually works, not just what it does.

---

## Table of Contents

1. [System Architecture](#1-system-architecture)
2. [Database Schema Design](#2-database-schema-design)
3. [Security Layer](#3-security-layer)
4. [Authentication](#4-authentication)
5. [PostgreSQL Connector — Internal Working](#5-postgresql-connector--internal-working)
6. [MongoDB Connector — Internal Working](#6-mongodb-connector--internal-working)
7. [PII Classifier — Pattern Engine](#7-pii-classifier--pattern-engine)
8. [LLM Classifier — Gemini Layer](#8-llm-classifier--gemini-layer)
9. [Merge Strategy — Pattern + LLM](#9-merge-strategy--pattern--llm)
10. [Scan Engine — Orchestration](#10-scan-engine--orchestration)
11. [Async Execution and Queue](#11-async-execution-and-queue)
12. [Caching Layer](#12-caching-layer)
13. [Accuracy — Real-World Picture](#13-accuracy--real-world-picture)
14. [Known Blind Spots](#14-known-blind-spots)
15. [Design Decisions Summary](#15-design-decisions-summary)

---

## 1. System Architecture

```
Browser (Next.js 14)
      │  REST API (JSON + httpOnly cookie auth)
      ▼
Express.js Backend (:4000)
      │
      ├── Routes (sources, profiles, scans, findings, catalogue, auth)
      ├── Scan Engine (orchestrates the full scan lifecycle)
      │       ├── PostgreSQL Connector  ─────────────► Target PostgreSQL DB
      │       └── MongoDB Connector    ─────────────► Target MongoDB
      │
      ├── PII Classifier (pure JS — no network, no ML)
      ├── LLM Classifier (optional — Gemini 2.5 Flash via Google AI SDK)
      │
      ├── App DB: PostgreSQL via Supabase
      │       (stores sources, profiles, runs, findings, catalogue)
      │
      ├── Redis (optional — BullMQ job queue + response cache)
      └── Logger (credential-stripping structured logger)
```

There are two completely separate databases in play:
- **App DB** (PostgreSQL/Supabase): stores DataGuard's own data — sources, scan runs, findings, catalogue
- **Target DBs** (PostgreSQL or MongoDB): the databases being scanned for PII — DataGuard connects to these only during a scan run

---

## 2. Database Schema Design

Five tables in the app DB. Every primary key is a UUID (`gen_random_uuid()` via `pgcrypto`). All timestamps are UTC `TIMESTAMPTZ`.

### `data_sources`
Stores connection details for target databases. The entire connection config (host, port, user, password, connectionString) is stored as a single `TEXT` column containing AES-256-CBC encrypted JSON. The plaintext JSON never touches the database — it is encrypted in the application layer before the INSERT, and decrypted after the SELECT, only when a scan is about to start.

`CHECK (type IN ('postgresql', 'mongodb'))` enforces that only supported database types are registered.

### `scan_profiles`
Reusable scan configurations stored as `JSONB`. A profile says which schemas/collections to include or exclude, how many rows to sample per column, and batch size. Profiles are linked to a source via `ON DELETE CASCADE` — deleting a source wipes its profiles automatically.

### `scan_runs`
One row per scan execution. `status` is a constrained enum (`pending → running → completed | failed | partial | cancelled`). The `log` column is a plain `TEXT` that gets rows appended to it line by line as the scan progresses — this is how real-time log streaming works. The frontend polls `/api/scans/:id/log` and each new line appears as the backend appends it mid-scan.

`scan_duration_ms`, `tables_scanned`, `findings_count`, `rows_sampled`, and `classifier_stats` (a JSONB breakdown of pattern vs LLM detections) are written at completion.

### `findings`
One row per detected PII field per scan run. Key columns:
- `field_path`: column name for PostgreSQL, dot-path for MongoDB (e.g. `contact.email`)
- `confidence_score`: 0–100 integer
- `confidence_level`: `HIGH | MEDIUM | LOW`
- `detection_reason`: human-readable string explaining exactly what matched
- `sample_values_masked`: JSONB array of up to 3 masked sample values (e.g. `"j***@example.com"`)
- `review_status`: workflow state — `unreviewed → confirmed | rejected | reclassified`
- `published`: boolean — only `true` entries appear in the catalogue

Five indexes on `scan_run_id`, `source_id`, `pii_category`, `review_status`, `published` — every common query path is covered.

### `catalogue_entries`
Immutable records of published findings. Populated only via explicit publish action. Never stores raw values — only field paths and metadata. A trigger maintains `updated_at` on `data_sources` and `scan_profiles` automatically.

---

## 3. Security Layer

### Credential Encryption (`src/utils/crypto.js`)

Every target database password is encrypted with **AES-256-CBC** before being written to the app DB. The implementation:

1. Derives a 32-byte key by running `SHA-256` over the `ENCRYPTION_KEY` environment variable — this lets the env var be any length string while always producing a valid 256-bit key.
2. Generates a fresh random 16-byte IV (`crypto.randomBytes(16)`) for every encryption call — same password stored twice gets a different ciphertext each time.
3. Stores `iv_hex:ciphertext_hex` as a single string — the IV travels with the ciphertext so decryption is self-contained.

Why this matters: if the app database is compromised (SQL dump, backup leak), the attacker still cannot connect to any target database without also having `ENCRYPTION_KEY`. The app DB contains gibberish where passwords should be.

`maskConnectionConfig()` is a separate utility that strips the password from a config object before it can ever be logged or returned in an API response.

### Credential-Stripping Logger (`src/utils/logger.js`)

Before any metadata object is logged, the logger filters out keys matching `/password|secret|key|token|credential|auth/i`. This is a case-insensitive regex applied at the logging layer — even if a developer accidentally passes a full connection config object to `logger.info()`, the password field is silently dropped from the output.

Log level is controlled by the `LOG_LEVEL` env variable (`ERROR | WARN | INFO | DEBUG`). Production defaults to `INFO`.

### Input Validation

All API routes validate request bodies using **Joi** schemas before touching the database. For example, the `createSourceSchema` validates that `type` is strictly `postgresql` or `mongodb`, and the `pgConfigSchema` validates that `port` is an integer between 1 and 65535. UUID parameters are validated with a regex (`/^[0-9a-f]{8}-[0-9a-f]{4}…$/i`) before any DB query — invalid UUIDs return 400 without hitting the database.

### SQL Injection Prevention in Identifiers

Table names and column names cannot be passed as query parameters because PostgreSQL does not allow parameterised identifiers. The `sanitiseIdentifier()` function in the PostgreSQL connector handles this:

```js
function sanitiseIdentifier(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_$]*$/.test(name)) {
    return `"${name.replace(/"/g, '""')}"`;
  }
  return `"${name}"`;
}
```

If the name is already a safe alphanumeric identifier it gets double-quoted for safety. If it contains special characters (e.g. a table named `my-table`), double-quote escaping is applied and internal double-quotes are doubled (`""`). This is the PostgreSQL standard for identifier quoting and prevents injection via schema/table/column names.

All other query parameters (values, UUIDs, limits, offsets) use standard `$1, $2` parameterised queries.

---

## 4. Authentication

JWT tokens are signed with `HS256` using a 64-char hex `JWT_SECRET`. Tokens expire in 8 hours. They are delivered and stored as **httpOnly cookies** — the browser JavaScript cannot read or steal them.

Cookie flags in production:
- `httpOnly: true` — prevents XSS-based token theft
- `secure: true` — only sent over HTTPS
- `sameSite: 'none'` — required for cross-origin requests (Vercel frontend → Render backend). `sameSite: 'none'` mandates `secure: true`.

**Timing-safe login:** After looking up the user by email, the code always runs `bcrypt.compare()` even if no user was found (using a dummy hash). This prevents an attacker from figuring out whether an email is registered by measuring response time — without the dummy hash, a missing user returns immediately while a wrong password takes ~100ms for bcrypt.

```js
const dummyHash = '$2a$12$invalidhashinvalidhashinvalidhas';
const valid = await bcrypt.compare(value.password, rows[0]?.password_hash ?? dummyHash);
```

---

## 5. PostgreSQL Connector — Internal Working

**File:** `src/connectors/postgresConnector.js`

### Step 1: Schema Discovery

The connector uses `information_schema.schemata` to list all user schemas (excludes `pg_catalog`, `information_schema`, `pg_toast`, and anything starting with `pg_`). For each schema it queries `information_schema.tables` for base tables only (not views), then `information_schema.columns` to get column name, data type, and nullability — ordered by `ordinal_position` to preserve natural column order.

This gives an authoritative, complete list of every column before any data is sampled. PostgreSQL has no ambiguity here — the schema is always known upfront.

### Step 2: Incremental Scan — Unchanged Table Detection

Before sampling anything, the engine checks `pg_stat_user_tables`:

```sql
SELECT relname FROM pg_stat_user_tables
WHERE schemaname = $1
  AND relname = ANY($2)
  AND n_mod_since_analyze = 0
  AND GREATEST(
    COALESCE(last_autoanalyze, '1970-01-01'),
    COALESCE(last_autovacuum,  '1970-01-01')
  ) > $3::timestamptz
```

A table is considered unchanged if:
1. `n_mod_since_analyze = 0` — no rows have been inserted, updated, or deleted since the last ANALYZE
2. The last ANALYZE happened *after* the previous scan ran

Both conditions must be true. Unchanged tables are skipped entirely — their findings from the previous scan remain in the database. This makes re-scans of stable databases dramatically faster.

### Step 3: Sampling — Why Not Just `LIMIT 100`?

Simple `LIMIT 100` without an `ORDER BY` returns whatever rows happen to be on the first pages of the heap — usually the oldest inserted rows (seed data, test data). On a production table with 10 million rows, the first 100 rows are almost never representative of current data.

Instead, sampling is distributed across three slices — beginning, middle, and end:

```
total non-null rows: 900
slice = ceil(100/3) = 34

beginning: rows 0–33     (ctid order)
middle:    rows 416–449  (ctid order, offset ≈ total/2)
end:       rows 866–899  (ctid order, last slice)
```

This is implemented with a single `UNION ALL` query:

```sql
(SELECT col FROM table WHERE col IS NOT NULL ORDER BY ctid LIMIT 34)
UNION ALL
(SELECT col FROM table WHERE col IS NOT NULL ORDER BY ctid OFFSET 416 LIMIT 34)
UNION ALL
(SELECT col FROM table WHERE col IS NOT NULL ORDER BY ctid OFFSET 866 LIMIT 34)
```

For small tables (non-null count ≤ 200), all non-null rows are returned up to the limit — no need for slicing.

### Step 4: `ORDER BY ctid` and Why It Matters

`ctid` is PostgreSQL's physical row location — it encodes `(page_number, slot_number)`. Ordering by `ctid` reads rows in physical heap order, which is:
- Faster than ordering by a B-tree index (heap scan rather than index scan + fetch)
- Stable across repeated queries when the table hasn't changed
- Deterministic — same data always produces the same row order within one query

The `ORDER BY ctid` applies within each parenthesised subquery of the `UNION ALL`, so each slice independently guarantees its rows are in physical order before OFFSET is applied.

### Step 5: REPEATABLE READ Transaction (the non-determinism fix)

The COUNT and the subsequent SELECT are two separate queries. Without a transaction, autovacuum can run between them:
1. `SELECT COUNT(*)` returns 900
2. Autovacuum runs, reorganises the heap, dead rows are reclaimed
3. `SELECT ... OFFSET 450` now hits completely different physical rows than intended

The fix: wrap all column sampling for a table in a `REPEATABLE READ` transaction. Under this isolation level, PostgreSQL takes a consistent snapshot of the database at the `BEGIN` point. Both the COUNT and all subsequent SELECTs see identical data, regardless of what concurrent writes or autovacuum do.

```js
await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
// ... all column samples for this table ...
await client.query('COMMIT');
```

If any column sampling fails, the transaction is rolled back (no partial state) and the error propagates to the scan engine which marks the table as a partial failure.

### Step 6: Connection Pooling

A `pg.Pool` (max 5 connections) is created per scan run and destroyed at the end of the scan (`pool.end()`). The pool is scoped to the scan — multiple parallel column batches share the same pool. `sampleTable` acquires one connection from the pool for the duration of all column batches, then releases it back — so even with 4 concurrent table scans (the `SCAN_CONCURRENCY` limit), the connector uses at most 4 connections against the target database.

---

## 6. MongoDB Connector — Internal Working

**File:** `src/connectors/mongodbConnector.js`

### Key Difference from PostgreSQL

MongoDB has no schema. There is no `information_schema` to query. Every field must be inferred by looking at actual documents. This makes the entire discovery phase probabilistic — a field that only appears in 5% of documents might not appear in the sampled documents at all.

### Step 1: Collection Discovery

`db.listCollections().toArray()` returns all collection names. The connector then processes each collection in sequence.

### Step 2: Distributed Document Sampling

Same three-slice strategy as PostgreSQL. For each collection:
- If `estimatedDocumentCount() ≤ 200`: fetch all documents up to 100
- Otherwise: fetch beginning + middle + end slices using `.skip()` and `.limit()`

```js
const [startDocs, midDocs, endDocs] = await Promise.all([
  db.collection(name).find({}).limit(slice).toArray(),
  db.collection(name).find({}).skip(midSkip).limit(slice).toArray(),
  db.collection(name).find({}).skip(endSkip).limit(slice).toArray(),
]);
```

**Important caveat:** MongoDB's `.find()` without a `sort()` returns documents in natural order (insertion order for capped collections, arbitrary for regular collections). Unlike PostgreSQL's `ORDER BY ctid`, MongoDB has no equivalent stable physical ordering guarantee. This means MongoDB sampling is inherently less deterministic than PostgreSQL sampling between runs, especially if documents are added or deleted. The fix would be to add `.sort({ _id: 1 })` — `_id` is always indexed and monotonically increasing for ObjectId, which gives a stable order.

### Step 3: Document Flattening

MongoDB documents are arbitrarily nested. A document might look like:
```json
{
  "contact": {
    "email": "user@example.com",
    "phones": ["+91-9876543210", "+91-8765432109"]
  },
  "addresses": [
    { "street": "12 MG Road", "city": "Bengaluru" }
  ]
}
```

`flattenDocument()` recursively walks the document tree and produces dot-path keys:
```
contact.email          → "user@example.com"
contact.phones.0       → "+91-9876543210"
contact.phones.1       → "+91-8765432109"
addresses.0.street     → "12 MG Road"
addresses.0.city       → "Bengaluru"
```

Rules:
- `_id` is always skipped (MongoDB internal key, not user data)
- Arrays are indexed up to the first 3 elements only (to keep the field count manageable)
- Nested objects are recursed up to depth 8 (guard against pathological self-referential documents)
- `Date` objects are converted to ISO 8601 strings before storage
- `null` / `undefined` values are stored as `null` (not as strings)

### Step 4: Array Path Normalisation

`addresses.0.street` and `addresses.1.street` are the same semantic field — they're both just the `street` sub-field of the `addresses` array. Storing them as separate findings would produce duplicates.

`normalizeArrayPath()` strips numeric indices from paths:
```
addresses.0.street  →  addresses.street
addresses.1.street  →  addresses.street  (same key — merged)
```

This means all values from `addresses[0].street`, `addresses[1].street`, etc. are pooled together into a single `addresses.street` field with a combined sample. The classifier sees one field with many sample values rather than many identical fields with one value each.

### Step 5: Leaf-Name Classification

For a dot-path like `contact.personal_info.national_id`, the classifier uses only the leaf segment (`national_id`) for name-based matching. This is intentional — the full path is stored in the finding (`field_path`), but PII keyword matching runs on the leaf because that's where the semantic meaning lives.

The side effect: `contact.personal_info.id` has leaf `id`, which is in `NON_PII_EXACT_NAMES` and gets suppressed. The same data in PostgreSQL stored as column `customer_id` would be detected as `USER_ID`. Deeply nested MongoDB fields can therefore produce fewer findings than equivalent flat PostgreSQL columns.

### Step 6: Connection and TLS

For `mongodb+srv://` URIs (Atlas, cloud-hosted), TLS is enabled automatically and `tlsAllowInvalidCertificates: true` is set. This lets cloud-hosted MongoDB instances work without needing to bundle the Atlas CA certificate — a pragmatic trade-off for a development tool. For plain `mongodb://` URIs, TLS is not forced.

---

## 7. PII Classifier — Pattern Engine

**File:** `src/classifier/piiClassifier.js`

The classifier runs entirely in memory — no network calls, no ML model. It operates on field names and sample values independently, then combines both signals.

### 11 PII Categories (+ 4 extended)

Core: `NAME`, `EMAIL`, `PHONE`, `ADDRESS`, `DOB`, `GENDER`, `AADHAAR`, `PAN`, `BANK_ACCOUNT`, `USER_ID`, `CREDENTIAL`

Extended (LLM only): `SALARY`, `HEALTH`, `MARITAL`, `NATIONALITY`

### Stage 1: Field Name Normalisation

Before any matching, the field name is normalised into a token array:

1. **CamelCase splitting:** `firstName` → `['first', 'Name']`
2. **Lowercase + symbol stripping:** `['first', 'Name']` → `['first', 'name']`
3. **Token deduplication:** handles `FIRST_NAME`, `first-name`, `firstName`, `first_name` all resolving to `['first', 'name']`

This means the keyword dictionaries only need to store the normalised form — `['firstname']` matches all the above variations automatically.

### Stage 2: Name-Based Matching

Two tiers of matching:

**Strong match:** Every keyword in a set is present in the field's token set.
```
field: pan_no → tokens: ['pan', 'no']
keyword set: ['pan'] → 'pan' is present → STRONG match → PAN category
```

**Weak match (only for NAME, PHONE, ADDRESS, USER_ID):** Any keyword appears as a substring of the joined token string.
```
field: work_phone → joined: 'workphone'
keyword: 'phone' → present as substring → WEAK match → PHONE category
```

Weak matching is only enabled for categories where partial name matches are still meaningful. For `EMAIL`, a field named `something_email_count` is almost certainly not an email field — strong match only prevents false positives. But for `PHONE`, `work_phone` really is a phone number.

### Stage 3: Suppression Rules (False Positive Prevention)

Multiple layers of suppression run before the keyword dictionaries are even checked:

**`NON_PII_EXACT_NAMES`:** Single-token names that are definitively non-PII regardless of values.
```
id, pk, status, type, kind, flag, code, active, enabled, amount, balance, price, count…
```
`state` alone is an OAuth state or FSM state, not a geographic state. `balance` is a financial metric. These would all produce false positives without suppression.

**Counter suppression:** If the last token is a metric word, the column is a counter, not personal data.
```
login_count → tokens: ['login', 'count'] → last token 'count' is a COUNTER_TOKEN → suppressed
error_num, visit_total, session_count → all suppressed
```

**Boolean prefix suppression:** `is_`, `has_`, `can_`, `should_`, `was_`, `did_`, `will_`, `allow_` prefixed columns are flag columns, not PII.
```
is_active, has_email, can_login → suppressed
```

**Age metric suppression:** `age` alone would match the DOB category. But `age_group`, `age_limit`, `min_age`, `max_age` are demographic buckets or operational metrics, not personal birth dates.
```
age_group, age_limit, age_band, age_tier → suppressed
```

**Hash context suppression:** `hash` alone would match `CREDENTIAL`. But `file_hash`, `content_hash`, `git_hash`, `commit_sha` are integrity checksums, not secrets.
```
file_hash, content_hash, git_hash → suppressed
```

**Entity name suppression:** A 2-token field containing `name` where the other token is an entity word is an organisation name, not a person's name.
```
bank_name, company_name, product_name, shop_name, dept_name → suppressed
company_owner_name (3 tokens) → NOT suppressed (could be a person's name)
```

**IP address override:** `ip_address` contains `address` which would normally match the ADDRESS category. But an IP address is a network identifier, not a physical location. Specific override maps `ip_*` fields to `USER_ID`.

**Username override:** `username`, `uname`, `loginname` contain `name` but are login identifiers, not person names. Specific override maps these to `USER_ID`.

### Stage 4: Value-Level Matching

Sample values are tested against regex patterns for high-specificity PII formats. Patterns are tested in a fixed order (most specific first) to avoid ambiguous matches:

```
EMAIL, PAN, AADHAAR, IFSC, CARD, PHONE, IPV4, DOB, NAME, GENDER
```

Why this order matters: A PAN card `ABCDE1234F` contains letters and numbers that might partially match other patterns. Testing PAN before more generic patterns ensures it's caught correctly.

Key patterns:
- `EMAIL`: standard RFC-compliant email regex
- `PHONE`: handles Indian mobile (`+91`/`91`/`0` prefix, 6-9 leading digit, 10 total) and international (`+[country][number]`)
- `PAN`: exact format `[A-Z]{5}[0-9]{4}[A-Z]`
- `AADHAAR`: 12 digits, optionally space/hyphen-separated in groups of 4
- `IFSC`: `[A-Z]{4}0[A-Z0-9]{6}` — the 5th character is always `0` for all Indian bank IFSC codes
- `NAME`: 2–4 capitalised words, allows hyphens and apostrophes (`Mary O'Brien`, `Jean-Paul Dupont`)

`IFSC` and `IPV4` value matches are remapped after detection — IFSC → `BANK_ACCOUNT`, IPV4 → `USER_ID`, since those are the correct PII category labels for those value types.

### Stage 5: Threshold-Based Detection

**NAME (majority vote):** A column is classified as containing names only if ≥ 60% of sample values match the NAME regex (after title-casing ALL-CAPS values like `RAHUL SHARMA` → `Rahul Sharma`). A single name-like value is not enough — it might be a product name or description.

**GENDER (majority vote):** A column is classified as GENDER if ≥ 60% of sample values match the GENDER pattern (`male`, `female`, `m`, `f`, `other`, `transgender`, `non-binary`, `prefer not to say`). Previously this required 100% — one unexpected value would kill the finding. Changed to 60% to match the NAME threshold and handle real-world dirty data.

**ADDRESS (keyword heuristic):** The classifier checks if sample values contain a digit AND a known address keyword (`road`, `street`, `nagar`, `colony`, `flat`, `building`, etc.). Both conditions must be true because `road` alone is not an address, and digits alone are not addresses.

### Stage 6: Non-Personal Date Suppression

Date-format values match the DOB regex. But `created_at`, `updated_at`, `joined_date`, `last_login`, etc. are operational timestamps, not birth dates. If a column's value matches the DOB pattern but the column name contains any of the following tokens, the DOB match is discarded:

```
created, updated, modified, timestamp, synced, deleted, expires, expiry,
scheduled, processed, join, joined, hire, hired, start, end, open, close,
issue, issued, effective, activated, register, signup, enrolled,
last, next, first, seen, at
```

This suppression only applies when the match is value-only (no name match). A column explicitly named `dob` or `date_of_birth` is always flagged regardless.

### Stage 7: Confidence Scoring

| Name match | Value match | Score | Level |
|---|---|---|---|
| Strong | Yes | 90 | HIGH |
| Strong | No | 60 | MEDIUM |
| Weak | Yes | 55 | MEDIUM |
| Weak | No | 25 | LOW |
| None | Yes | 50 | MEDIUM |
| None | No | — | not a finding |

The detection reason string is built from which signals fired, e.g.:
```
Field name "pan_no" strongly matches PAN pattern; Sample values match PAN regex pattern
```

---

## 8. LLM Classifier — Gemini Layer

**File:** `src/classifier/llmClassifier.js`

Optional layer — only active when `GEMINI_API_KEY` is set. Uses **Gemini 2.5 Flash** (temperature 0 for deterministic output).

### Why an LLM layer?

The pattern classifier misses columns with non-standard names and no value-detectable format. Examples:
- A column named `ctc` (Cost to Company) — not in the salary keyword list
- A column named `bg` (blood group) — not obvious from the name, values like `A+`, `B-` are short
- A column named `remarks` that stores free-text health notes

Regex cannot handle these. A language model that understands context can.

### Data Privacy — Masked Values to LLM

Raw PII values are never sent to the LLM. Before building the prompt, every sample value is passed through `maskValue()`:
- Emails: `john@example.com` → `j***@example.com`
- Phones/generic long values: last 4 digits visible, rest masked
- Short values: first character visible, rest masked

The LLM receives structural patterns, not actual data. It can still classify based on pattern (`j***@example.com` is clearly an email) without receiving the real value.

### Single Batch Call Per Table

Instead of one API call per column, all columns in a table are sent in a single prompt as a JSON array. This dramatically reduces API calls and latency. The prompt includes:
- The schema and table name
- Column name, SQL data type, masked sample values for each column
- Explicit rules for each PII category
- Few-shot examples showing correct classifications for edge cases

### In-Memory Column Cache

To avoid re-classifying the same column across re-scans, results are cached in a `Map` keyed by `SHA-256(column_name|data_type|sample_values)`. If the column name, type, and samples haven't changed since the last scan, the cached LLM result is used immediately — no API call made. This cache is in-process (lost on server restart) but effective for rapid re-scans during development or testing.

### Response Parsing

The LLM is instructed to return a raw JSON array with no markdown. In practice, Gemini sometimes wraps the JSON in code fences (` ```json ... ``` `). The parser strips those before parsing. It also extracts the JSON by finding the first `[` and last `]` — so even if the model adds preamble text, the JSON is still extracted correctly.

If the LLM call fails for any reason (rate limit, network error, malformed JSON), the error is caught and logged, and the scan continues with pattern-only results. The LLM layer is never a hard dependency.

---

## 9. Merge Strategy — Pattern + LLM

**File:** `src/classifier/llmClassifier.js` (`mergeResults()`)

When both classifiers run, their results are merged with these rules:

| Pattern result | LLM result | Merged outcome |
|---|---|---|
| HIGH (any) | LLM agrees | HIGH — adds "confirmed by LLM" note |
| HIGH (any) | LLM disagrees | HIGH — pattern wins (regex proof beats LLM opinion) |
| MEDIUM | LLM agrees same category | Upgraded to HIGH |
| MEDIUM | LLM says different category | MEDIUM — reclassified to LLM's category |
| MEDIUM | LLM says null | MEDIUM — kept (pattern has value-level proof) |
| LOW | LLM agrees | Upgraded to MEDIUM |
| LOW | LLM disagrees or null | Dropped entirely |
| None (pattern miss) | LLM HIGH | Added as MEDIUM (score 75) — no regex proof, capped |
| None (pattern miss) | LLM MEDIUM/LOW | Added as LOW (score 45) |
| None | None | No finding |

The key philosophy: pattern classifier results can only be upgraded, never downgraded below MEDIUM by the LLM. A column with a matching regex and a strong name match is not dismissed just because the LLM disagrees. LLM-only detections are always capped at MEDIUM — the LLM is a signal, not an authority.

---

## 10. Scan Engine — Orchestration

**File:** `src/scanner/scanEngine.js`

### Concurrency Controls

**Global limit (5 concurrent scans):** Before creating a scan run, the engine checks `COUNT(*) WHERE status = 'running'`. If 5 or more scans are already running, it returns HTTP 429. This prevents connection pool exhaustion against the app DB and target databases.

**Per-scan table concurrency (4 parallel):** Within a single PostgreSQL scan, tables are processed 4 at a time using a custom `runWithConcurrency()` worker pool. This is implemented without any external library — N worker coroutines share an index into the task array, each claiming the next task when it finishes. 4 was chosen to balance throughput against connection pool pressure (max pool size is 5).

**30-minute timeout:** A `setTimeout` auto-cancels any scan that exceeds 30 minutes. This handles hung connections, network timeouts, and any other scenario where the scan stops making progress but never errors. The `cancelScan()` function adds the scan run ID to a `_cancellations` Set, which is checked between table scans.

### Incremental Logging

Every significant event is appended to `scan_runs.log` in real time:
```
[2026-06-01T10:00:00.000Z] Discovering PostgreSQL schemas…
[2026-06-01T10:00:00.120Z] Found 3 schema(s): hr, finance, public
[2026-06-01T10:00:00.150Z] Scanning schema: hr (4 tables)
[2026-06-01T10:00:00.160Z]   ↷ Skipping 2 unchanged table(s): audit_log, config
[2026-06-01T10:00:00.200Z]   → hr.employees (12 columns)
[2026-06-01T10:00:00.450Z]     ✓ 7 PII field(s) found
```

The frontend polls the log endpoint and appends new lines — giving a real-time terminal-like experience without WebSockets.

### Partial Failure Handling

Each table is wrapped in its own try/catch. If sampling one table fails (permissions error, table dropped mid-scan, network timeout), the error is logged and `partialFailure = true` is set. The scan continues to all remaining tables. At completion, the status becomes `partial` instead of `completed`, signalling that results exist but are incomplete.

### Findings Saved Incrementally

Findings are written to the database one by one as they are classified (`saveFinding()` inside the table loop). If the server crashes mid-scan, findings from already-completed tables are preserved. The scan run stays in `running` status until a restart or timeout clears it, but no findings are lost.

### Cache Invalidation on Completion

After a scan completes, two cache keys are deleted:
- `catalogue:stats` — overview page statistics
- `sources:list` — source list with PII field counts

This ensures the dashboard reflects the new scan immediately rather than serving stale cached counts.

---

## 11. Async Execution and Queue

### In-Process Mode (no Redis)

The scan is started with `setImmediate()`, which defers execution to the next iteration of the event loop. The caller receives the `scanRunId` immediately (HTTP response is sent before the scan begins). The scan runs in the background as part of the same Node.js process.

### BullMQ Mode (Redis available)

When `REDIS_URL` is set, scan jobs are enqueued into a BullMQ queue (`dataguard-scans`). A separate worker process dequeues and runs them. This decouples the HTTP server from scan execution — the server can restart without killing running scans.

Job options: `attempts: 1` (no automatic retry) because the scan run record already exists and re-inserting findings would violate the database state. If a scan fails, the operator reviews the log and triggers a new scan manually.

The Redis connection is shared between the BullMQ queue, the BullMQ worker, and the response cache — a single IORedis connection serves all three.

---

## 12. Caching Layer

**File:** `src/utils/cache.js`

A thin Redis wrapper used for two API responses:
- `sources:list` — the source list query involves a CTE with a GROUP BY across findings — expensive at scale. Cached for 15 seconds.
- `catalogue:stats` — overview dashboard aggregates. Cached for 60 seconds.

If Redis is unavailable (no `REDIS_URL`, or connection lost), all cache methods silently no-op and return `null` — the application works correctly without caching, just slower. The cache layer never throws.

The sources list cache is explicitly deleted (`cacheDel('sources:list')`) on scan completion so the PII field counts update immediately. The 15-second TTL is a fallback in case invalidation is missed.

---

## 13. Accuracy — Real-World Picture

### Confidence Level Breakdown

| Situation | Confidence | Why |
|---|---|---|
| Column `email`, values match email regex | HIGH (90) | Strong name + value signal |
| Column `pan_no`, values look like `ABCDE1234F` | HIGH (90) | Strong name + value signal |
| Column `cust_nm`, values are `Rahul Sharma`, `Priya Patel` | HIGH (90) | Strong name + name-value signal |
| Column `email`, values are bcrypt hashes | MEDIUM (60) | Name strong, value hashed |
| Column `mob`, no value regex match (integer type) | MEDIUM (60) | Name strong, value type mismatch |
| Column `ph`, values are phone-format | MEDIUM (55) | Weak name + value match |
| Column `data`, values are emails | MEDIUM (50) | Name misses, value regex fires |
| Column `contact`, no clear values | LOW (25) | Weak name only |

### Expected Recall by Schema Quality

| Schema quality | Expected recall | Reasoning |
|---|---|---|
| Standard naming (`first_name`, `email`, `phone`, `dob`) + plaintext values | 90–95% | Both signals agree on almost everything |
| Standard naming + encrypted/hashed values | 75–85% | Name catches most, value signal lost |
| Non-standard naming (`col1`, `data`, `val`, `field_a`) + detectable values | 55–70% | Value-only detection, works for email/phone/PAN, misses NAME/ADDRESS |
| Non-standard naming + encrypted values | 30–45% | Near-blind — LLM layer helps significantly here |
| Standard naming + sparse MongoDB fields | 60–75% | Depends on whether sparse fields appear in the 100-doc sample |

### False Positive Rate

Estimated **5–10%** on well-modelled schemas. Main sources:
- Boolean columns with names like `is_valid` — suppressed by boolean prefix rules (rare misses)
- `type`, `status`, `code` columns where the content happens to match a pattern (e.g. a status code that looks like a phone number)
- `name` columns that store product names or team names — entity suppression handles most of these but not all 2-token combinations

---

## 14. Known Blind Spots

**1. Indirect / derived PII**
A column `transaction_id` that you can join to a `customers` table to get a person's identity is not flagged. The scanner has no cross-table graph awareness. Detecting indirect PII requires schema relationship analysis — out of scope for this version.

**2. PII buried in free-text**
A `notes` column containing `"Call John at 9876543210 re: Aadhaar verification"` — the scanner samples the whole value. It will match the phone number regex if the note starts with or is just a phone number, but will miss numbers embedded mid-sentence because the regex uses `^` and `$` anchors.

**3. Custom/domain encodings**
Phone numbers stored as `BIGINT` (e.g. `9876543210`) — `String(9876543210)` is `"9876543210"`, which matches the phone regex. This works. But a phone stored as two integers (country code `91`, number `9876543210`) in separate columns — neither column alone matches.

**4. Sparse MongoDB fields**
A field that only exists in premium-tier user documents (e.g. `passport_no`) but not in the sampled 100 documents will produce no finding. There is no way to know a field exists without seeing it in at least one document.

**5. Array values in PostgreSQL (JSONB)**
A PostgreSQL column of type `JSONB` that stores `{"phones": ["+91-9876543210"]}` — the `flattenSampleValue()` helper recursively unwraps arrays and objects, so the phone number does get extracted. But the classifier classifies the column under the JSONB column's name, not the nested key name — so the name signal depends on whether the JSONB column is named something like `contact` or `phone_data`.

**6. No detection of excessive data retention**
DataGuard finds *where* PII exists, not *how long it has been there*. A column storing 10-year-old Aadhaar numbers is flagged the same as one storing current data. Data retention policy enforcement is outside the scope of the scanner.

---

## 15. Design Decisions Summary

| Decision | What was done | Why |
|---|---|---|
| AES-256-CBC for credentials | Encrypt entire connection config JSON before DB write | DB dump / backup leak doesn't expose target DB passwords |
| Random IV per encryption | `crypto.randomBytes(16)` every call | Same password stored twice gets different ciphertext — no pattern leakage |
| Credential-stripping logger | Regex filter on metadata keys before log output | Defense-in-depth — accidental credential logging is caught at the logging layer |
| httpOnly + sameSite cookie | JWT in cookie, not localStorage | Eliminates XSS-based token theft |
| Timing-safe login | Dummy bcrypt hash for missing users | Prevents user-enumeration via response timing |
| Joi validation on all inputs | Schema validation before any DB query | Prevents injection, type confusion, and oversized payloads |
| `sanitiseIdentifier()` | Double-quote all table/column identifiers | Prevents SQL injection through schema/table/column names (can't be parameterised) |
| `REPEATABLE READ` transaction | Wraps all column sampling per table | COUNT and SELECT see identical heap snapshot — eliminates autovacuum-induced non-determinism |
| `ORDER BY ctid` | Physical row order for sampling | Faster than index scan; stable within a single query |
| Distributed 3-slice sampling | Beginning + middle + end of table | Avoids sampling only seed/test data from table head |
| Incremental finding writes | `saveFinding()` inside table loop | Findings survive server crash mid-scan |
| Per-table try/catch | Each table has independent error handling | One bad table doesn't abort the whole scan |
| `partial` scan status | Separate from `completed` | Operator knows results are incomplete without inspecting the log |
| 4 concurrent tables, 5 max concurrent scans | `runWithConcurrency(4)` + pre-flight count check | Balances throughput against connection pool pressure and prevents pool exhaustion |
| 30-minute scan timeout | `setTimeout` + cancellation Set | Prevents hung scans from blocking the queue indefinitely |
| Pattern classifier first, LLM optional | Always run regex; LLM only if `GEMINI_API_KEY` set | System works without LLM; LLM adds value without being a hard dependency |
| Masked values to LLM | `maskValue()` before building prompt | LLM classifies based on structure, not raw PII — no data egress |
| LLM-only capped at MEDIUM | LLM HIGH → stored as MEDIUM (75) | LLM is a signal, not authoritative — regex proof required for HIGH |
| Pattern HIGH never overridden | LLM disagreement doesn't downgrade a HIGH | Regex match is concrete proof; LLM opinion is probabilistic |
| In-memory LLM column cache | SHA-256 keyed Map, cleared on restart | Avoids redundant API calls for unchanged columns across re-scans |
| Redis cache with silent no-op | `cacheGet`/`cacheSet`/`cacheDel` are safe to call without Redis | Redis is optional — application runs correctly without it |
| Cache invalidation on scan complete | `cacheDel('catalogue:stats', 'sources:list')` | Dashboard reflects new scan results immediately |
| UUID primary keys | `gen_random_uuid()` via pgcrypto | No sequential ID enumeration attacks; globally unique across environments |
| `ON DELETE CASCADE` on scan_profiles | Deleting a source wipes its profiles and runs | Prevents orphaned records; simplifies source management |
| Published findings → catalogue | Explicit publish step required | Findings require human review before entering the catalogue — prevents raw scanner output from being treated as authoritative |
| 60% majority for NAME and GENDER | Both use the same threshold | Consistent behaviour; handles dirty data without flipping on/off due to one unexpected sample |
| `NON_DOB_DATE_TOKENS` suppression | Operational timestamp names suppress DOB value match | `created_at`, `joined_date` match the date regex — without suppression these would all become false DOB findings |
| Entity name suppression | 2-token `[entity]_name` suppressed | `bank_name`, `company_name` are not person names — without this, almost every `*_name` column would be flagged |
