'use strict';

const crypto = require('crypto');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { maskValue } = require('./piiClassifier');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// Per-column LLM cache — avoids re-classifying identical (name, type, samples)
// combos across repeated scans. Keyed by sha256 of column fingerprint.
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
];

// ---------------------------------------------------------------------------
// Single-table batch classification
// ---------------------------------------------------------------------------

/**
 * Ask the LLM to classify every column in one table in a single API call.
 *
 * @param {string} schemaName
 * @param {string} tableName
 * @param {Array<{name: string, dataType: string, samples: any[]}>} fields
 * @returns {Promise<Map<string, {piiCategory: string|null, confidence: string, reason: string}>>}
 */
async function classifyTableWithLLM(schemaName, tableName, fields) {
  const client = getClient();
  if (!client) return new Map();

  const resultMap = new Map();
  const uncachedFields = [];

  // Mask all sample values before they leave this environment.
  // The LLM receives structural patterns (e.g. "j***@example.com", "******9012")
  // rather than raw PII — enough signal to classify without data egress.
  const columnList = fields.map(f => ({
    name:    f.name,
    type:    f.dataType || 'unknown',
    samples: f.samples
      .filter(v => v !== null && v !== undefined && String(v).trim() !== '')
      .slice(0, 5)
      .map(v => maskValue(String(v).slice(0, 100))),
  }));

  // Serve cached columns immediately; queue only uncached ones for the LLM call
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

  const systemPrompt = `You are an expert database PII auditor specialising in Indian data regulations (DPDP Act, IT Act).
Your task: classify each database column as PII or not, based on its name, data type, and sample values.
You must return ONLY a valid JSON array — no markdown, no explanation, no code fences.
Be precise — false positives waste engineering time, false negatives are compliance violations.`;

  const userPrompt = `Table: ${schemaName}.${tableName}

Columns to classify (name | SQL type | sample values):
${JSON.stringify(uncachedColumnList, null, 2)}

Valid pii_category values: ${PII_CATEGORIES.join(', ')}, null
Use null when the column does NOT contain personal data.

Classification rules:
- NAME: stores a real person's full/first/last name. NOT company names, product names, or role names.
- EMAIL: email addresses. High confidence if samples contain "@".
- PHONE: phone/mobile numbers. Indian numbers start with 6-9 and are 10 digits.
- ADDRESS: physical addresses, street, city, state, pincode, landmark.
- DOB: date of birth specifically. NOT created_at, updated_at, joined_date, or event timestamps.
- GENDER: biological sex or gender identity values (Male/Female/M/F/Other/Transgender).
- AADHAAR: Aadhaar (12-digit), passport, voter ID (EPIC), driving licence numbers.
- PAN: PAN card (format: AAAAA9999A), income tax IDs.
- BANK_ACCOUNT: bank account numbers, IFSC codes, UPI IDs, card numbers.
- USER_ID: login names, session tokens, IP addresses, customer IDs, employee IDs, internal system IDs.
- CREDENTIAL: passwords, API keys, tokens, OTPs, PINs, hashes, secrets.
- null: status enums, type flags, counters, metrics, timestamps, boolean flags, foreign keys to non-PII tables.

IMPORTANT: All sample values are pre-masked (PII is hidden). You will see patterns like
"j***@example.com" or "******9012" — classify based on the visible structure + column name + type.

Few-shot examples of correct classifications (samples shown in masked form):
- "cust_nm" VARCHAR ["R***l S****a","P***a P***l"] → NAME HIGH
- "ph" BIGINT ["******3210","******6789"] → PHONE HIGH
- "dob" DATE ["1***-**-21","1***-**-03"] → DOB HIGH
- "gender" VARCHAR ["M","F","Other"] → GENDER HIGH (short enum values are not masked)
- "created_at" TIMESTAMP ["2***-**-** **:30:00"] → null (system timestamp)
- "status" VARCHAR ["active","inactive","pending"] → null (status enum)
- "account_type" VARCHAR ["savings","current"] → null (type enum, not PII)
- "balance" NUMERIC ["*****0.50","****0.00"] → null (financial metric)
- "is_verified" BOOLEAN ["true","false"] → null (flag)
- "uid" UUID ["a***-..."] → USER_ID MEDIUM (internal system ID)
- "ip_addr" VARCHAR ["1**.1**.*.1"] → USER_ID HIGH
- "pwd_hash" VARCHAR ["$***$10$..."] → CREDENTIAL HIGH
- "pincode" VARCHAR ["**0001","**0001"] → ADDRESS HIGH (postal codes are address PII)
- "ifsc" VARCHAR ["H***0001234"] → BANK_ACCOUNT HIGH

Respond ONLY with a valid JSON array, one object per column in the SAME ORDER as input:
[{"name":"col","pii_category":"CATEGORY_OR_NULL","confidence":"HIGH|MEDIUM|LOW","reason":"one sentence max"}]`;

  try {
    const model = client.getGenerativeModel({
      model:             'gemini-2.5-flash',
      systemInstruction: systemPrompt,
      generationConfig:  { temperature: 0 },
    });

    const result = await model.generateContent(userPrompt);
    const raw    = result.response.text().trim();

    // Strip markdown code fences if Gemini wraps the JSON
    const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    const start = clean.indexOf('[');
    const end   = clean.lastIndexOf(']');
    if (start === -1 || end === -1) throw new Error('No JSON array in LLM response');

    const rows = JSON.parse(clean.slice(start, end + 1));

    for (const { col, key } of uncachedFields) {
      const row = rows.find(r => r.name === col.name);
      if (!row) continue;
      const value = {
        piiCategory: (row.pii_category === 'null' || row.pii_category === null)
          ? null
          : row.pii_category,
        confidence: row.confidence ?? 'MEDIUM',
        reason:     row.reason ?? '',
      };
      _cache.set(key, value);
      resultMap.set(col.name, value);
    }

    const cacheHits = fields.length - uncachedFields.length;
    if (cacheHits > 0) {
      logger.info(`LLM cache: ${cacheHits} hit(s), ${uncachedFields.length} miss(es) for ${schemaName}.${tableName}`);
    }
    return resultMap;
  } catch (err) {
    logger.warn('LLM classification failed — falling back to pattern only', {
      table:   `${schemaName}.${tableName}`,
      message: err.message,
    });
    return resultMap; // return cached results even if fresh LLM call failed
  }
}

// ---------------------------------------------------------------------------
// Merge strategy
// ---------------------------------------------------------------------------

const CONFIDENCE_SCORE = { HIGH: 90, MEDIUM: 60, LOW: 30 };

/**
 * Merge pattern-classifier findings with LLM results for one table.
 *
 * Rules:
 *  - Pattern HIGH  → always kept; LLM can only add a confirmation note
 *  - Pattern MEDIUM + LLM agrees same category → upgrade to HIGH
 *  - Pattern MEDIUM + LLM says different category → reclassify, keep MEDIUM
 *  - Pattern MEDIUM + LLM says null → keep at MEDIUM (pattern has regex proof)
 *  - Pattern LOW   + LLM agrees → upgrade to MEDIUM
 *  - Pattern LOW   + LLM disagrees or null → drop (both uncertain)
 *  - Pattern null  + LLM HIGH → add as MEDIUM (strong LLM signal, no regex proof)
 *  - Pattern null  + LLM MEDIUM/LOW → add as LOW
 *  - Both null     → no finding
 */
function mergeResults(patternFindings, llmMap, fields) {
  const handled = new Set();
  const merged  = [];

  for (const f of patternFindings) {
    handled.add(f.fieldPath);
    const llm = llmMap.get(f.fieldPath);

    if (f.confidenceLevel === 'HIGH') {
      const note = llm?.piiCategory === f.piiCategory ? '; confirmed by LLM' : '';
      merged.push({ ...f, detectionReason: f.detectionReason + note });

    } else if (f.confidenceLevel === 'MEDIUM') {
      if (!llm || !llm.piiCategory) {
        merged.push(f);
      } else if (llm.piiCategory === f.piiCategory) {
        merged.push({
          ...f,
          confidenceLevel: 'HIGH',
          confidenceScore: 90,
          detectionReason: f.detectionReason + `; LLM confirmed: ${llm.reason}`,
        });
      } else {
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
          confidenceScore: 55,
          detectionReason: f.detectionReason + `; LLM confirmed: ${llm.reason}`,
        });
      }
      // LOW + no LLM agreement → drop
    }
  }

  // LLM-only detections (columns the pattern classifier missed entirely)
  for (const field of fields) {
    if (handled.has(field.name)) continue;
    const llm = llmMap.get(field.name);
    if (!llm?.piiCategory) continue;

    const maskedSamples = field.samples
      .filter(v => v !== null && v !== undefined && String(v).trim() !== '')
      .slice(0, 3)
      .map(maskValue)
      .filter(Boolean);

    // LLM HIGH → MEDIUM (75 score), LLM MEDIUM/LOW → LOW (45 score)
    // We never give LLM-only a HIGH because there's no regex proof
    const isHighConfidence = llm.confidence === 'HIGH';
    merged.push({
      fieldPath:          field.name,
      piiCategory:        llm.piiCategory,
      confidenceScore:    isHighConfidence ? 75 : 45,
      confidenceLevel:    isHighConfidence ? 'MEDIUM' : 'LOW',
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
