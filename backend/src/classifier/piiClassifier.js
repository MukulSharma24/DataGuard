'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// PII Classifier — Pattern Engine
//
// Detection strategy:
//   1. Normalise the field name (lowercase, remove symbols, split camelCase)
//   2. Check the normalised tokens against known PII keyword dictionaries
//   3. Run regex patterns against sample values for value-level confirmation
//   4. Combine signals to produce a confidence score and level
//
// Confidence bands:
//   HIGH   85–100   strong name match AND value match
//   MEDIUM 50–84    strong name only | weak name + value | value only (high-specificity)
//   LOW    20–39    weak name only
// ─────────────────────────────────────────────────────────────────────────────

// ---------------------------------------------------------------------------
// 1. Value-level regex patterns
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

  // Aadhaar: 12 digits, optionally space/hyphen-separated in groups of 4
  AADHAAR: /^\d{4}[\s\-]?\d{4}[\s\-]?\d{4}$/,

  // Indian Passport: 1 uppercase letter + 7 digits  (e.g. A1234567)
  PASSPORT: /^[A-Z][0-9]{7}$/,

  // ISO dates, DD/MM/YYYY, DD-MM-YYYY, YYYY/MM/DD
  // Also: DD-Mon-YYYY (15-Jan-1990), DD Month YYYY (15 January 1990)
  DOB: /^(\d{4}-\d{2}-\d{2}|\d{2}[\/\-]\d{2}[\/\-]\d{4}|\d{4}[\/\-]\d{2}[\/\-]\d{2}|\d{2}[\-\s](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[\-\s]\d{4}|\d{2}\s(January|February|March|April|May|June|July|August|September|October|November|December)\s\d{4})$/i,

  // Generic credit/debit card — 16 digits (flagged as BANK_ACCOUNT)
  CARD: /^\d{4}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}$/,

  // Indian IFSC code: 4 uppercase letters + 0 + 6 alphanumeric
  IFSC: /^[A-Z]{4}0[A-Z0-9]{6}$/,

  // MAC address: 6 groups of 2 hex digits separated by : or -
  MAC: /^([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}$/,

  // UUID v1-v5: 8-4-4-4-12 hex groups
  UUID: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,

  // IPv4 address
  IPV4: /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,

  // Indian Pincode: exactly 6 digits, first digit 1-9
  PINCODE: /^[1-9][0-9]{5}$/,

  // US ZIP code: 5 digits or ZIP+4
  ZIP: /^\d{5}(-\d{4})?$/,

  // Person name: 2–4 words, each starting with a capital letter
  // Allows hyphens and apostrophes: "Mary O'Brien", "Jean-Paul Dupont"
  NAME: /^[A-Z][a-zA-Z'\-]{1,30}(\s[A-Z][a-zA-Z'\-]{1,30}){1,3}$/,

  // Gender: exact common values (case-insensitive)
  GENDER: /^(male|female|m|f|other|o|transgender|non-binary|nb|prefer not to say|agender|gender fluid)$/i,

  // Religion: common religion/faith values
  RELIGION: /^(hindu|hinduism|muslim|islam|christian|christianity|sikh|sikhism|buddhist|buddhism|jain|jainism|jewish|judaism|parsi|zoroastrianism|atheist|agnostic|other|none)$/i,
};

// ---------------------------------------------------------------------------
// 2. PII keyword dictionaries
//    Each entry is a list of normalised token sets.
//    A field name matches if any token set is a subset of the field's tokens.
// ---------------------------------------------------------------------------
const PII_KEYWORD_SETS = {
  NAME: [
    ['name'],
    ['nm'],
    ['firstname'],      ['fname'],
    ['lastname'],       ['lname'],
    ['fullname'],       ['full', 'nm'],     ['displayname'],
    ['middlename'],     ['mname'],          ['mn'],
    ['givenname'],      ['surname'],
    ['salutation'],     ['prefix'],
    ['fn'],             ['ln'],
    ['contactname'],    ['persname'],       ['contactperson'],
    ['fathername'],     ['fathersnm'],      ['fathernm'],     ['fatherof'],
    ['mothername'],     ['mothersnm'],      ['mothernm'],
    ['spousename'],     ['husbandname'],    ['wifename'],
    ['nomineename'],    ['nominee'],
    ['guardianname'],   ['guardian'],
    ['beneficiaryname'], ['beneficiary'],
    ['altname'],        ['alternatename'],  ['aliases'],
    ['applicantname'],  ['candidatename'],
    ['personname'],     ['individualname'],
    ['patientname'],    ['membername'],     ['holdername'],
    ['authorisedname'], ['authorizedname'],
  ],

  EMAIL: [
    ['email'],
    ['emailaddress'],   ['emailid'],
    ['mail'],
    ['emailaddr'],
    ['workemail'],      ['corpemail'],
    ['personalemail'],  ['officialemail'],
    ['alternateemail'], ['altemail'],       ['altemailid'],
    ['recoveryemail'],  ['backemail'],
    ['secondaryemail'],
    ['emailwork'],      ['emailpersonal'],
    ['mailid'],         ['mailaddress'],
  ],

  PHONE: [
    ['phone'],          ['phoneno'],        ['phonenumber'],
    ['mobile'],         ['mobileno'],       ['mobilenumber'],
    ['mob'],            ['mbl'],
    ['cell'],           ['cellno'],         ['cellphone'],
    ['tel'],            ['telephone'],      ['telephonenumber'],
    ['phno'],           ['phn'],            ['pno'],          ['ph'],
    ['contactno'],      ['cno'],
    ['fax'],            ['faxno'],          ['faxnumber'],
    ['landline'],       ['landlineno'],
    ['whatsapp'],       ['wano'],
    ['contact'],
    ['emergencycontact'], ['emergencyno'],  ['emergencyphno'],
    ['alternateno'],    ['altno'],          ['altphone'],      ['altmobile'],
    ['contactnumber'],  ['contactnum'],
    ['secondaryphone'], ['secondarymobile'],
    ['homeno'],         ['officeno'],       ['workmobile'],
    ['rphone'],         ['hphone'],
    ['primaryphone'],   ['primarymobile'],
  ],

  ADDRESS: [
    ['address'],        ['addr'],           ['streetaddress'],
    ['street'],         ['streetno'],
    ['city'],           ['town'],
    ['state'],          ['province'],
    ['zip'],            ['zipcode'],        ['postalcode'],   ['pincode'],
    ['country'],
    ['location'],       ['locality'],
    ['residence'],      ['resi'],
    ['doorno'],         ['flat'],           ['house'],
    ['district'],       ['tehsil'],         ['taluka'],
    ['landmark'],
    ['addr1'],          ['addr2'],          ['addr3'],
    ['haddr'],          ['raddr'],          ['paddr'],        ['waddr'],
    ['homeaddr'],       ['workaddr'],       ['permaddr'],     ['curraddr'],
    ['geo'],            ['coordinates'],    ['latlong'],
    ['postcode'],       ['postcd'],         ['pcd'],
    ['area'],           ['sector'],         ['colony'],       ['nagar'],
    ['village'],        ['mandal'],         ['block'],
    ['billingaddress'], ['billingaddr'],    ['billaddr'],
    ['shippingaddress'], ['shippingaddr'],  ['shipaddr'],
    ['deliveryaddress'], ['deliveryaddr'],
    ['permanentaddress'], ['permaaddr'],    ['permanentaddr'],
    ['currentaddress'], ['corraddr'],       ['correspondenceaddress'],
    ['officeaddress'],  ['officialaddress'],
    ['registeredaddress'], ['regaddr'],
    ['line1'],          ['line2'],          ['addressline1'], ['addressline2'],
    ['addrline1'],      ['addrline2'],
    ['latitude'],       ['longitude'],      ['lat'],          ['lng'],      ['lon'],
    ['geolocation'],    ['geopoint'],
  ],

  DOB: [
    ['dob'],            ['dobdt'],          ['dobd'],
    ['dateofbirth'],    ['birthdate'],      ['birthday'],
    ['bornon'],         ['birthdt'],        ['birthd'],
    ['birthyear'],      ['yearofbirth'],    ['yob'],
    ['bd'],             ['bday'],
    ['age'],
    ['dofbirth'],
    ['dateofbirth'],    ['birthmonth'],     ['birthyear'],
  ],

  GENDER: [
    ['gender'],         ['sex'],
    ['gndr'],           ['gnd'],            ['gen'],
    ['sexuality'],
    ['biologicalsex'],
  ],

  AADHAAR: [
    ['aadhaar'],        ['aadhar'],         ['aadhaarno'],
    ['adhaar'],         ['adhaarno'],
    ['uidai'],
    ['passport'],       ['passportno'],     ['passportnum'],
    ['voterid'],        ['voteridno'],      ['electioncard'],  ['epicno'],
    ['drivinglicense'], ['drivinglicence'], ['drivinglic'],
    ['dlno'],           ['dlnum'],
    ['nationalid'],     ['govtid'],
    ['ssn'],            ['socialsecurity'], // US Social Security Number
    ['sin'],            // Canadian SIN
    ['nid'],            ['nric'],           // national identity card (various countries)
    ['taxid'],          ['tin'],            // tax identification
  ],

  PAN: [
    ['pan'],            ['panno'],          ['pannumber'],
    ['pancard'],        ['incometaxid'],    ['incometaxno'],
    ['gstin'],          ['gstno'],          // GST number (business PII)
    ['tan'],            ['tanno'],          // Tax Deduction Account Number
  ],

  BANK_ACCOUNT: [
    ['accountno'],      ['accountnumber'],
    ['bankaccount'],    ['bankaccno'],
    ['acno'],           ['accno'],          ['acctno'],        ['acct'],
    ['ifsc'],           ['ifsccode'],       ['ifsccd'],
    ['bankno'],         ['sortcode'],
    ['cardno'],         ['cardnumber'],     ['creditcard'],    ['debitcard'],
    ['upiid'],          ['vpaid'],          ['vpa'],
    ['neftno'],         ['rtgsno'],
    ['iban'],           ['swift'],          ['bic'],
    ['routingno'],      ['routingnumber'],
    ['bsbno'],
    ['walletid'],       ['walletno'],
    ['acctnum'],        ['bankid'],
    ['mmid'],           // mobile money id
    ['payeeid'],        ['paymentid'],
    ['achno'],          // ACH routing
    ['micr'],           // MICR code on cheques
  ],

  USER_ID: [
    ['userid'],         ['uid'],
    ['loginid'],
    ['username'],       ['uname'],
    ['accountid'],
    ['memberid'],       ['customerno'],     ['customerid'],    ['custid'],   ['custno'],
    ['empid'],          ['employeeid'],
    ['regid'],          ['registrationid'],
    ['sessionid'],      ['sessiontoken'],
    ['ipaddress'],      ['ipaddr'],         ['remoteip'],      ['clientip'],
    ['subscriberid'],   ['subid'],          ['userno'],
    ['patientid'],      ['studentid'],      ['applicantid'],
    ['pid'],            ['personid'],
    ['handle'],         ['nickname'],       ['nick'],
    ['profileid'],      ['profileno'],
    ['deviceid'],       ['macaddr'],        ['macaddress'],
    ['referralcode'],   ['referral'],
    ['trackingid'],     ['trackerid'],
    ['transactionid'],  ['txnid'],          ['txid'],
    ['orderid'],        ['ordernum'],       ['orderno'],
    ['ticketid'],       ['caseid'],
    ['reservationid'],  ['bookingid'],
    ['agentid'],        ['brokerid'],
    ['vendorid'],       ['supplierid'],     ['merchantid'],
    ['fingerid'],       ['faceid'],         // biometric enrollment ID (not raw data)
  ],

  CREDENTIAL: [
    ['password'],       ['passwd'],         ['pwd'],           ['pass'],
    ['secret'],
    ['apikey'],         ['authtoken'],      ['accesstoken'],
    ['token'],          ['refreshtoken'],
    ['otp'],            ['otpcode'],        ['otpsecret'],
    ['pin'],            ['pincode'],
    ['mpin'],           ['tpin'],           ['ipin'],
    ['passphrase'],
    ['hash'],           ['pwdhash'],        ['passhash'],
    ['privatekey'],     ['privkey'],        ['sshkey'],        ['pgpkey'],
    ['jwt'],            ['bearertoken'],
    ['clientsecret'],   ['appkey'],         ['servicekey'],
    ['cvv'],            ['cvc'],            ['cvv2'],
    ['encryptionkey'],  ['enckey'],
    ['securityanswer'], ['secretanswer'],
    ['securityquestion'],
    ['backupcode'],     ['recoverycode'],
    ['totp'],           ['hotp'],
    ['signature'],      ['digitalsignature'],
    ['challenge'],
  ],

  SALARY: [
    ['salary'],
    ['ctc'],
    ['income'],
    ['compensation'],
    ['payroll'],
    ['wage'],           ['wages'],
    ['stipend'],
    ['remuneration'],
    ['earnings'],
    ['gross', 'salary'], ['net', 'salary'],
    ['annualsalary'],   ['monthlysalary'],
    ['basepay'],        ['basesalary'],
    ['bonus'],          ['hike'],           ['increment'],
    ['allowance'],      ['hra'],            ['da'],
    ['pf'],             ['gratuity'],       ['esic'],
    ['takehome'],       ['netpay'],         ['grosspay'],
    ['variablepay'],    ['fixedpay'],       ['incentive'],
    ['lpa'],
    ['package'],        ['annualpackage'],  ['totalpackage'],
    ['offerletter', 'amount'],
  ],

  HEALTH: [
    ['bloodgroup'],     ['blood', 'group'], ['blood', 'type'], ['bloodtype'],
    ['diagnosis'],
    ['medical', 'record'], ['medical', 'history'], ['medicalrecord'],
    ['disability'],
    ['prescription'],
    ['allergy'],        ['allergies'],
    ['height'],         ['weight'],         ['bmi'],
    ['condition'],      ['disease'],        ['disorder'],
    ['ailment'],        ['treatment'],      ['medication'],
    ['medicine'],       ['drug'],           ['chronic'],
    ['labresult'],      ['testresult'],     ['reportresult'],
    ['medicalcondition'], ['healthcondition'],
    ['mentalhealth'],
    ['hiv'],            ['diabetes'],       ['cancer'],
    ['hemoglobin'],     ['cholesterol'],    ['bp'],            ['bloodpressure'],
    ['sugar'],          ['glucoselevel'],
    ['handicap'],       ['specialneeds'],
  ],

  MARITAL: [
    ['marital'],
    ['maritalstatus'],
    ['spouse'],
    ['matrimonial'],
    ['married'],        ['unmarried'],      ['divorced'],
    ['widowed'],        ['single'],         ['separated'],
    ['relationshipstatus'],
    ['civilstatus'],
  ],

  NATIONALITY: [
    ['nationality'],
    ['citizenship'],
    ['domicile'],
    ['national'],       ['origin'],         ['countryoforigin'],
    ['ethnicity'],      ['race'],
    ['pr'],
    ['resident'],       ['residency'],
    ['migrant'],        ['immigrant'],
  ],

  // Sensitive under DPDP Act 2023, GDPR Article 9 — religion/caste/faith
  RELIGION: [
    ['religion'],       ['faith'],
    ['caste'],          ['subcaste'],
    ['community'],      ['sect'],
    ['denomination'],
    ['gotra'],          // Hindu clan/lineage
    ['jati'],           // caste sub-group
  ],

  // Raw biometric template data — never store without explicit consent
  BIOMETRIC: [
    ['fingerprint'],    ['fingerprintdata'], ['fingerprinttemplate'],
    ['biometric'],      ['biometricdata'],   ['biometrictemplate'],
    ['faceencoding'],   ['facedata'],        ['facetemplate'],     ['facevector'],
    ['retina'],         ['irisdata'],        ['iristemplate'],
    ['voiceprint'],     ['voiceid'],         ['voicetemplate'],
    ['dna'],            ['dnasequence'],
    ['handgeometry'],
    ['vein'],           ['veinpattern'],
  ],
};

// Categories where a partial token match (not exact subset) is still meaningful
const WEAK_MATCH_CATEGORIES = new Set(['NAME', 'PHONE', 'ADDRESS', 'USER_ID', 'HEALTH', 'SALARY', 'RELIGION']);

// Tokens that indicate a column is a counter/metric, not personal data.
const COUNTER_TOKENS = new Set([
  'count', 'cnt', 'total', 'sum', 'avg', 'average', 'min', 'max',
  'num', 'score', 'rank', 'rating', 'points', 'index', 'idx',
  'seq', 'sequence', 'version', 'rev', 'revision', 'attempt', 'tries',
  'frequency', 'duration', 'interval', 'limit', 'quota',
  'percent', 'pct', 'ratio', 'factor', 'multiplier',
]);

// Tokens indicating a date column is an operational timestamp, NOT a birth date.
// Applied only on value-only DOB detection (no name match).
const NON_DOB_DATE_TOKENS = new Set([
  'created', 'updated', 'modified', 'timestamp', 'synced',
  'deleted', 'expires', 'expiry', 'scheduled', 'processed',
  'join', 'joined', 'hire', 'hired',
  'start', 'started', 'end', 'ended',
  'open', 'opened', 'close', 'closed',
  'issue', 'issued', 'effective', 'activated',
  'register', 'registered', 'signup', 'enrolled',
  'last', 'next', 'first',
  'seen', 'at', 'on',
  'purchase', 'transaction', 'payment', 'delivery', 'dispatch',
  'submission', 'approval', 'rejection', 'cancellation',
]);

// Exact single-token column names that are definitively non-PII.
const NON_PII_EXACT_NAMES = new Set([
  'id', 'pk', 'seq', 'sequence', 'version', 'revision',
  'status', 'state',
  'type', 'kind', 'class', 'category', 'flag', 'code',
  'active', 'enabled', 'visible', 'deleted', 'archived',
  'order', 'rank', 'priority', 'weight', 'sort',
  'amount', 'balance', 'price', 'cost', 'fee', 'total',
  'quantity', 'qty', 'count', 'size', 'length', 'width', 'height',
  'currency', 'symbol', 'locale', 'timezone',
  'ref', 'reference', 'tag', 'label', 'key', 'value',
  'mode', 'channel', 'source', 'medium', 'campaign',
]);

// ---------------------------------------------------------------------------
// 3. Normalisation helpers
// ---------------------------------------------------------------------------

function splitCamelCase(str) {
  // Split on lowercase→uppercase AND uppercase→uppercase+lowercase transitions
  // e.g. "XMLParser" → "XML Parser", "firstName2" → "first Name 2"
  return str
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .split(' ');
}

function normaliseFieldName(name) {
  const tokens = [];
  for (const word of splitCamelCase(name)) {
    const cleaned = word.replace(/[^a-zA-Z0-9]/g, ' ').trim().toLowerCase();
    for (const part of cleaned.split(/\s+/)) {
      if (part) tokens.push(part);
    }
  }
  return tokens;
}

function tokensToJoined(tokens) { return tokens.join(''); }

// ---------------------------------------------------------------------------
// 4. Name-matching logic
// ---------------------------------------------------------------------------

function matchFieldName(tokens) {
  const joined   = tokensToJoined(tokens);
  const tokenSet = new Set(tokens);

  // Single-token exact non-PII names
  if (tokens.length === 1 && NON_PII_EXACT_NAMES.has(tokens[0])) return null;

  // Counter suppression: login_count, error_num, visit_total → NOT PII
  if (tokens.length >= 2 && COUNTER_TOKENS.has(tokens[tokens.length - 1])) return null;
  if ([...tokenSet].some(t => COUNTER_TOKENS.has(t)) &&
      (tokenSet.has('login') || tokenSet.has('session') || tokenSet.has('attempt'))) {
    return null;
  }

  // Boolean column suppression: is_active, has_email, can_login → NOT PII
  const BOOL_PREFIXES = new Set(['is', 'has', 'can', 'should', 'was', 'did', 'will', 'allow']);
  if (tokens.length >= 2 && BOOL_PREFIXES.has(tokens[0])) return null;

  // Age metric suppression: age_group, age_limit, min_age → NOT personal DOB
  if (tokenSet.has('age') && tokens.length >= 2) {
    const AGE_METRICS = new Set(['group', 'limit', 'min', 'max', 'range', 'band', 'tier', 'bracket', 'category']);
    if ([...tokenSet].some(t => AGE_METRICS.has(t))) return null;
  }

  // Technical hash suppression: file_hash, content_hash, commit_sha → NOT CREDENTIAL
  if (tokenSet.has('hash') && tokens.length >= 2) {
    const HASH_CTX = new Set(['file', 'content', 'git', 'commit', 'sha', 'md5', 'crc', 'checksum']);
    if ([...tokenSet].some(t => HASH_CTX.has(t))) return null;
  }

  // Financial metadata suppression: currency_code, payment_mode → NOT PII
  if (tokenSet.has('currency') || tokenSet.has('symbol')) return null;
  if (tokenSet.has('mode') && (tokenSet.has('payment') || tokenSet.has('channel'))) return null;

  // Operational metric suppression: error_code, status_code → NOT PII
  if (tokenSet.has('code') && (tokenSet.has('error') || tokenSet.has('status') || tokenSet.has('response'))) return null;

  // IP address override: ip_address contains "address" but is a network identifier
  if (tokenSet.has('ip') && (tokenSet.has('address') || joined.includes('addr'))) {
    return { category: 'USER_ID', matchStrength: 'strong' };
  }

  // Username override: contains "name" but is a login identifier
  if (joined === 'username' || joined === 'uname' || joined === 'loginname') {
    return { category: 'USER_ID', matchStrength: 'strong' };
  }

  // Weight/height suppression when context is products/packages (NOT health)
  // product_weight, package_weight, item_weight → NOT HEALTH
  const PHYSICAL_PRODUCT_CTX = new Set(['product', 'item', 'package', 'parcel', 'shipment', 'cargo']);
  if ((tokenSet.has('weight') || tokenSet.has('height') || tokenSet.has('length') || tokenSet.has('width')) &&
      [...tokenSet].some(t => PHYSICAL_PRODUCT_CTX.has(t))) {
    return null;
  }

  // Entity-name exclusion: bank_name, company_name → NOT a person's name
  const ENTITY_TOKENS = new Set([
    'bank', 'company', 'firm', 'org', 'organization', 'organisation',
    'product', 'item', 'shop', 'store', 'brand', 'category', 'role', 'group',
    'service', 'department', 'dept', 'plan', 'course', 'module', 'project', 'team',
    'scheme', 'fund', 'portfolio', 'account', 'branch',
  ]);
  if (tokens.length === 2 && tokenSet.has('name') &&
      [...tokenSet].some(t => ENTITY_TOKENS.has(t))) {
    return null;
  }

  // Strong match: all keywords in the set are present
  for (const [category, keywordSets] of Object.entries(PII_KEYWORD_SETS)) {
    for (const kwSet of keywordSets) {
      const allPresent = kwSet.every(kw => tokenSet.has(kw) || joined.includes(kw));
      if (allPresent) return { category, matchStrength: 'strong' };
    }
  }

  // Weak match: any keyword appears as a substring (for permitted categories only)
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

// Tested in specificity order — most unambiguous first to avoid misclassification
const HIGH_SPECIFICITY_ORDER = [
  'EMAIL', 'PAN', 'AADHAAR', 'PASSPORT', 'IFSC', 'MAC', 'UUID',
  'CARD', 'PHONE', 'IPV4', 'PINCODE', 'ZIP', 'DOB', 'NAME', 'GENDER', 'RELIGION',
];

function matchValue(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  if (!str) return null;

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
// 6. Hash / encryption detection
// ---------------------------------------------------------------------------
const HASH_PATTERNS = [
  /^[a-f0-9]{32}$/i,             // MD5
  /^[a-f0-9]{40}$/i,             // SHA-1
  /^[a-f0-9]{64}$/i,             // SHA-256
  /^[a-f0-9]{128}$/i,            // SHA-512
  /^\$2[aby]\$\d+\$.{53}$/,      // bcrypt (exact length)
  /^\$argon2(id?|i)\$/,          // Argon2
  /^pbkdf2:[a-z0-9:]+\$.+/i,    // PBKDF2 (Flask/Werkzeug format)
  /^[A-Za-z0-9+/]{43,}={0,2}$/, // base64 ≥ 43 chars (rough credential heuristic)
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
  // English
  'road', 'rd', 'street', 'st', 'avenue', 'ave', 'boulevard', 'blvd',
  'drive', 'dr', 'lane', 'ln', 'court', 'ct', 'place', 'pl',
  'circle', 'terrace', 'way', 'highway', 'hwy', 'expressway',
  // Indian
  'nagar', 'colony', 'sector', 'phase', 'block', 'plot',
  'flat', 'floor', 'building', 'complex', 'society', 'apartments',
  'village', 'district', 'tehsil', 'mandal', 'taluka',
  'marg', 'vihar', 'enclave', 'extension', 'puram', 'park',
  'heights', 'residency', 'towers', 'cross', 'main',
]);

function looksLikeAddress(value) {
  const str = String(value).trim().toLowerCase();
  if (str.length < 6) return false;
  if (!/\d/.test(str)) return false;
  const words = str.split(/[\s,\-\/]+/);
  return words.some(w => ADDRESS_VALUE_KEYWORDS.has(w));
}

// ---------------------------------------------------------------------------
// 7b. Sample flattener — handles JSONB objects and arrays
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

function maskValue(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  if (!str) return '';

  // Email: keep first char of local + full domain
  if (VALUE_PATTERNS.EMAIL.test(str)) {
    const [local, domain] = str.split('@');
    return `${local[0]}***@${domain}`;
  }

  // UUID: keep version and variant nibbles visible for structural recognition
  if (VALUE_PATTERNS.UUID.test(str)) {
    return str.replace(/[0-9a-f]/gi, (c, i) => (i < 9 || [14, 19].includes(i)) ? c : '*');
  }

  // Phone / long numeric: keep last 4 digits
  if (str.length >= 8 && /^\+?[\d\s\-().]+$/.test(str)) {
    return `${'*'.repeat(str.length - 4)}${str.slice(-4)}`;
  }

  // General long value: keep first char, mask rest
  if (str.length >= 4) {
    return `${str[0]}${'*'.repeat(Math.min(str.length - 1, 6))}`;
  }

  // Short values (gender codes M/F, A+, etc.): don't mask — they're not PII themselves
  return str;
}

// ---------------------------------------------------------------------------
// 8b. LLM-optimised masking
//
// Different goal from maskValue():
//   maskValue()   → user-facing display, minimal visible info
//   maskForLLM()  → sent to Gemini, preserves TYPE SIGNATURE so the model
//                   can classify without seeing actual PII
//
// Design rules:
//   - Keep structural shape (format, length, character class) visible
//   - Never send real personal data values
//   - Use bracketed type hints for opaque formats (hashes, tokens)
//   - Short enum values (M/F, A+, Hindu) are kept as-is — the value itself
//     is needed for classification and isn't linkable to a specific person
// ---------------------------------------------------------------------------

function maskForLLM(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  if (!str) return null;

  // Short enum / code values — safe to show as-is, needed for classification
  // (gender codes, blood groups, religion names, status codes, etc.)
  if (str.length <= 12 && !/\d{5,}/.test(str) && !str.includes('@')) return str;

  // Email: keep first char of local part + full domain (domain is not PII)
  if (VALUE_PATTERNS.EMAIL.test(str)) {
    const [local, domain] = str.split('@');
    return `${local[0]}***@${domain}`;
  }

  // Bcrypt / Argon2 / PBKDF2 — hash algorithm is the only signal needed
  if (/^\$2[aby]\$\d+\$/.test(str))  return '[bcrypt-hash]';
  if (/^\$argon2/.test(str))          return '[argon2-hash]';
  if (/^pbkdf2:/i.test(str))          return '[pbkdf2-hash]';

  // Hex hashes — identify by exact length (algorithm is diagnostic)
  if (/^[a-f0-9]{32}$/i.test(str))   return '[md5-hash:32chars]';
  if (/^[a-f0-9]{40}$/i.test(str))   return '[sha1-hash:40chars]';
  if (/^[a-f0-9]{64}$/i.test(str))   return '[sha256-hash:64chars]';
  if (/^[a-f0-9]{128}$/i.test(str))  return '[sha512-hash:128chars]';

  // UUID — format is diagnostic, version nibble preserved
  if (VALUE_PATTERNS.UUID.test(str)) {
    const ver = str[14];
    return `[uuid-v${ver}:xxxxxxxx-xxxx-${ver}xxx-xxxx-xxxxxxxxxxxx]`;
  }

  // PAN card — keep positional format (letter pattern is the PAN signature)
  if (VALUE_PATTERNS.PAN.test(str)) {
    return `${str[0]}XXXX${str[5]}XXX${str[9]}`;  // e.g. AXXXXCXXXF
  }

  // Aadhaar — show last 4 digits (standard display format in India)
  if (VALUE_PATTERNS.AADHAAR.test(str)) {
    const d = str.replace(/[\s\-]/g, '');
    return `XXXX XXXX ${d.slice(-4)}`;
  }

  // Indian Passport — show format: letter + masked digits
  if (VALUE_PATTERNS.PASSPORT.test(str)) {
    return `${str[0]}XXXXXXX`;
  }

  // Credit/debit card — last 4 visible (PCI-DSS standard display)
  if (VALUE_PATTERNS.CARD.test(str)) {
    const d = str.replace(/[\s\-]/g, '');
    return `XXXX-XXXX-XXXX-${d.slice(-4)}`;
  }

  // IFSC — not personal data, safe to show completely
  if (VALUE_PATTERNS.IFSC.test(str)) return str;

  // MAC address — keep format, mask last 3 octets
  if (VALUE_PATTERNS.MAC.test(str)) {
    const parts = str.split(/[:\-]/);
    return `${parts[0]}:${parts[1]}:XX:XX:XX:XX`;
  }

  // Phone number — keep format + last 4 digits
  if (VALUE_PATTERNS.PHONE.test(str)) {
    const d = str.replace(/[\s\-().]/g, '');
    if (d.startsWith('+')) return `${d.slice(0, 3)}XXXXXX${d.slice(-4)}`;
    return `XXXXXX${d.slice(-4)}`;
  }

  // IPv4 — mask last 2 octets
  if (VALUE_PATTERNS.IPV4.test(str)) {
    const p = str.split('.');
    return `${p[0]}.${p[1]}.X.X`;
  }

  // Date formats — show year only, mask month/day (year alone is not PII)
  const isoDate = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoDate) return `${isoDate[1]}-XX-XX`;
  const dmyDate = str.match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})$/);
  if (dmyDate) return `XX/XX/${dmyDate[3]}`;
  const monDate = str.match(/^(\d{2})[\-\s](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[\-\s](\d{4})$/i);
  if (monDate) return `XX-${monDate[2]}-${monDate[3]}`;

  // Indian pincode / US ZIP — not directly personal, safe to show
  if (VALUE_PATTERNS.PINCODE.test(str) || VALUE_PATTERNS.ZIP.test(str)) return str;

  // Long base64 (binary data, biometric templates, encoded blobs)
  if (/^[A-Za-z0-9+/]{40,}={0,2}$/.test(str)) return `[base64-encoded:${str.length}chars]`;

  // Long token / API key (alphanumeric, no spaces)
  if (str.length > 20 && /^[A-Za-z0-9_\-]+$/.test(str)) return `[token:${str.length}chars]`;

  // Person name — keep first letter of each word
  if (VALUE_PATTERNS.NAME.test(str) || VALUE_PATTERNS.NAME.test(
    str.replace(/\b\w+/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
  )) {
    return str.split(/\s+/).map(w => `${w[0]}${'*'.repeat(Math.min(w.length - 1, 4))}`).join(' ');
  }

  // General fallback — keep first char + length hint so LLM knows value exists
  return `${str[0]}***[${str.length}chars]`;
}

// ---------------------------------------------------------------------------
// 9. Confidence scoring
// ---------------------------------------------------------------------------

function computeConfidence(nameMatch, valueMatch) {
  if (nameMatch?.matchStrength === 'strong' && valueMatch) {
    return { score: 92, level: 'HIGH' };
  }
  if (nameMatch?.matchStrength === 'strong') {
    return { score: 62, level: 'MEDIUM' };
  }
  if (nameMatch?.matchStrength === 'weak' && valueMatch) {
    return { score: 57, level: 'MEDIUM' };
  }
  // High-specificity value matches (PAN, Aadhaar, email, etc.) get higher value-only score
  const HIGH_SPEC = new Set(['EMAIL', 'PAN', 'AADHAAR', 'PASSPORT', 'IFSC', 'MAC', 'UUID', 'CARD', 'PHONE']);
  if (valueMatch && HIGH_SPEC.has(valueMatch)) {
    return { score: 72, level: 'MEDIUM' };
  }
  if (valueMatch) {
    return { score: 50, level: 'MEDIUM' };
  }
  if (nameMatch?.matchStrength === 'weak') {
    return { score: 25, level: 'LOW' };
  }
  return null;
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
    parts.push('Values appear hashed/encrypted — detection based on field name only');
  }
  return parts.join('; ');
}

// ---------------------------------------------------------------------------
// 10. Value category remapping
//     Some value patterns map to a different PII category label.
// ---------------------------------------------------------------------------
function valueMatchToCategory(vm) {
  const MAP = {
    CARD:     'BANK_ACCOUNT',
    IFSC:     'BANK_ACCOUNT',
    IPV4:     'USER_ID',
    MAC:      'USER_ID',
    UUID:     'USER_ID',
    PASSPORT: 'AADHAAR',      // government ID category
    PINCODE:  'ADDRESS',
    ZIP:      'ADDRESS',
  };
  return MAP[vm] ?? vm;
}

// ---------------------------------------------------------------------------
// 11. Main public API
// ---------------------------------------------------------------------------

function toTitleCase(str) {
  return str.replace(/\b\w+/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function isMajorityNames(samples) {
  if (!samples.length) return false;
  const hits = samples.filter(v => {
    const s = String(v).trim();
    return VALUE_PATTERNS.NAME.test(s) || VALUE_PATTERNS.NAME.test(toTitleCase(s));
  });
  return hits.length >= Math.ceil(samples.length * 0.6);
}

/**
 * Classify a single field and its sample values.
 *
 * @param {string} fieldName    Column name or dot-path (e.g. "user.contact.email")
 * @param {any[]}  sampleValues Up to 100 non-null sample values
 * @returns {object|null}       Classification result or null if no PII detected
 */
function classifyField(fieldName, sampleValues = []) {
  const leafName  = fieldName.includes('.') ? fieldName.split('.').pop() : fieldName;
  const tokens    = normaliseFieldName(leafName);
  const nameMatch = matchFieldName(tokens);

  // Flatten arrays/JSONB, take up to 20 non-empty samples for better statistical coverage
  const nonNullSamples = sampleValues
    .flatMap(flattenSampleValue)
    .filter(v => v.trim() !== '')
    .slice(0, 20);

  let valueMatch = null;
  let hashedFlag = false;

  for (const sample of nonNullSamples) {
    const vm = matchValue(sample);
    // NAME, GENDER, RELIGION require majority confirmation — skip single-sample fast path
    if (vm && !['NAME', 'GENDER', 'RELIGION'].includes(vm)) { valueMatch = vm; break; }
    if (looksHashed(sample)) { hashedFlag = true; }
  }

  // Remap value match to canonical PII category
  if (valueMatch) valueMatch = valueMatchToCategory(valueMatch);

  // Suppress DOB value-only detection for operational timestamps
  if (valueMatch === 'DOB' && !nameMatch) {
    const leafTokenSet = new Set(normaliseFieldName(leafName));
    if ([...NON_DOB_DATE_TOKENS].some(t => leafTokenSet.has(t))) {
      valueMatch = null;
    }
  }

  // NAME: flag only if ≥60% of samples look like person names
  if (!valueMatch && isMajorityNames(nonNullSamples)) valueMatch = 'NAME';

  // GENDER: flag if ≥60% of samples are recognised gender values
  if (!valueMatch && nonNullSamples.length > 0) {
    const genderHits = nonNullSamples.filter(v => VALUE_PATTERNS.GENDER.test(String(v).trim()));
    if (genderHits.length >= Math.ceil(nonNullSamples.length * 0.6)) {
      valueMatch = 'GENDER';
    }
  }

  // RELIGION: flag if ≥60% of samples are recognised religion values
  if (!valueMatch && nonNullSamples.length > 0) {
    const religionHits = nonNullSamples.filter(v => VALUE_PATTERNS.RELIGION.test(String(v).trim()));
    if (religionHits.length >= Math.ceil(nonNullSamples.length * 0.6)) {
      valueMatch = 'RELIGION';
    }
  }

  // ADDRESS: value-level heuristic — digit + known address keyword
  if (!valueMatch) {
    for (const sample of nonNullSamples) {
      if (looksLikeAddress(sample)) { valueMatch = 'ADDRESS'; break; }
    }
  }

  const category = nameMatch?.category ?? (valueMatch ? valueMatch : null);
  if (!category) return null;

  const confidence = computeConfidence(nameMatch, valueMatch);
  if (!confidence) return null;

  const maskedSamples = nonNullSamples.slice(0, 3).map(maskValue);

  return {
    fieldPath:          fieldName,
    piiCategory:        category,
    confidenceScore:    confidence.score,
    confidenceLevel:    confidence.level,
    detectionReason:    buildReason(leafName, nameMatch, valueMatch, hashedFlag),
    sampleValuesMasked: maskedSamples,
  };
}

/**
 * Classify all fields in a table/collection.
 *
 * @param {Array<{name: string, samples: any[]}>} fields
 * @returns {Array}  Classification results (nulls filtered)
 */
function classifyFields(fields) {
  return fields
    .map(f => classifyField(f.name, f.samples))
    .filter(Boolean);
}

module.exports = { classifyField, classifyFields, normaliseFieldName, maskValue, maskForLLM };
