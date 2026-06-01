# DataGuard — Complete Internal Technical Reference

This document covers every internal decision, mechanism, precaution, trade-off, and optimization in the DataGuard scanner. Written for technical reviewers and interviewers who want to understand how the system actually works, not just what it does.

> **Last updated:** Reflects all changes through commit `b8e4afc` — classifier upgrades, performance optimizations, and non-determinism fixes.

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
13. [Performance — Before vs After Optimizations](#13-performance--before-vs-after-optimizations)
14. [Accuracy — Real-World Picture](#14-accuracy--real-world-picture)
15. [Known Blind Spots](#15-known-blind-spots)
16. [Design Decisions Summary](#16-design-decisions-summary)

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

Two completely separate databases are always in play:
- **App DB** (PostgreSQL/Supabase): stores DataGuard's own data — sources, scan runs, findings, catalogue
- **Target DBs** (PostgreSQL or MongoDB): the databases being scanned for PII — DataGuard connects to these only during a scan run, never at any other time

---

## 2. Database Schema Design

Five tables in the app DB. Every primary key is a UUID (`gen_random_uuid()` via `pgcrypto`). All timestamps are UTC `TIMESTAMPTZ`.

### `data_sources`
Stores connection details for target databases. The entire connection config (host, port, user, password, connectionString) is stored as a single `TEXT` column containing AES-256-CBC encrypted JSON. The plaintext JSON never touches the database — it is encrypted in the application layer before the INSERT, and decrypted after the SELECT, only when a scan is about to start.

`CHECK (type IN ('postgresql', 'mongodb'))` enforces that only supported database types are registered.

### `scan_profiles`
Reusable scan configurations stored as `JSONB`. A profile says which schemas/collections to include or exclude, how many rows to sample per column, and batch size. Profiles are linked to a source via `ON DELETE CASCADE` — deleting a source wipes its profiles automatically.

### `scan_runs`
One row per scan execution. `status` is a constrained enum (`pending → running → completed | failed | partial | cancelled`). The `log` column is plain `TEXT` that gets lines buffered in memory and flushed in batches as the scan progresses — this is how real-time log streaming works. The frontend polls `/api/scans/:id/log` and new lines appear as the backend flushes them.

`scan_duration_ms`, `tables_scanned`, `findings_count`, `rows_sampled`, and `classifier_stats` (a JSONB breakdown of pattern vs LLM detections) are written at completion.

### `findings`
One row per detected PII field per scan run. Key columns:
- `field_path`: column name for PostgreSQL, dot-path for MongoDB (e.g. `contact.email`)
- `confidence_score`: 0–100 integer
- `confidence_level`: `HIGH | MEDIUM | LOW`
- `detection_reason`: human-readable string explaining exactly what matched and from which signal
- `sample_values_masked`: JSONB array of up to 3 masked sample values (e.g. `"j***@example.com"`)
- `review_status`: workflow state — `unreviewed → confirmed | rejected | reclassified`
- `published`: boolean — only `true` entries appear in the catalogue

Five indexes on `scan_run_id`, `source_id`, `pii_category`, `review_status`, `published` — every common query path is covered without full table scans.

### `catalogue_entries`
Immutable records of published findings. Populated only via explicit publish action after human review. Never stores raw values — only field paths and metadata. A trigger maintains `updated_at` on `data_sources` and `scan_profiles` automatically.

---

## 3. Security Layer

### Credential Encryption (`src/utils/crypto.js`)

Every target database password is encrypted with **AES-256-CBC** before being written to the app DB:

1. Derives a 32-byte key by running `SHA-256` over the `ENCRYPTION_KEY` env variable — accepts any-length string, always produces a valid 256-bit key.
2. Generates a fresh random 16-byte IV (`crypto.randomBytes(16)`) per encryption call — same password stored twice produces different ciphertext each time.
3. Stores `iv_hex:ciphertext_hex` as a single string — the IV travels with the ciphertext so decryption is self-contained.

**Why this matters:** if the app database is compromised (SQL dump, backup leak), the attacker still cannot connect to any target database without also having `ENCRYPTION_KEY`. The app DB contains gibberish where passwords should be.

`maskConnectionConfig()` strips passwords from config objects before they can be logged or returned in any API response.

### Credential-Stripping Logger (`src/utils/logger.js`)

Before any metadata object is logged, the logger filters keys matching `/password|secret|key|token|credential|auth/i`. Even if a developer accidentally passes a raw connection config to `logger.info()`, the password field is silently dropped. This is defense-in-depth — the encryption protects at rest, the logger protects in transit/logs.

### Input Validation

All API routes validate request bodies with **Joi** schemas before touching the database. UUID parameters are validated with a strict regex before any DB query — invalid UUIDs return 400 immediately. `port` must be an integer between 1 and 65535. `type` must be exactly `postgresql` or `mongodb`.

### SQL Injection Prevention in Identifiers

Table/column names cannot use parameterised queries. `sanitiseIdentifier()` double-quotes all identifiers and doubles internal double-quotes — the PostgreSQL standard for safe identifier quoting. All value parameters use `$1, $2` parameterisation.

---

## 4. Authentication

JWT tokens signed with `HS256` using a 64-char hex `JWT_SECRET`. Tokens expire in 8 hours. Delivered and stored as **httpOnly cookies** — browser JavaScript cannot read them.

Cookie flags in production:
- `httpOnly: true` — XSS-proof
- `secure: true` — HTTPS only
- `sameSite: 'none'` — required for cross-origin (Vercel frontend → Render backend); mandates `secure: true`

**Timing-safe login:** Always runs `bcrypt.compare()` even when no user is found (using a dummy hash). Prevents user-enumeration via response timing — a missing user and a wrong password both take ~100ms.

```js
const dummyHash = '$2a$12$invalidhashinvalidhashinvalidhas';
const valid = await bcrypt.compare(value.password, rows[0]?.password_hash ?? dummyHash);
```

---

## 5. PostgreSQL Connector — Internal Working

**File:** `src/connectors/postgresConnector.js`

### Step 1: Schema Discovery — 1 Query (was N+1)

**Original approach (removed):** 3 nested loops — 1 query for schemas, 1 per schema for tables, 1 per table for columns. A database with 3 schemas × 20 tables produced **64 sequential round-trips** before any sampling began. At 50ms per round-trip on a remote DB, that was ~3 seconds just to discover the schema.

**Current approach:** A single `JOIN` across `information_schema.tables` and `information_schema.columns` returns all schemas, tables, and columns as flat rows, grouped in JavaScript:

```sql
SELECT t.table_schema, t.table_name, c.column_name, c.data_type,
       c.is_nullable, c.ordinal_position
FROM information_schema.tables  t
JOIN information_schema.columns c
  ON  c.table_schema = t.table_schema AND c.table_name = t.table_name
WHERE t.table_schema NOT IN ('pg_catalog','information_schema',...)
  AND t.table_type = 'BASE TABLE'
ORDER BY t.table_schema, t.table_name, c.ordinal_position
```

**Result: 64 queries → 1 query. ~3s → ~0.1s on a remote database.**

### Step 2: Incremental Scan — Unchanged Table Detection

Before sampling, checks `pg_stat_user_tables`:

```sql
SELECT relname FROM pg_stat_user_tables
WHERE schemaname = $1
  AND relname = ANY($2)
  AND n_mod_since_analyze = 0
  AND GREATEST(last_autoanalyze, last_autovacuum) > $3::timestamptz
```

A table is skipped if: (1) no rows changed since last ANALYZE, and (2) the ANALYZE happened after the previous scan. Both conditions required. Unchanged tables keep their previous scan's findings — re-scans of stable databases are dramatically faster.

### Step 3: Distributed Sampling — Why Not `LIMIT 100`?

`LIMIT 100` without `ORDER BY` returns the oldest rows (seed/test data). On a 10M-row production table, the first 100 rows are almost never representative. Instead, sampling is split across three slices — beginning, middle, end:

```sql
(SELECT col FROM table WHERE col IS NOT NULL ORDER BY ctid LIMIT 34)
UNION ALL
(SELECT col FROM table WHERE col IS NOT NULL ORDER BY ctid OFFSET 416 LIMIT 34)
UNION ALL
(SELECT col FROM table WHERE col IS NOT NULL ORDER BY ctid OFFSET 866 LIMIT 34)
```

`ORDER BY ctid` reads rows in physical heap order — faster than a B-tree index scan and stable within a single query.

### Step 4: REPEATABLE READ Transaction — Determinism Fix

**The problem:** COUNT and SELECT are two separate queries. Between them, autovacuum can move rows to different physical pages (changing their `ctid`), making the OFFSET calculation stale. A 900-row table sampled twice in quick succession could return completely different rows.

**The fix:** All column sampling for one table runs inside a `REPEATABLE READ` transaction. PostgreSQL takes a consistent heap snapshot at `BEGIN` — both COUNT and all SELECTs see the exact same data regardless of concurrent autovacuum or writes:

```js
await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
// ... all column sampling for this table ...
await client.query('COMMIT');
// On error: ROLLBACK — no partial state
```

**Result: Identical data → identical samples → identical findings on every scan run.**

### Step 5: Connection Pooling

A `pg.Pool` (max 5 connections) is created per scan run and destroyed at the end. With 4 tables scanning concurrently (`SCAN_CONCURRENCY = 4`), the connector uses at most 4 connections against the target database at any moment.

---

## 6. MongoDB Connector — Internal Working

**File:** `src/connectors/mongodbConnector.js`

### Key Difference from PostgreSQL

MongoDB has no schema. Every field must be inferred by examining actual documents — the discovery phase is inherently probabilistic. A field present in only 5% of documents might not appear in the 100-document sample at all.

### Step 1: Collection Discovery and Concurrency

`db.listCollections().toArray()` returns all collection names. Collections are then processed **4 at a time** using `runWithConcurrency(collectionTasks, 4)` — the same concurrency pattern as PostgreSQL's table scanning. Previously, collections were processed sequentially; one slow collection blocked all others.

### Step 2: Deterministic Document Sampling — `_id` Range (was `.skip()`)

**Original approach (removed):** Three `.find().skip(offset).limit(n)` calls. MongoDB's `.skip()` is O(n) — it must scan and discard `offset` documents before returning results. For a collection with 1M documents, `.skip(500000)` scans half the collection to return 34 documents. With no `sort()`, document order was also non-deterministic between runs.

**Current approach:** ObjectId-based range queries using timestamp interpolation:

```js
// Get first and last _id anchors (both use the _id index — O(log n))
const [firstDoc, lastDoc] = await Promise.all([
  db.collection(name).findOne({}, { sort: { _id: 1 }, projection: { _id: 1 } }),
  db.collection(name).findOne({}, { sort: { _id: -1 }, projection: { _id: 1 } }),
]);

// ObjectId encodes a Unix timestamp in its first 4 bytes.
// Interpolate the midpoint timestamp → O(1) middle anchor, no skip needed.
const t1    = firstDoc._id.getTimestamp().getTime();
const t2    = lastDoc._id.getTimestamp().getTime();
const midId = ObjectId.createFromTime(Math.floor((t1 + t2) / 2 / 1000));

const [startDocs, midDocs, endDocs] = await Promise.all([
  db.collection(name).find({}).sort({ _id: 1 }).limit(slice).toArray(),
  db.collection(name).find({ _id: { $gte: midId } }).sort({ _id: 1 }).limit(slice).toArray(),
  db.collection(name).find({}).sort({ _id: -1 }).limit(slice).toArray(), // reversed then flipped
]);
```

All three fetches use the `_id` index — O(log n) each. **Middle slice: O(n) scan → O(1) indexed range query.**

For non-ObjectId primary keys (string, integer, custom), falls back to sort+skip — at least with `.sort({ _id: 1 })` for deterministic ordering across runs.

Small collections (≤ 200 docs) use a simple `find().sort({ _id: 1 }).limit(100)` — no slicing needed.

**Known trade-off:** ObjectId timestamp interpolation assumes documents are roughly uniformly distributed over time. A collection where 90% of documents were inserted in one burst and 10% trickled in later will produce a biased middle sample (landing in the sparse period). The old `.skip()` was statistically more representative but prohibitively slow at scale.

### Step 3: Document Flattening

`flattenDocument()` recursively walks nested documents into dot-path keys:

```
contact.email          → "user@example.com"
contact.phones.0       → "+91-9876543210"
addresses.0.street     → "12 MG Road"
```

Rules: `_id` skipped, arrays indexed up to first 3 elements, max recursion depth 8, `Date` → ISO 8601 string.

### Step 4: Array Path Normalisation

`normalizeArrayPath()` strips numeric indices so `addresses.0.street` and `addresses.1.street` both merge into `addresses.street`. All values from all array positions pool into one field with a combined sample — the classifier sees one field with many values, not many identical fields with one value each.

### Step 5: Leaf-Name Classification

For dot-paths like `contact.personal_info.id`, only the leaf (`id`) is used for name-based matching. `id` is in `NON_PII_EXACT_NAMES` and gets suppressed — even though `personal_info.id` might be sensitive. Same data in PostgreSQL as column `customer_id` would detect as `USER_ID`. Deeply nested MongoDB fields produce fewer findings than equivalent flat PostgreSQL columns.

### Step 6: TLS Handling

`mongodb+srv://` URIs get `tls: true, tlsAllowInvalidCertificates: true` — works with Atlas/cloud MongoDB without needing the CA bundle. Plain `mongodb://` URIs don't force TLS.

---

## 7. PII Classifier — Pattern Engine

**File:** `src/classifier/piiClassifier.js`

Runs entirely in memory — no network calls, no ML model. Operates on field names and sample values independently, then combines both signals.

### 17 PII Categories

**Core (pattern + LLM):** `NAME`, `EMAIL`, `PHONE`, `ADDRESS`, `DOB`, `GENDER`, `AADHAAR`, `PAN`, `BANK_ACCOUNT`, `USER_ID`, `CREDENTIAL`

**Extended (pattern + LLM):** `SALARY`, `HEALTH`, `MARITAL`, `NATIONALITY`

**Newly added:** `RELIGION`, `BIOMETRIC`

**RELIGION** — Covers `religion`, `faith`, `caste`, `sub_caste`, `community`, `sect`, `gotra`, `jati`. These are Article 9 GDPR and DPDP Act 2023 sensitive categories — collecting them without explicit consent is a compliance violation. Were completely invisible to the scanner before.

**BIOMETRIC** — Covers `fingerprint_data`, `face_encoding`, `iris_template`, `voice_print`, `dna_sequence`. Name-only detection (biometric values are binary blobs or float arrays, not regex-matchable strings). The column name alone is sufficient signal.

### Stage 1: Field Name Normalisation — Improved CamelCase Splitter

```js
str
  .replace(/([a-z\d])([A-Z])/g, '$1 $2')    // firstName → first Name
  .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // XMLParser → XML Parser
  .replace(/([a-zA-Z])(\d)/g, '$1 $2')        // firstName2 → firstName 2
```

Handles: `firstName`, `FIRST_NAME`, `first-name`, `FirstName`, `XMLParser`, `field2name` — all normalise correctly.

### Stage 2: Name-Based Matching

**Strong match:** All keywords in a set are present in the field's token set — unambiguous.

**Weak match** (only for `NAME`, `PHONE`, `ADDRESS`, `USER_ID`, `HEALTH`, `SALARY`, `RELIGION`): Any keyword appears as a substring. Weak match produces LOW confidence without a value signal.

HEALTH, SALARY, and RELIGION were added to WEAK_MATCH_CATEGORIES — `work_health`, `annual_salary_details`, `employee_religion` are real column names that only partially match. Weak matching catches them at LOW confidence; LLM confirms or drops.

### Stage 3: Suppression Rules

Multiple guard layers run before keyword matching:

| Rule | Example suppressed | Why |
|---|---|---|
| `NON_PII_EXACT_NAMES` | `id`, `status`, `type`, `balance`, `currency` | Single-token names that are definitively non-PII |
| Counter suppression | `login_count`, `error_num`, `session_count` | Last/any token is a metric word |
| Boolean prefix | `is_active`, `has_email`, `can_login` | Flag columns, not data columns |
| Age metric | `age_group`, `age_limit`, `min_age` | Demographic buckets, not personal birth data |
| Hash context | `file_hash`, `content_hash`, `commit_sha` | Integrity checksums, not credential hashes |
| Currency/mode | `currency_code`, `payment_mode` | Financial metadata, not personal data |
| Error code | `error_code`, `status_code`, `response_code` | System codes, not PII |
| Product dimensions | `product_weight`, `package_height`, `item_length` | Physical attributes of objects, not people |
| Entity name (2-token) | `bank_name`, `company_name`, `scheme_name`, `branch_name` | Organisation names, not person names |
| IP address override | `ip_address`, `ip_addr` | Network identifier → `USER_ID`, not ADDRESS |
| Username override | `username`, `uname`, `loginname` | Login identifier → `USER_ID`, not NAME |

### Stage 4: Value-Level Patterns — 16 Regex Patterns

Tested in fixed specificity order (most unambiguous first):

```
EMAIL → PAN → AADHAAR → PASSPORT → IFSC → MAC → UUID →
CARD → PHONE → IPV4 → PINCODE → ZIP → DOB → NAME → GENDER → RELIGION
```

**New patterns added:**

| Pattern | Format | Maps to category |
|---|---|---|
| `PASSPORT` | `[A-Z][0-9]{7}` — Indian passport | `AADHAAR` |
| `MAC` | `aa:bb:cc:dd:ee:ff` | `USER_ID` |
| `UUID` | `8-4-4-4-12` hex groups, v1-v5 | `USER_ID` |
| `PINCODE` | 6 digits, first non-zero — Indian pincode | `ADDRESS` |
| `ZIP` | `12345` or `12345-6789` — US ZIP | `ADDRESS` |
| `RELIGION` | `Hindu|Muslim|Christian|Sikh|...` (case-insensitive) | `RELIGION` |

**Existing patterns extended:**

- `PHONE`: added US/Canada NANP (`(555) 123-4567`, `555-123-4567`, `555.123.4567`) and UK mobile (`07xxx xxxxxx`, `+44 7xxx xxxxxx`)
- `DOB`: added `DD-Mon-YYYY` (`15-Jan-1990`) and `DD Month YYYY` (`15 January 1990`)
- Hash patterns: added SHA-512, Argon2, and PBKDF2 detection alongside existing MD5/SHA-1/SHA-256/bcrypt/base64

### Stage 5: Keyword Dictionary Expansions

Every category received significant additions. Highlights:

**NAME:** `father_name`, `mother_name`, `nominee`, `guardian`, `beneficiary`, `spouse_name`, `alt_name`, `applicant_name`, `candidate_name`, `holder_name`

**EMAIL:** `personal_email`, `official_email`, `alternate_email`, `recovery_email`, `secondary_email`

**PHONE:** `emergency_contact`, `alt_phone`, `alternate_no`, `secondary_mobile`, `home_no`, `office_no`, `contact_number`

**ADDRESS:** `billing_address`, `shipping_address`, `delivery_address`, `permanent_address`, `registered_address`, `line1`/`line2`, `latitude`, `longitude`, `lat`, `lng`

**HEALTH:** `height`, `weight`, `bmi`, `condition`, `disease`, `medication`, `lab_result`, `blood_pressure`, `cholesterol`, `disability`, `special_needs`

**SALARY:** `bonus`, `hike`, `allowance`, `hra`, `pf`, `take_home`, `net_pay`, `gross_pay`, `variable_pay`, `package`, `lpa`

**CREDENTIAL:** `mpin`, `tpin`, `totp`, `security_answer`, `backup_code`, `recovery_code`, `digital_signature`

**AADHAAR:** `ssn`, `sin` (Canada), `nric`, `tin` — global government ID coverage

**USER_ID:** `transaction_id`, `order_id`, `booking_id`, `vendor_id`, `merchant_id`, `referral_code`

### Stage 6: Threshold-Based Detection

**NAME:** ≥ 60% of samples must match NAME regex (after title-casing ALL-CAPS values).

**GENDER:** ≥ 60% of samples must match gender values. Was previously 100% — one unexpected value killed the finding. Changed to 60% to match NAME threshold and handle real-world dirty data.

**RELIGION:** ≥ 60% of samples must match the religion value list.

**ADDRESS:** Sample must contain a digit AND a known address keyword (`road`, `nagar`, `colony`, `building`, `marg`, `boulevard`, etc. — 30+ keywords).

**DOB value-only suppression:** If a date value matches DOB regex but the column name contains operational timestamp tokens (`created`, `updated`, `hired`, `joined`, `purchase`, `transaction`, `submission`, `approval`, etc.), the DOB match is discarded. Only applies when there is no name-based match — a column explicitly named `dob` is always flagged.

### Stage 7: Sample Window

Increased from **15 → 20 samples** per field for better statistical coverage. More samples means majority-vote thresholds (NAME, GENDER, RELIGION) are less likely to produce false results from a small biased window.

### Stage 8: Confidence Scoring

| Name match | Value match | Score | Level |
|---|---|---|---|
| Strong | Yes | 92 | HIGH |
| Strong | No (or hashed) | 62 | MEDIUM |
| Weak | Yes | 57 | MEDIUM |
| None | Yes — high-specificity (EMAIL/PAN/AADHAAR/PHONE/UUID/MAC/IFSC/CARD/PASSPORT) | 72 | MEDIUM |
| None | Yes — lower-specificity (DOB/NAME/GENDER/RELIGION/ADDRESS) | 50 | MEDIUM |
| Weak | No | 25 | LOW |
| None | No | — | no finding |

High-specificity value-only matches now score 72 (not 50). An email pattern in a column named `data_col` is far more certain than a generic date pattern — the scoring now reflects this.

### Stage 9: Masking Improvements

- **UUID values**: keeps version and variant nibbles for structural recognition by the LLM (`a3f1****-****-4***-****-...`)
- **Short enum values** (gender M/F, blood groups A+/B-, religion Hindu/Muslim): not masked — they're not PII themselves and the LLM needs to see the pattern to classify correctly
- **Long numeric values** (phone, Aadhaar): keeps last 4 digits
- **General values**: keeps first char, masks up to 6 chars

---

## 8. LLM Classifier — Gemini Layer

**File:** `src/classifier/llmClassifier.js`

Optional layer — only active when `GEMINI_API_KEY` is set. Uses **Gemini 2.5 Flash** (temperature 0, `responseMimeType: 'application/json'` for cleaner output).

### Why an LLM Layer?

The pattern classifier misses columns with non-standard names and no value-detectable format:
- `ctc` (Cost to Company) — not obviously salary
- `bg` (blood group) — `A+`, `B-` values are too short for regex
- `emp_relig` — abbreviated religion field
- Any column with encrypted/hashed values where the name is unclear

Regex cannot handle context. A language model can.

### Data Privacy — Masked Values Only

Raw PII values never leave the server. Every sample is passed through `maskValue()` before the prompt is built. The LLM receives structural patterns (`j***@example.com`, `******9012`) — enough signal to classify without actual data egress.

### Pattern Hints — New

The LLM now receives the **pattern classifier's pre-analysis** for every column being classified:

```
Pattern classifier pre-analysis:
  - "email_id": pattern says EMAIL [HIGH] — Field name "email_id" strongly matches EMAIL pattern; Sample values match EMAIL regex pattern
  - "ph_num": pattern says PHONE [MEDIUM] — Field name "ph_num" weakly matches PHONE pattern
  - "remarks": no pattern match found
```

The LLM is told to treat these as weak hints, not ground truth. This has two benefits:
1. The LLM confirms HIGH-confidence pattern findings — if both agree, confidence is upgraded further
2. The LLM has a starting point for ambiguous columns — instead of guessing from zero, it sees what the regex already found and can confirm or override

### Table Context — New

Every prompt includes the full list of column names in the table:

```
All columns in table: id, first_name, last_name, email, phone, salary, department_id, created_at
```

This lets the LLM infer table purpose. A column named `remarks` in a table with `patient_id`, `diagnosis`, and `medication` is likely a health note — a completely different classification than `remarks` in a transaction table.

### Single Batch Call Per Table

All columns in one table are classified in a single Gemini API call. Reduces API calls from N (one per column) to 1 per table. In-memory column cache (SHA-256 keyed, cleared on restart) means re-scans of unchanged columns skip the API entirely.

### Retry Logic — New

On failure (rate limit, network error, malformed JSON), the classifier retries once with a 1.5-second backoff:

```js
for (let attempt = 0; attempt < 2; attempt++) {
  try {
    // ... LLM call
    break;
  } catch (err) {
    if (attempt === 0) await new Promise(r => setTimeout(r, 1500));
  }
}
```

If both attempts fail, the scan continues with pattern-only results — the LLM is never a hard dependency.

### Expanded Categories and Few-Shot Examples

PII_CATEGORIES now includes `RELIGION` and `BIOMETRIC`. The prompt has 30+ few-shot examples covering:
- Religion/caste (`religion`, `caste`, `community`)
- Biometric (`fingerprint_data`, `face_encoding`)
- GPS coordinates (`lat`, `lng` → ADDRESS, not USER_ID)
- Salary abbreviations (`hra`, `pf`, `bonus`)
- Indian credential types (`mpin`, `otp_secret`)
- Emergency contact, nominee, guardian names
- Product dimension false positives (`product_weight` → null)
- Foreign key false positives (`department_id` → null)
- Financial metric false positives (`balance`, `currency` → null)

### System Prompt

Reframed around Indian and global data privacy law:

> *"You are a senior database PII auditor specialising in Indian data privacy law (DPDP Act 2023, IT Act 2000) and global regulations (GDPR, CCPA)."*

The framing matters — DPDP Act 2023 makes caste, religion, and health data explicitly sensitive. Telling the LLM this upfront improves classification of Indian-specific fields like `caste`, `gotra`, `jati`.

---

## 9. Merge Strategy — Pattern + LLM

**File:** `src/classifier/llmClassifier.js` (`mergeResults()`)

| Pattern result | LLM result | Merged outcome |
|---|---|---|
| HIGH | LLM agrees | HIGH — adds "confirmed by LLM" note |
| HIGH | LLM disagrees | HIGH kept — disagreement noted in reason (pattern wins) |
| MEDIUM | LLM agrees same category | Upgraded to HIGH (score 91) |
| MEDIUM | LLM says different category | MEDIUM — reclassified to LLM's category |
| MEDIUM | LLM says null | MEDIUM kept — pattern has value-level proof |
| LOW | LLM agrees | Upgraded to MEDIUM (score 57) |
| LOW | LLM disagrees or null | Dropped — both uncertain |
| None | LLM HIGH | Added as MEDIUM (score 76) — no regex proof, capped |
| None | LLM MEDIUM | Added as LOW (score 46) |
| None | LLM LOW | **Not added** — too uncertain without any regex signal |
| None | None | No finding |

**Key principles:**
- Pattern HIGH is never downgraded. Regex match is concrete proof; LLM disagreement is probabilistic opinion.
- LLM-only findings are capped at MEDIUM — the LLM adds coverage, not authority.
- LLM-only LOW is now dropped (previously was added). Without regex confirmation, LOW LLM confidence produces too many false positives.
- When HIGH pattern and LLM disagree, the disagreement is recorded in `detection_reason` so a human reviewer can see the conflict.

---

## 10. Scan Engine — Orchestration

**File:** `src/scanner/scanEngine.js`

### Concurrency Controls

**Global limit (5 concurrent scans):** Pre-flight `COUNT(*) WHERE status = 'running'` check — returns HTTP 429 if at limit. Prevents pool exhaustion.

**PostgreSQL table concurrency (4 parallel):** `runWithConcurrency(tableTasks, 4)` — custom worker pool, no external library.

**MongoDB collection concurrency (4 parallel):** Same `runWithConcurrency` pattern. Previously, MongoDB collections were processed sequentially — one slow collection blocked all others. Now 4 collections run in parallel.

**LLM semaphore (3 concurrent Gemini calls):** A `Semaphore` class caps simultaneous Gemini API calls across all concurrent table/collection tasks:

```js
class Semaphore {
  constructor(n) { this._n = n; this._queue = []; }
  async acquire() { ... }  // waits if n = 0
  release() { ... }        // signals next waiter
}
const _llmSem = new Semaphore(3); // shared across PG and Mongo scanners
```

Without the semaphore, 4 concurrent tables × 2 DB scanners could produce 8 simultaneous Gemini calls — exceeding free-tier rate limits and causing cascade failures. The semaphore ensures at most 3 LLM calls are in-flight at once, globally.

**30-minute scan timeout:** `setTimeout` auto-cancels hung scans. `cancelScan()` adds the ID to a `_cancellations` Set checked between table scans.

### Buffered Logging — Was: 1 UPDATE per line

**Original:** Every `appendLog()` call did one `UPDATE scan_runs SET log = log || $1`. For a 30-table scan: ~150 individual UPDATE round-trips at ~50ms each = 7.5 seconds purely on logging.

**Current:** Lines accumulate in a `Map<scanRunId, string[]>` buffer. Flushed to the DB in one UPDATE when the buffer hits 10 lines, or explicitly at schema/collection boundaries and scan completion:

```js
async function appendLog(scanRunId, message) {
  buf.push(line);
  if (buf.length >= 10) await flushLog(scanRunId); // batch flush
}
async function flushLog(scanRunId) {
  await query(`UPDATE scan_runs SET log = log || $1 WHERE id = $2`,
    [buf.join('\n') + '\n', scanRunId]);
}
```

**Result: ~150 UPDATEs → ~15 UPDATEs. 7.5s → ~0.7s on a remote app DB.**

**Trade-off:** Up to 9 log lines can be lost on a hard process crash (SIGKILL). Findings data is unaffected — only the human-readable log is slightly incomplete.

### Batch Finding Inserts — Was: 1 INSERT per finding

**Original:** `saveFinding()` called inside a loop — one `INSERT INTO findings` per finding. 30 tables × 10 findings = 300 sequential INSERTs = ~15 seconds on a remote DB.

**Current:** `saveFindings()` builds a single multi-row `INSERT` per table:

```js
INSERT INTO findings (scan_run_id, source_id, ...)
VALUES ($1,$2,...,$10), ($11,$12,...,$20), ($21,$22,...,$30)
```

Tables with zero PII findings skip the INSERT entirely. **Result: 300 INSERTs → 1 per table with findings. ~15s → ~0.15s.**

**Correctness trade-off:** All findings for a table succeed or fail together (atomic per table). Previously, the 6th of 10 findings could be saved while the server crashed — partial table saves. Batch INSERT eliminates partial saves.

### Cache Invalidation on Completion

`cacheDel('catalogue:stats', 'sources:list')` after every scan. Dashboard reflects new findings immediately.

---

## 11. Async Execution and Queue

### In-Process Mode (no Redis)

`setImmediate()` defers scan execution to the next event loop tick. Caller gets `scanRunId` immediately. A 30-minute `setTimeout` auto-cancels if the scan hangs.

### BullMQ Mode (Redis available)

Scan jobs enqueued into a BullMQ queue. Separate worker process dequeues and runs them — server restarts don't kill running scans. `attempts: 1` (no auto-retry) because the scan run record already exists and re-inserting findings would corrupt state.

One IORedis connection shared by the queue, worker, and response cache.

---

## 12. Caching Layer

**File:** `src/utils/cache.js`

| Key | TTL | Invalidated by |
|---|---|---|
| `sources:list` | 15s | Scan completion (`cacheDel`) |
| `catalogue:stats` | 60s | Scan completion (`cacheDel`) |

All cache methods silently no-op if Redis is unavailable — the application works correctly without caching, just slower. The cache layer never throws.

---

## 13. Performance — Before vs After Optimizations

For a representative database: 3 schemas, 30 tables, 15 columns per table, remote app DB + remote target DB at 50ms round-trip.

| Phase | Before | After | What changed |
|---|---|---|---|
| Schema discovery | ~3s (64 queries) | ~0.1s (1 query) | N+1 → single JOIN |
| Table sampling (4 concurrent) | ~12s | ~12s | Unchanged (bottleneck is network, not query count) |
| Log writes | ~7.5s (150 UPDATEs) | ~0.7s (~15 batch UPDATEs) | In-memory buffer, flush every 10 lines |
| Finding inserts | ~7.5s (300 INSERTs) | ~0.15s (~10 batch INSERTs) | Multi-row INSERT per table |
| MongoDB collections | Sequential | 4 concurrent | `runWithConcurrency(4)` |
| MongoDB mid-slice fetch | O(n) `.skip()` | O(log n) `_id` range | ObjectId timestamp interpolation |
| **Total without LLM** | **~30s** | **~13s** | **2.3× faster** |
| LLM (3 semaphore slots) | ~90s | ~30s | Parallel slots + semaphore prevents rate-limit cascade |
| **Total with LLM** | **~120s** | **~43s** | **~2.8× faster** |

---

## 14. Accuracy — Real-World Picture

### Confidence Level Examples

| Situation | Score | Level |
|---|---|---|
| `email` column, values match email regex | 92 | HIGH |
| `pan_no` column, values match `ABCDE1234F` | 92 | HIGH |
| `cust_nm` column, values are `Rahul Sharma`, `Priya Patel` | 92 | HIGH |
| `email` column, values are bcrypt hashes | 62 | MEDIUM |
| `mob` column, integer type (no regex match) | 62 | MEDIUM |
| Any column, values clearly match email/PAN/Aadhaar/phone format | 72 | MEDIUM |
| `data` column, values happen to match email regex | 50 | MEDIUM |
| `contact` column, no value match | 25 | LOW |

### Expected Recall by Schema Quality

| Schema quality | Pattern only | Pattern + LLM |
|---|---|---|
| Standard naming + plaintext values | 88–93% | 93–96% |
| Standard naming + hashed values | 72–82% | 82–90% |
| Messy naming (`col1`, `data`) + detectable values | 52–68% | 72–82% |
| Messy naming + hashed values | 28–42% | 48–62% |
| Sparse MongoDB with irregular documents | 58–73% | 68–80% |
| Indian BFSI/HR schema (father_name, hra, mpin, pan) | 90–95% | 95–98% |

The last row is significantly improved from before — the expanded keyword dictionary was specifically built around Indian financial and HR data models.

### False Positive Rate

Estimated **4–8%** on well-modelled schemas (improved from 5–12% with better suppression rules). Main remaining sources:
- Columns with names that partially match PII keywords but store operational data (e.g. `contact_status`)
- Numeric columns where values accidentally match Aadhaar's 12-digit pattern
- Operational date columns not in the `NON_DOB_DATE_TOKENS` suppression list

---

## 15. Known Blind Spots

**1. Indirect / derived PII**
A `transaction_id` that can be joined to a `customers` table to identify a person is not flagged. Cross-table graph awareness requires schema relationship analysis — out of scope.

**2. PII buried in free-text**
A `notes` column with `"Call John at 9876543210"` — regexes use `^` and `$` anchors and test the full value. Numbers/names embedded mid-sentence are not detected. The LLM layer partially addresses this for columns named something suggestive, but cannot substring-scan arbitrary text.

**3. Custom two-column phone encoding**
Phone stored as two integers (`country_code = 91`, `phone_number = 9876543210`) — neither column alone triggers detection. Split-column PII requires column-combination analysis.

**4. Sparse MongoDB fields**
A field present in only 5% of documents may not appear in the 100-document sample at all. There is no way to discover a field without seeing it in at least one sampled document.

**5. JSONB column name mismatch**
A PostgreSQL column named `metadata JSONB` storing `{"phone": "+91-9876543210"}` — the phone number is extracted by `flattenSampleValue()` and will trigger value-level detection, but the finding is stored under the column name `metadata`, not `phone`. The name signal depends entirely on the outer column name.

**6. Data retention enforcement**
DataGuard finds where PII exists, not how long it has been there. A column with 10-year-old Aadhaar numbers is flagged identically to one with current data. Retention policy enforcement is outside scanner scope.

**7. LLM semaphore is process-local**
The `Semaphore(3)` object lives in one Node.js process's memory. If multiple backend worker processes run (BullMQ with N workers), each has its own independent semaphore. Combined Gemini concurrency would be `3 × N workers`. For single-process deployment this is correct. For horizontally scaled deployments, a Redis-backed distributed rate limiter would be needed.

**8. MongoDB ObjectId timestamp bias**
The `_id`-range middle-slice calculation assumes documents are uniformly distributed over time. Collections with bursty insert patterns (90% inserted in one week, rest spread over a year) produce a biased middle sample. The end and beginning slices are always accurate; the middle is an approximation.

---

## 16. Design Decisions Summary

| Decision | What was done | Why |
|---|---|---|
| AES-256-CBC for credentials | Encrypt entire connection config JSON before DB write | DB dump/backup leak doesn't expose target DB passwords |
| Random IV per encryption | `crypto.randomBytes(16)` every call | Same password stored twice → different ciphertext, no pattern leakage |
| Credential-stripping logger | Regex filter on metadata keys before log output | Defense-in-depth — accidental credential logging caught at logging layer |
| httpOnly + sameSite cookie | JWT in cookie, not localStorage | Eliminates XSS-based token theft |
| Timing-safe login | Dummy bcrypt hash for missing users | Prevents user-enumeration via response timing |
| Joi validation on all inputs | Schema validation before any DB query | Prevents injection, type confusion, oversized payloads |
| `sanitiseIdentifier()` | Double-quote all table/column identifiers | Prevents SQL injection through schema/table/column names |
| Schema discovery: 1 JOIN query | Replaced N+1 loop with single joined query | 64 queries → 1, ~3s → 0.1s on remote DB |
| `REPEATABLE READ` transaction | Wraps all column sampling per table | COUNT and SELECT see identical heap snapshot — eliminates autovacuum-induced non-determinism |
| `ORDER BY ctid` | Physical row order for sampling | Faster than index scan; deterministic within one query |
| Distributed 3-slice sampling | Beginning + middle + end of table/collection | Avoids sampling only seed/test data from table head |
| `_id` range sampling for MongoDB | ObjectId timestamp interpolation for middle slice | O(n) `.skip()` → O(log n) indexed range query |
| MongoDB `sort({ _id: 1 })` | Added to all collection finds | Deterministic document order across runs |
| MongoDB `runWithConcurrency(4)` | Collections processed 4 at a time | Was sequential — one slow collection blocked all others |
| Buffered logging | In-memory buffer, flush every 10 lines | 150 individual UPDATEs → 15 batch UPDATEs, saves ~7s on remote DB |
| Batch `saveFindings` | Multi-row INSERT per table | 300 individual INSERTs → 1 per table, saves ~15s on remote DB |
| LLM semaphore | `Semaphore(3)` caps concurrent Gemini calls | Prevents rate-limit cascade when 4+ tables run in parallel |
| Pattern hints to LLM | Pass pattern findings as context in LLM prompt | LLM confirms/refines/overrides regex findings instead of starting from zero |
| Table context in LLM prompt | All column names included in every prompt | LLM infers table purpose — `weight` in a medical table → HEALTH, not a product attribute |
| LLM retry with backoff | 1 retry at 1.5s on failure | Transient rate limits/network glitches don't silently drop all LLM detections |
| `responseMimeType: 'application/json'` | Gemini told to return JSON directly | Eliminates need to strip markdown code fences from response |
| LLM-only LOW dropped | `if (llm.confidence === 'LOW') continue` | Without regex confirmation, LOW-confidence LLM-only findings are too noisy |
| Pattern HIGH never overridden | LLM disagreement noted, not applied | Regex match is concrete proof; LLM disagreement is probabilistic |
| LLM-only capped at MEDIUM | LLM HIGH → MEDIUM (76), LLM MEDIUM → LOW (46) | LLM is a signal, not authority — regex proof required for HIGH |
| In-memory LLM column cache | SHA-256 keyed Map, cleared on restart | Avoids redundant API calls for unchanged columns across re-scans |
| RELIGION + BIOMETRIC categories | Added to both pattern and LLM classifiers | DPDP Act 2023 + GDPR Article 9 sensitive categories — were invisible to scanner before |
| 17 PII categories total | Core 11 + SALARY + HEALTH + MARITAL + NATIONALITY + RELIGION + BIOMETRIC | Comprehensive coverage of Indian regulatory requirements |
| Weak matching for HEALTH, SALARY, RELIGION | Added to `WEAK_MATCH_CATEGORIES` | `annual_salary_details`, `employee_religion` partially match — LOW confidence is better than no detection |
| Sample window: 20 (was 15) | `nonNullSamples.slice(0, 20)` | Better statistical coverage for majority-vote thresholds (NAME/GENDER/RELIGION) |
| High-specificity value score: 72 | EMAIL/PAN/Aadhaar/phone value-only → 72, not 50 | A regex-matched email in a column named `data` is far more certain than a matched date pattern |
| Short enum values unmasked | Gender M/F, blood groups, religion values not masked | LLM needs to see the pattern to classify correctly; these values are not PII themselves |
| `NON_DOB_DATE_TOKENS` expanded | Added `purchase`, `transaction`, `payment`, `approval`, `submission` | More operational date column names suppressed from false DOB detection |
| Entity token list expanded | Added `scheme`, `fund`, `portfolio`, `account`, `branch` | `scheme_name`, `fund_name` are entity names, not person names |
| UUID primary keys | `gen_random_uuid()` via pgcrypto | No sequential ID enumeration; globally unique across environments |
| `ON DELETE CASCADE` | Deleting a source wipes profiles and runs | Prevents orphaned records |
| Published findings → catalogue | Explicit publish step required after human review | Raw scanner output never treated as authoritative |
| 60% majority for NAME/GENDER/RELIGION | Consistent threshold across all majority-vote detections | Handles real-world dirty data without flipping on/off from one unexpected sample |
| Redis cache with silent no-op | All cache methods safe without Redis | Redis is optional — application works correctly without it |
| Cache invalidation on scan complete | `cacheDel('catalogue:stats', 'sources:list')` | Dashboard reflects new scan results immediately |
