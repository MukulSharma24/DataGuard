'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// PII Classifier
//
// Detection strategy:
//   1. Normalise the field name (lowercase, remove symbols, split camelCase)
//   2. Check the normalised tokens against known PII keyword dictionaries
//   3. Run regex patterns against sample values for value-level confirmation
//   4. Combine signals to produce a confidence score and level
//
// Confidence bands:
//   HIGH   85–100   name match AND value match
//   MEDIUM 50–70    name match only (no/failed value regex)
//   MEDIUM 40–60    value match only (name was not a match)
//   LOW    20–39    weak/partial name token match
// ─────────────────────────────────────────────────────────────────────────────

// ---------------------------------------------------------------------------
// 1. Regex patterns for value-level detection
// ---------------------------------------------------------------------------
const VALUE_PATTERNS = {
  EMAIL: /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/,

  // Indian mobile: optional +91/91/0 prefix, 6-9 leading digit, 9 more digits
  // International E.164: +[country_code][number]
  // US/Canada NANP: (555) 123-4567 | 555-123-4567 | 555.123.4567
  // UK mobile: 07xxx xxxxxx | +44 7xxx xxxxxx | 0044 7xxx xxxxxx
  PHONE: /^(\+91|91|0)?[6-9]\d{9}$|^\+[1-9]\d{6,14}$|^\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}$|^(\+44\s?|0044\s?)?07\d{3}[\s\-]?\d{6}$/,

  // PAN card: AAAAA9999A
  PAN: /^[A-Z]{5}[0-9]{4}[A-Z]$/,

  // Aadhaar: 12 digits, optionally space-separated in groups of 4
  AADHAAR: /^\d{4}[\s\-]?\d{4}[\s\-]?\d{4}$/,

  // ISO dates, DD/MM/YYYY, DD-MM-YYYY, YYYY/MM/DD
  DOB: /^(\d{4}-\d{2}-\d{2}|\d{2}[\/\-]\d{2}[\/\-]\d{4}|\d{4}[\/\-]\d{2}[\/\-]\d{2})$/,

  // Generic credit/debit card  (not stored — just flagged as BANK_ACCOUNT)
  CARD: /^\d{4}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}$/,

  // Indian IFSC code: 4 letters + 0 + 6 alphanumeric
  IFSC: /^[A-Z]{4}0[A-Z0-9]{6}$/,

  // IPv4 address
  IPV4: /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,

  // Person name: 2–4 words, each starting with a capital letter, letters/hyphens/apostrophes only
  // e.g. "Rahul Sharma", "Mary O'Brien", "Jean-Paul Dupont"
  NAME: /^[A-Z][a-zA-Z'\-]{1,30}(\s[A-Z][a-zA-Z'\-]{1,30}){1,3}$/,

  // Gender: exact common values (case-insensitive matched separately)
  GENDER: /^(male|female|m|f|other|o|transgender|non-binary|nb|prefer not to say)$/i,
};

// ---------------------------------------------------------------------------
// 2. Name-match dictionaries
//    Each entry is a list of normalised token sets.
//    A field name matches if any token set is a subset of the field's tokens.
// ---------------------------------------------------------------------------
const PII_KEYWORD_SETS = {
  NAME: [
    ['name'],
    ['nm'],
    ['firstname'],  ['fname'],
    ['lastname'],   ['lname'],
    ['fullname'],   ['full', 'nm'],  ['displayname'],
    ['middlename'], ['mname'],  ['mn'],
    ['givenname'],  ['surname'],
    ['salutation'], ['prefix'],
    ['fn'],         ['ln'],               // fn=first_name, ln=last_name
    ['contactname'], ['persname'], ['contactperson'],
  ],
  EMAIL: [
    ['email'],
    ['emailaddress'], ['emailid'],
    ['mail'],
    ['emailaddr'],
    ['workemail'], ['corpemail'],
  ],
  PHONE: [
    ['phone'],      ['phoneno'],   ['phonenumber'],
    ['mobile'],     ['mobileno'],  ['mobilenumber'],
    ['mob'],        ['mbl'],
    ['cell'],       ['cellno'],    ['cellphone'],
    ['tel'],        ['telephone'], ['telephonenumber'],
    ['phno'],       ['phn'],       ['pno'],       ['ph'],
    ['contactno'],  ['cno'],
    ['fax'],        ['faxno'],     ['faxnumber'],
    ['landline'],   ['landlineno'],
    ['whatsapp'],   ['wano'],
    ['contact'],    // weak — matched as LOW when alone
  ],
  ADDRESS: [
    ['address'],    ['addr'],      ['streetaddress'],
    ['street'],     ['streetno'],
    ['city'],       ['town'],
    ['state'],      ['province'],
    ['zip'],        ['zipcode'],   ['postalcode'], ['pincode'],
    ['country'],
    ['location'],   ['locality'],
    ['residence'],  ['resi'],
    ['doorno'],     ['flat'],      ['house'],
    ['district'],   ['tehsil'],    ['taluka'],
    ['landmark'],
    ['addr1'],      ['addr2'],     ['addr3'],
    ['haddr'],      ['raddr'],     ['paddr'],      ['waddr'],  // home/residential/permanent/work
    ['homeaddr'],   ['workaddr'],  ['permaddr'],   ['curraddr'],
    ['geo'],        ['coordinates'], ['latlong'],
    ['postcode'],   ['postcd'],    ['pcd'],
    ['area'],       ['sector'],    ['colony'],     ['nagar'],
    ['village'],    ['mandal'],    ['block'],
  ],
  DOB: [
    ['dob'],        ['dobdt'],     ['dobd'],
    ['dateofbirth'],['birthdate'], ['birthday'],
    ['bornon'],     ['birthdt'],   ['birthd'],
    ['birthyear'],  ['yearofbirth'], ['yob'],
    ['bd'],         ['bday'],
    ['age'],        // age strongly implies DOB-derived data
    ['dateofbirth'], ['dofbirth'],
  ],
  GENDER: [
    ['gender'],     ['sex'],
    ['gndr'],       ['gnd'],       ['gen'],
    ['sexuality'],
  ],
  AADHAAR: [
    ['aadhaar'],    ['aadhar'],    ['aadhaarno'],
    ['adhaar'],     ['adhaarno'],
    ['uidai'],
    ['passport'],   ['passportno'],  ['passportnum'],
    ['voterid'],    ['voteridno'],   ['electioncard'], ['epicno'],
    ['drivinglicense'], ['drivinglicence'], ['drivinglic'],
    ['dlno'],       ['dlnum'],
    ['nationalid'], ['govtid'],
  ],
  PAN: [
    ['pan'],        ['panno'],     ['pannumber'],
    ['pancard'],    ['incometaxid'], ['incometaxno'],
  ],
  BANK_ACCOUNT: [
    ['accountno'],  ['accountnumber'],
    ['bankaccount'],['bankaccno'],
    ['acno'],       ['accno'],     ['acctno'],    ['acct'],
    ['ifsc'],       ['ifsccode'],  ['ifsccd'],
    ['bankno'],     ['sortcode'],
    ['cardno'],     ['cardnumber'], ['creditcard'], ['debitcard'],
    ['upiid'],      ['vpaid'],     ['vpa'],
    ['neftno'],     ['rtgsno'],
    ['iban'],       ['swift'],     ['bic'],
    ['routingno'],  ['routingnumber'],
    ['bsbno'],                     // Australian BSB
    ['walletid'],   ['walletno'],
    ['acctnum'],    ['bankid'],
  ],
  USER_ID: [
    ['userid'],     ['uid'],
    ['loginid'],
    ['username'],   ['uname'],
    ['accountid'],
    ['memberid'],   ['customerno'], ['customerid'],  ['custid'],   ['custno'],
    ['empid'],      ['employeeid'],
    ['regid'],      ['registrationid'],
    ['sessionid'],  ['sessiontoken'],
    ['ipaddress'],  ['ipaddr'],     ['remoteip'],    ['clientip'],
    ['subscriberid'], ['subid'],    ['userno'],
    ['patientid'],  ['studentid'],  ['applicantid'],
    ['pid'],        ['personid'],
    ['handle'],     ['nickname'],   ['nick'],
    ['profileid'],  ['profileno'],
    ['deviceid'],   ['macaddr'],    ['macaddress'],
  ],
  CREDENTIAL: [
    ['password'],   ['passwd'],    ['pwd'],        ['pass'],
    ['secret'],
    ['apikey'],     ['authtoken'], ['accesstoken'],
    ['token'],      ['refreshtoken'],
    ['otp'],        ['otpcode'],   ['otpsecret'],
    ['pin'],        ['pincode'],   // pin/pincode in credential context
    ['passphrase'],
    ['hash'],       ['pwdhash'],   ['passhash'],
    ['privatekey'], ['privkey'],   ['sshkey'],     ['pgpkey'],
    ['jwt'],        ['bearertoken'],
    ['clientsecret'], ['appkey'],  ['servicekey'],
    ['cvv'],        ['cvc'],       ['cvv2'],       // card security codes
    ['encryptionkey'], ['enckey'],
  ],
  SALARY: [
    ['salary'],
    ['ctc'],
    ['income'],
    ['compensation'],
    ['payroll'],
    ['wage'],        ['wages'],
    ['stipend'],
    ['remuneration'],
    ['earnings'],
    ['gross', 'salary'], ['net', 'salary'],
    ['annualsalary'],    ['monthlysalary'],
    ['basepay'],         ['basesalary'],
  ],
  HEALTH: [
    ['bloodgroup'],  ['blood', 'group'],  ['blood', 'type'],
    ['diagnosis'],
    ['medical', 'record'],  ['medical', 'history'],
    ['disability'],
    ['prescription'],
    ['allergy'],     ['allergies'],
  ],
  MARITAL: [
    ['marital'],
    ['maritalstatus'],
    ['spouse'],
    ['matrimonial'],
  ],
  NATIONALITY: [
    ['nationality'],
    ['citizenship'],
    ['domicile'],
  ],
};

// Categories where a partial token match (not exact subset) is still meaningful
const WEAK_MATCH_CATEGORIES = new Set(['NAME', 'PHONE', 'ADDRESS', 'USER_ID']);

// Tokens that indicate a column is a counter/metric, not actual PII data.
// e.g. login_count, error_num, visit_total → these contain PII-like words but are NOT PII.
const COUNTER_TOKENS = new Set([
  'count', 'cnt', 'total', 'sum', 'avg', 'average', 'min', 'max',
  'num', 'score', 'rank', 'rating', 'points', 'index', 'idx',
  'seq', 'sequence', 'version', 'rev', 'revision', 'attempt', 'tries',
  'frequency', 'duration', 'interval', 'limit', 'quota',
]);

// Tokens that indicate a date column is a system/operational timestamp, NOT a personal DOB.
// Applies only when there is no name-based PII match (value-only DOB detection).
const NON_DOB_DATE_TOKENS = new Set([
  'created', 'updated', 'modified', 'timestamp', 'synced',
  'deleted', 'expires', 'expiry', 'scheduled', 'processed',
  'join', 'joined', 'hire', 'hired',
  'start', 'started', 'end', 'ended',
  'open', 'opened', 'close', 'closed',
  'issue', 'issued', 'effective', 'activated',
  'register', 'registered', 'signup', 'enrolled',
  'last', 'next', 'first',  // last_login, next_review, first_seen
  'seen',                   // first_seen, last_seen — event timestamps
  'at',                     // created_at, updated_at
]);

// Exact column names that are definitively non-PII regardless of content.
const NON_PII_EXACT_NAMES = new Set([
  'id', 'pk', 'seq', 'sequence', 'version', 'revision',
  'status', 'state',                             // state alone = OAuth/FSM state, not geographic
  'type', 'kind', 'class', 'category', 'flag', 'code',
  'active', 'enabled', 'visible', 'deleted', 'archived',
  'order', 'rank', 'priority', 'weight', 'sort',
  'amount', 'balance', 'price', 'cost', 'fee', 'total',
  'quantity', 'qty', 'count', 'size', 'length', 'width', 'height',
]);

// ---------------------------------------------------------------------------
// 3. Normalisation helpers
// ---------------------------------------------------------------------------

/**
 * Split camelCase / PascalCase into individual words.
 * e.g. "firstName" → ["first", "Name"]
 */
function splitCamelCase(str) {
  return str.replace(/([a-z])([A-Z])/g, '$1 $2').split(' ');
}

/**
 * Normalise a field name into a sorted list of lowercase tokens with all
 * symbols removed.  This is intentionally aggressive so that:
 *   first_name, FirstName, FIRST-NAME, firstName → ['first', 'name']
 */
function normaliseFieldName(name) {
  const tokens = [];
  for (const word of splitCamelCase(name)) {
    // Remove non-alphanumeric then split on remaining separators
    const cleaned = word.replace(/[^a-zA-Z0-9]/g, ' ').trim().toLowerCase();
    for (const part of cleaned.split(/\s+/)) {
      if (part) tokens.push(part);
    }
  }
  return tokens;
}

// Concatenated form used for fast substring checks (e.g. ["phone","no"] → "phoneno")
function tokensToJoined(tokens) { return tokens.join(''); }

// ---------------------------------------------------------------------------
// 4. Name-matching logic
// ---------------------------------------------------------------------------

/**
 * Returns the best-matching PII category for a given normalised token array,
 * along with whether the match was "strong" (all keywords present) or "weak"
 * (only some keywords present for permitted weak-match categories).
 */
function matchFieldName(tokens) {
  const joined = tokensToJoined(tokens);
  const tokenSet = new Set(tokens);

  // Exact non-PII column names: id, status, type, balance, etc.
  if (tokens.length === 1 && NON_PII_EXACT_NAMES.has(tokens[0])) return null;

  // Counter suppression: login_count, error_num, visit_total → NOT PII.
  // If the LAST token is a counter word, the column is a metric, not personal data.
  if (tokens.length >= 2 && COUNTER_TOKENS.has(tokens[tokens.length - 1])) return null;
  // Also suppress if ANY token is a counter when paired with USER_ID-like tokens.
  // e.g. login_count, login_attempt, session_count
  if ([...tokenSet].some(t => COUNTER_TOKENS.has(t)) &&
      (tokenSet.has('login') || tokenSet.has('session') || tokenSet.has('attempt'))) {
    return null;
  }

  // Boolean column suppression: is_active, has_email, can_login → NOT PII.
  const BOOL_PREFIXES = new Set(['is', 'has', 'can', 'should', 'was', 'did', 'will', 'allow']);
  if (tokens.length >= 2 && BOOL_PREFIXES.has(tokens[0])) return null;

  // age + range/limit modifier → operational metric, not personal DOB data.
  // e.g. age_group, age_limit, min_age, max_age, age_band, age_tier → NOT PII
  if (tokenSet.has('age') && tokens.length >= 2) {
    const AGE_METRIC_WORDS = new Set(['group', 'limit', 'min', 'max', 'range', 'band', 'tier', 'bracket', 'category']);
    if ([...tokenSet].some(t => AGE_METRIC_WORDS.has(t))) return null;
  }

  // Technical hash columns are integrity checksums, NOT credentials.
  // e.g. file_hash, content_hash, git_hash, commit_sha → NOT CREDENTIAL
  if (tokenSet.has('hash') && tokens.length >= 2) {
    const HASH_CONTEXT = new Set(['file', 'content', 'git', 'commit', 'sha', 'md5', 'crc', 'checksum']);
    if ([...tokenSet].some(t => HASH_CONTEXT.has(t))) return null;
  }

  // Specific overrides: catch fields whose names contain generic PII tokens but mean something
  // more specific. e.g. "ip_address" contains "address" but is a network identifier, not
  // a physical address; "username" contains "name" but is a login identifier, not a person's name.
  if (tokenSet.has('ip') && (tokenSet.has('address') || joined.includes('addr'))) {
    return { category: 'USER_ID', matchStrength: 'strong' };
  }
  if (joined === 'username' || joined === 'uname' || joined === 'loginname') {
    return { category: 'USER_ID', matchStrength: 'strong' };
  }

  // Entity-name exclusion: a 2-token field like "bank_name" or "company_name" stores an
  // organisation's name, not a person's name → not PII.
  // Only applies when the field is exactly 2 tokens (so "company_owner_name" still flags as NAME).
  const ENTITY_TOKENS = new Set([
    'bank', 'company', 'firm', 'org', 'organization', 'organisation',
    'product', 'item', 'shop', 'store', 'brand', 'category', 'role', 'group',
    'service', 'department', 'dept', 'plan', 'course', 'module', 'project', 'team',
  ]);
  if (tokens.length === 2 && tokenSet.has('name') &&
      [...tokenSet].some(t => ENTITY_TOKENS.has(t))) {
    return null;
  }

  for (const [category, keywordSets] of Object.entries(PII_KEYWORD_SETS)) {
    for (const kwSet of keywordSets) {
      // Strong match: all keywords in the set are present in the field tokens
      const allPresent = kwSet.every(kw => tokenSet.has(kw) || joined.includes(kw));
      if (allPresent) return { category, matchStrength: 'strong' };
    }
  }

  // Weak match: any single keyword appears as a substring
  for (const [category, keywordSets] of Object.entries(PII_KEYWORD_SETS)) {
    if (!WEAK_MATCH_CATEGORIES.has(category)) continue;
    for (const kwSet of keywordSets) {
      const anyPresent = kwSet.some(kw => joined.includes(kw));
      if (anyPresent) return { category, matchStrength: 'weak' };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// 5. Value-level matching
// ---------------------------------------------------------------------------

/**
 * Tests a sample value against value-level patterns.
 * Returns the matching category, or null.
 */
function matchValue(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  if (!str) return null;

  // Check high-specificity patterns first to avoid ambiguous matches
  const HIGH_SPECIFICITY_ORDER = ['EMAIL', 'PAN', 'AADHAAR', 'IFSC', 'CARD', 'PHONE', 'IPV4', 'DOB', 'NAME', 'GENDER'];

  for (const category of HIGH_SPECIFICITY_ORDER) {
    const pattern = VALUE_PATTERNS[category];
    if (!pattern) continue;
    try {
      if (pattern.test(str)) return category;
    } catch {
      // Malformed value — skip
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 6. Hash/encryption detection
// ---------------------------------------------------------------------------
const HASH_PATTERNS = [
  /^[a-f0-9]{32}$/i,   // MD5
  /^[a-f0-9]{40}$/i,   // SHA-1
  /^[a-f0-9]{64}$/i,   // SHA-256
  /^\$2[aby]\$\d+\$.+/, // bcrypt
  /^[A-Za-z0-9+/]{40,}={0,2}$/,  // base64 (rough)
];

function looksHashed(value) {
  if (!value) return false;
  const str = String(value).trim();
  return HASH_PATTERNS.some(p => p.test(str));
}

// ---------------------------------------------------------------------------
// 7. Address value heuristic
// ---------------------------------------------------------------------------

const ADDRESS_VALUE_KEYWORDS = new Set([
  'road', 'rd', 'street', 'st', 'avenue', 'ave', 'lane',
  'nagar', 'colony', 'sector', 'phase', 'block', 'plot',
  'flat', 'floor', 'building', 'complex', 'society',
  'village', 'district', 'tehsil', 'mandal', 'taluka',
]);

function looksLikeAddress(value) {
  const str = String(value).trim().toLowerCase();
  if (!/\d/.test(str)) return false;
  const words = str.split(/[\s,\-\/]+/);
  return words.some(w => ADDRESS_VALUE_KEYWORDS.has(w));
}

// ---------------------------------------------------------------------------
// 7b. Sample flattener — handles JSONB objects and PostgreSQL/MongoDB arrays
// ---------------------------------------------------------------------------

function flattenSampleValue(v) {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.flatMap(flattenSampleValue);
  if (typeof v === 'object' && !(v instanceof Date)) {
    return Object.values(v).flatMap(flattenSampleValue);
  }
  const str = v instanceof Date ? v.toISOString() : String(v);
  return str.trim() ? [str] : [];
}

// ---------------------------------------------------------------------------
// 8. Sample masking
// ---------------------------------------------------------------------------

/**
 * Produces a masked representation of a value.
 * e.g. "john@example.com" → "j***@example.com"
 */
function maskValue(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  if (!str) return '';

  // Email
  if (VALUE_PATTERNS.EMAIL.test(str)) {
    const [local, domain] = str.split('@');
    return `${local[0]}***@${domain}`;
  }

  // Phone — keep last 4 digits
  if (str.length >= 8) {
    return `${'*'.repeat(str.length - 4)}${str.slice(-4)}`;
  }

  // Short values — mask all but first character
  return `${str[0]}${'*'.repeat(str.length - 1)}`;
}

// ---------------------------------------------------------------------------
// 8. Confidence scoring
// ---------------------------------------------------------------------------

function computeConfidence(nameMatch, valueMatch) {
  if (nameMatch?.matchStrength === 'strong' && valueMatch) {
    return { score: 90, level: 'HIGH' };
  }
  if (nameMatch?.matchStrength === 'strong') {
    return { score: 60, level: 'MEDIUM' };
  }
  if (nameMatch?.matchStrength === 'weak' && valueMatch) {
    return { score: 55, level: 'MEDIUM' };
  }
  if (valueMatch) {
    return { score: 50, level: 'MEDIUM' };
  }
  if (nameMatch?.matchStrength === 'weak') {
    return { score: 25, level: 'LOW' };
  }
  return null; // no signal
}

function buildReason(fieldName, nameMatch, valueMatch, hashedFlag) {
  const parts = [];
  if (nameMatch?.matchStrength === 'strong') {
    parts.push(`Field name "${fieldName}" strongly matches ${nameMatch.category} pattern`);
  } else if (nameMatch?.matchStrength === 'weak') {
    parts.push(`Field name "${fieldName}" weakly matches ${nameMatch.category} pattern`);
  }
  if (valueMatch) {
    parts.push(`Sample values match ${valueMatch} regex pattern`);
  }
  if (hashedFlag) {
    parts.push('Values appear hashed/encrypted — name-based detection only');
  }
  return parts.join('; ');
}

// ---------------------------------------------------------------------------
// 9. Main public API
// ---------------------------------------------------------------------------

/**
 * Classify a single field and its sample values.
 *
 * @param {string}   fieldName   - Column name or dot-path (e.g. "user.contact.email")
 * @param {any[]}    sampleValues - Up to 100 non-null sample values
 * @returns {object|null}  Classification result or null if no PII detected
 */
function classifyField(fieldName, sampleValues = []) {
  // Use just the leaf segment for dot-path fields (MongoDB)
  const leafName = fieldName.includes('.') ? fieldName.split('.').pop() : fieldName;

  const tokens    = normaliseFieldName(leafName);
  const nameMatch = matchFieldName(tokens);

  // Flatten arrays/JSONB objects then take up to 15 non-null, non-empty values
  const nonNullSamples = sampleValues
    .flatMap(flattenSampleValue)
    .filter(v => v.trim() !== '')
    .slice(0, 15);

  let valueMatch = null;
  let hashedFlag = false;

  for (const sample of nonNullSamples) {
    const vm = matchValue(sample);
    // NAME and GENDER patterns require majority confirmation — skip single-sample fast path
    if (vm && vm !== 'NAME' && vm !== 'GENDER') { valueMatch = vm; break; }
    if (looksHashed(sample)) { hashedFlag = true; }
  }

  // Map IFSC and IPV4 value matches to their PII categories
  if (valueMatch === 'IFSC')  valueMatch = 'BANK_ACCOUNT';
  if (valueMatch === 'IPV4')  valueMatch = 'USER_ID';

  // Suppress DOB value-only detection when the field name indicates a non-personal date:
  // join_date, opened_date, last_login, created_at etc. contain dates that match the DOB
  // regex but are operational timestamps, not birth dates.
  if (valueMatch === 'DOB' && !nameMatch) {
    const leafTokenSet = new Set(normaliseFieldName(leafName));
    if ([...NON_DOB_DATE_TOKENS].some(t => leafTokenSet.has(t))) {
      valueMatch = null;
    }
  }

  // NAME: only flag via value if majority of samples look like person names
  if (!valueMatch && isMajorityNames(nonNullSamples)) valueMatch = 'NAME';

  // GENDER: flag if majority (≥60%) of non-null samples are recognised gender values
  if (!valueMatch && nonNullSamples.length > 0) {
    const genderHits = nonNullSamples.filter(v => VALUE_PATTERNS.GENDER.test(String(v).trim()));
    if (genderHits.length >= Math.ceil(nonNullSamples.length * 0.6)) {
      valueMatch = 'GENDER';
    }
  }

  // ADDRESS: value-level heuristic — digit + known address keyword (Road, Nagar, etc.)
  if (!valueMatch) {
    for (const sample of nonNullSamples) {
      if (looksLikeAddress(sample)) { valueMatch = 'ADDRESS'; break; }
    }
  }

  const category = nameMatch?.category ?? (valueMatch ? valueMatchToCategory(valueMatch) : null);
  if (!category) return null;

  const confidence = computeConfidence(nameMatch, valueMatch);
  if (!confidence) return null;

  const maskedSamples = nonNullSamples.slice(0, 3).map(maskValue);

  return {
    fieldPath:           fieldName,
    piiCategory:         category,
    confidenceScore:     confidence.score,
    confidenceLevel:     confidence.level,
    detectionReason:     buildReason(leafName, nameMatch, valueMatch, hashedFlag),
    sampleValuesMasked:  maskedSamples,
  };
}

// VALUE_PATTERNS keys don't all map 1:1 to PII_KEYWORD_SETS keys
function valueMatchToCategory(vmCategory) {
  const map = { CARD: 'BANK_ACCOUNT' };
  return map[vmCategory] ?? vmCategory;
}

function toTitleCase(str) {
  return str.replace(/\b\w+/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

// NAME value pattern — also normalises ALL-CAPS values (RAHUL SHARMA → Rahul Sharma)
// Uses 50% majority threshold to handle mixed columns.
function isMajorityNames(samples) {
  if (!samples.length) return false;
  const hits = samples.filter(v => {
    const s = String(v).trim();
    return VALUE_PATTERNS.NAME.test(s) || VALUE_PATTERNS.NAME.test(toTitleCase(s));
  });
  return hits.length >= Math.ceil(samples.length * 0.6);
}

/**
 * Classify all fields in a table/collection result set.
 *
 * @param {Array<{name: string, samples: any[]}>} fields
 * @returns {Array}  Array of classification results (nulls filtered out)
 */
function classifyFields(fields) {
  return fields
    .map(f => classifyField(f.name, f.samples))
    .filter(Boolean);
}

module.exports = { classifyField, classifyFields, normaliseFieldName, maskValue };
