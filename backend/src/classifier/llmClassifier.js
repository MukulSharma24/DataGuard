'use strict';

const crypto = require('crypto');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { maskValue } = require('./piiClassifier');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// Per-column in-memory cache — avoids re-classifying identical columns
// across re-scans. Keyed by sha256(name|type|maskedSamples).
// ---------------------------------------------------------------------------
const _cache = new Map();

function columnCacheKey(col) {
  const raw = `${col.name}|${col.type}|${col.samples.join(',')}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

let _client = null;
function getClient() {
  if (!_client) {
    if (!process.env.GEMINI_API_KEY) return null;
    _client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return _client;
}

const PII_CATEGORIES = [
  'NAME', 'EMAIL', 'PHONE', 'ADDRESS', 'DOB', 'GENDER',
  'AADHAAR', 'PAN', 'BANK_ACCOUNT', 'USER_ID', 'CREDENTIAL',
  'SALARY', 'HEALTH', 'MARITAL', 'NATIONALITY', 'RELIGION', 'BIOMETRIC',
];

// ---------------------------------------------------------------------------
// Single-table batch classification
// ---------------------------------------------------------------------------

/**
 * Classify every column in one table with a single Gemini API call.
 *
 * @param {string}   schemaName
 * @param {string}   tableName
 * @param {Array<{name: string, dataType: string, samples: any[]}>} fields
 * @param {Array}    patternHints  — findings from the pattern classifier (optional).
 *                                   Passed as context so the LLM can confirm, refine,
 *                                   or override the regex-based pre-analysis.
 * @returns {Promise<Map<string, {piiCategory: string|null, confidence: string, reason: string}>>}
 */
async function classifyTableWithLLM(schemaName, tableName, fields, patternHints = []) {
  const client = getClient();
  if (!client) return new Map();

  const resultMap     = new Map();
  const uncachedFields = [];

  // Mask all sample values before they leave this environment
  const columnList = fields.map(f => ({
    name:    f.name,
    type:    f.dataType || 'unknown',
    samples: f.samples
      .filter(v => v !== null && v !== undefined && String(v).trim() !== '')
      .slice(0, 15)
      .map(v => maskValue(String(v).slice(0, 100))),
  }));

  // Serve cached columns immediately
  for (const col of columnList) {
    const key = columnCacheKey(col);
    if (_cache.has(key)) {
      resultMap.set(col.name, _cache.get(key));
    } else {
      uncachedFields.push({ col, key });
    }
  }

  if (uncachedFields.length === 0) {
    logger.info(`LLM cache: all ${fields.length} column(s) served from cache for ${schemaName}.${tableName}`);
    return resultMap;
  }

  const uncachedColumnList = uncachedFields.map(u => u.col);

  // Build a concise pattern-hints section so the LLM has a starting point.
  // The LLM is told to treat these as weak signals, not ground truth.
  const hintsByField = new Map(patternHints.map(h => [h.fieldPath, h]));
  const hintLines = uncachedColumnList
    .map(col => {
      const h = hintsByField.get(col.name);
      return h
        ? `  - "${col.name}": pattern says ${h.piiCategory} [${h.confidenceLevel}] — ${h.detectionReason}`
        : `  - "${col.name}": no pattern match found`;
    })
    .join('\n');

  // Provide all column names in the table for relational context.
  // Knowing a table has "patient_id, name, diagnosis, medication" helps classify ambiguous columns.
  const allColumnNames = fields.map(f => f.name).join(', ');

  const systemPrompt = `You are a senior database PII auditor specialising in Indian data privacy law (DPDP Act 2023, IT Act 2000) and global regulations (GDPR, CCPA).

Your job: classify each database column as PII or non-PII, based on the column name, SQL data type, and masked sample values.

Output ONLY a valid JSON array — no markdown, no explanation, no code fences.
One object per column, in the SAME ORDER as the input.

Be precise:
- False positives waste engineering time and cause alert fatigue.
- False negatives are compliance violations and legal risk.
- When genuinely uncertain, prefer MEDIUM over HIGH, and explain your uncertainty in the reason field.`;

  const userPrompt = `Table: ${schemaName}.${tableName}
All columns in table (for relational context): ${allColumnNames}

Pattern classifier pre-analysis for columns being classified (treat as weak hints — verify with your own analysis):
${hintLines}

Columns to classify (name | SQL type | masked sample values):
${JSON.stringify(uncachedColumnList, null, 2)}

Valid pii_category values: ${PII_CATEGORIES.join(', ')}, null
Use null when the column does NOT contain personal data.

Classification rules:
- NAME: real person's full/first/last/middle name. NOT: company names, product names, role names, branch names.
- EMAIL: email addresses. Strong signal: samples contain "@".
- PHONE: phone/mobile/fax numbers. Indian: 10 digits starting 6-9. US: (NXX) NXX-XXXX. UK: 07xxx xxxxxx.
- ADDRESS: physical addresses, street, city, pincode, ZIP, GPS coordinates (lat/lon are ADDRESS, not USER_ID).
- DOB: date of birth specifically. NOT: created_at, updated_at, joined_date, transaction dates, hire_date.
- GENDER: biological sex or gender identity (Male/Female/M/F/Other/Transgender/Non-binary).
- AADHAAR: Aadhaar UID (12-digit), Indian passport (letter+7 digits), voter ID (EPIC), driving licence, SSN, NID.
- PAN: PAN card (AAAAA9999A format), GSTIN, TAN, income tax IDs.
- BANK_ACCOUNT: account numbers, IFSC codes, UPI IDs, card numbers, IBAN, SWIFT, routing numbers.
- USER_ID: login names, internal IDs, session tokens, IP addresses, customer/employee/member IDs, UUIDs as system keys, device IDs, MAC addresses.
- CREDENTIAL: passwords, API keys, tokens, OTPs, PINs, MPINs, secrets, private keys, CVV, bcrypt/SHA hashes of passwords, security question answers.
- SALARY: salary, CTC, income, compensation, wages, bonus, allowance, HRA, PF, take-home, net pay, gross pay, package.
- HEALTH: blood group, medical diagnosis, disability, prescription, allergy, height, weight, BMI, blood pressure, medical condition, lab results.
- MARITAL: marital status (married/single/divorced/widowed), spouse information, civil status.
- NATIONALITY: nationality, citizenship, country of origin, ethnicity, residency status.
- RELIGION: religion, faith, caste, sub-caste, community, sect, gotra — sensitive under DPDP Act 2023 and GDPR Article 9.
- BIOMETRIC: fingerprint templates, face encodings, iris data, voice prints, DNA — raw biometric data, NOT enrollment IDs.
- null: status enums, type flags, counters, metrics, audit timestamps, boolean flags, foreign keys to non-PII tables, product attributes, financial transaction amounts.

All sample values are pre-masked. Classify based on visible structure + column name + data type.

Few-shot examples (samples shown masked):
- "cust_nm" VARCHAR ["R***l S****a","P***a P***l"] → NAME HIGH
- "father_name" VARCHAR ["A***l K***r","S***h P***l"] → NAME HIGH
- "nominee" VARCHAR ["S***a D***i"] → NAME MEDIUM (nominee stores a person name)
- "ph" BIGINT ["******3210","******6789"] → PHONE HIGH
- "emergency_contact" VARCHAR ["******4567"] → PHONE HIGH
- "dob" DATE ["1***-**-21"] → DOB HIGH
- "created_at" TIMESTAMP ["2***-**-**T**:30:00Z"] → null (system timestamp, not birth date)
- "hire_date" DATE ["2***-**-01"] → null (operational date)
- "gender" VARCHAR ["M","F","Other"] → GENDER HIGH
- "blood_group" VARCHAR ["A+","B-","O+"] → HEALTH HIGH
- "height_cm" NUMERIC ["1**","1**"] → HEALTH MEDIUM (anthropometric data)
- "salary" NUMERIC ["*****00","*****00"] → SALARY HIGH
- "ctc" NUMERIC ["*****000"] → SALARY HIGH
- "bonus" NUMERIC ["***00"] → SALARY MEDIUM
- "hra" NUMERIC ["***00"] → SALARY HIGH (house rent allowance)
- "password_hash" VARCHAR ["$***$10$..."] → CREDENTIAL HIGH
- "mpin" VARCHAR ["****"] → CREDENTIAL HIGH
- "otp_secret" VARCHAR ["J***A..."] → CREDENTIAL HIGH
- "ifsc" VARCHAR ["H***0001234"] → BANK_ACCOUNT HIGH
- "upi_id" VARCHAR ["u***@oksbi"] → BANK_ACCOUNT HIGH
- "ip_addr" VARCHAR ["1**.1**.*.1"] → USER_ID HIGH
- "session_id" VARCHAR ["a***b..."] → USER_ID HIGH
- "device_id" VARCHAR ["aa:bb:c*:d*:e*:ff"] → USER_ID HIGH (MAC address)
- "uid" UUID ["a***-..."] → USER_ID MEDIUM (system UUID)
- "lat" NUMERIC ["1*.****","2*.****"] → ADDRESS HIGH (GPS latitude)
- "pincode" VARCHAR ["**0001","**1003"] → ADDRESS HIGH (postal codes)
- "religion" VARCHAR ["H***u","M***m","C***t"] → RELIGION HIGH
- "caste" VARCHAR ["B***n","K***i"] → RELIGION HIGH
- "community" VARCHAR ["O***"] → RELIGION MEDIUM
- "fingerprint_data" BYTEA ["\\x..."] → BIOMETRIC HIGH
- "marital_status" VARCHAR ["Married","Single","Divorced"] → MARITAL HIGH
- "nationality" VARCHAR ["Indian","American"] → NATIONALITY HIGH
- "passport_no" VARCHAR ["A*******"] → AADHAAR HIGH (passport is govt ID)
- "pan_no" VARCHAR ["A***E1***F"] → PAN HIGH
- "status" VARCHAR ["active","inactive"] → null (status enum)
- "account_type" VARCHAR ["savings","current"] → null (type enum)
- "balance" NUMERIC ["*****0.50"] → null (financial metric, not PII)
- "is_verified" BOOLEAN ["true","false"] → null (boolean flag)
- "product_weight" NUMERIC ["***","***"] → null (product attribute)
- "error_count" INT ["3","7","0"] → null (metric counter)
- "department_id" INT ["1","2","3"] → null (foreign key to non-PII table)
- "currency" VARCHAR ["INR","USD"] → null (financial metadata)

Respond ONLY with a valid JSON array:
[{"name":"col","pii_category":"CATEGORY_OR_NULL","confidence":"HIGH|MEDIUM|LOW","reason":"one sentence"}]`;

  // Retry once on transient failure (network glitch, rate limit, malformed response)
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const model = client.getGenerativeModel({
        model:             'gemini-2.5-flash',
        systemInstruction: systemPrompt,
        generationConfig:  { temperature: 0, responseMimeType: 'application/json' },
      });

      const result = await model.generateContent(userPrompt);
      const raw    = result.response.text().trim();

      // Strip markdown fences if present
      const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      const start = clean.indexOf('[');
      const end   = clean.lastIndexOf(']');
      if (start === -1 || end === -1) throw new Error('No JSON array found in LLM response');

      const rows = JSON.parse(clean.slice(start, end + 1));

      for (const { col, key } of uncachedFields) {
        const row = rows.find(r => r.name === col.name);
        if (!row) continue;
        const value = {
          piiCategory: (row.pii_category === 'null' || row.pii_category === null)
            ? null
            : row.pii_category,
          confidence: row.confidence ?? 'MEDIUM',
          reason:     row.reason    ?? '',
        };
        _cache.set(key, value);
        resultMap.set(col.name, value);
      }

      const cacheHits = fields.length - uncachedFields.length;
      if (cacheHits > 0) {
        logger.info(`LLM cache: ${cacheHits} hit(s), ${uncachedFields.length} miss(es) for ${schemaName}.${tableName}`);
      }
      lastErr = null;
      break; // success
    } catch (err) {
      lastErr = err;
      if (attempt === 0) {
        logger.warn(`LLM attempt 1 failed — retrying in 1.5s`, { table: `${schemaName}.${tableName}`, message: err.message });
        await new Promise(r => setTimeout(r, 1500));
      }
    }
  }

  if (lastErr) {
    logger.warn('LLM classification failed after retry — using pattern-only results', {
      table:   `${schemaName}.${tableName}`,
      message: lastErr.message,
    });
  }

  return resultMap;
}

// ---------------------------------------------------------------------------
// Merge strategy — pattern classifier + LLM results
//
//  Pattern HIGH  → always kept; LLM adds confirmation note only
//  Pattern HIGH  + LLM disagrees → HIGH kept, LLM disagreement noted
//  Pattern MEDIUM + LLM agrees same category → upgraded to HIGH
//  Pattern MEDIUM + LLM says different category → reclassified, stays MEDIUM
//  Pattern MEDIUM + LLM says null → kept at MEDIUM (regex proof exists)
//  Pattern LOW   + LLM agrees → upgraded to MEDIUM
//  Pattern LOW   + LLM disagrees or null → dropped (both uncertain)
//  Pattern none  + LLM HIGH → added as MEDIUM (no regex proof, capped)
//  Pattern none  + LLM MEDIUM → added as LOW
//  Pattern none  + LLM LOW → not added (too uncertain)
//  Both null → no finding
// ---------------------------------------------------------------------------

function mergeResults(patternFindings, llmMap, fields) {
  const handled = new Set();
  const merged  = [];

  for (const f of patternFindings) {
    handled.add(f.fieldPath);
    const llm = llmMap.get(f.fieldPath);

    if (f.confidenceLevel === 'HIGH') {
      const note = llm?.piiCategory === f.piiCategory
        ? '; confirmed by LLM'
        : (llm?.piiCategory ? `; LLM suggested ${llm.piiCategory} (pattern HIGH retained)` : '');
      merged.push({ ...f, detectionReason: f.detectionReason + note });

    } else if (f.confidenceLevel === 'MEDIUM') {
      if (!llm || !llm.piiCategory) {
        merged.push(f);
      } else if (llm.piiCategory === f.piiCategory) {
        merged.push({
          ...f,
          confidenceLevel: 'HIGH',
          confidenceScore: 91,
          detectionReason: f.detectionReason + `; LLM confirmed: ${llm.reason}`,
        });
      } else {
        // LLM disagrees — reclassify to LLM's category, stay MEDIUM
        merged.push({
          ...f,
          piiCategory:     llm.piiCategory,
          detectionReason: `${f.detectionReason}; LLM reclassified to ${llm.piiCategory}: ${llm.reason}`,
        });
      }

    } else {
      // Pattern LOW
      if (llm?.piiCategory && llm.piiCategory === f.piiCategory) {
        merged.push({
          ...f,
          confidenceLevel: 'MEDIUM',
          confidenceScore: 57,
          detectionReason: f.detectionReason + `; LLM confirmed: ${llm.reason}`,
        });
      }
      // LOW + disagreement → drop
    }
  }

  // LLM-only detections: columns the pattern classifier missed
  for (const field of fields) {
    if (handled.has(field.name)) continue;
    const llm = llmMap.get(field.name);
    if (!llm?.piiCategory) continue;
    if (llm.confidence === 'LOW') continue; // LLM-only LOW is too uncertain

    const maskedSamples = field.samples
      .filter(v => v !== null && v !== undefined && String(v).trim() !== '')
      .slice(0, 3)
      .map(maskValue)
      .filter(Boolean);

    const isHigh = llm.confidence === 'HIGH';
    merged.push({
      fieldPath:          field.name,
      piiCategory:        llm.piiCategory,
      confidenceScore:    isHigh ? 76 : 46,
      confidenceLevel:    isHigh ? 'MEDIUM' : 'LOW',
      detectionReason:    `LLM detected (${llm.confidence}): ${llm.reason}`,
      sampleValuesMasked: maskedSamples,
    });
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

module.exports = { classifyTableWithLLM, mergeResults, isLLMEnabled: () => !!getClient() };
