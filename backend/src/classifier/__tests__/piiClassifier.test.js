'use strict';

const { classifyField, classifyFields, normaliseFieldName, maskValue } = require('../piiClassifier');

// ---------------------------------------------------------------------------
// normaliseFieldName
// ---------------------------------------------------------------------------
describe('normaliseFieldName', () => {
  test('lowercases and strips underscores', () => {
    expect(normaliseFieldName('first_name')).toEqual(['first', 'name']);
  });

  test('splits camelCase', () => {
    expect(normaliseFieldName('firstName')).toEqual(['first', 'name']);
  });

  test('handles ALL_CAPS', () => {
    expect(normaliseFieldName('PHONE_NUMBER')).toEqual(['phone', 'number']);
  });

  test('single token', () => {
    expect(normaliseFieldName('email')).toEqual(['email']);
  });
});

// ---------------------------------------------------------------------------
// classifyField — high-confidence detections
// ---------------------------------------------------------------------------
describe('classifyField — HIGH confidence', () => {
  test('email by name + sample', () => {
    const r = classifyField('email', ['user@example.com', 'test@domain.org']);
    expect(r).not.toBeNull();
    expect(r.piiCategory).toBe('EMAIL');
    expect(r.confidenceLevel).toBe('HIGH');
    expect(r.confidenceScore).toBeGreaterThanOrEqual(85);
  });

  test('phone by name + Indian mobile samples', () => {
    const r = classifyField('mobile', ['9876543210', '8123456789']);
    expect(r).not.toBeNull();
    expect(r.piiCategory).toBe('PHONE');
    expect(r.confidenceLevel).toBe('HIGH');
  });

  test('PAN by name + sample', () => {
    const r = classifyField('pan_number', ['ABCDE1234F', 'XYZPQ5678G']);
    expect(r).not.toBeNull();
    expect(r.piiCategory).toBe('PAN');
    expect(r.confidenceLevel).toBe('HIGH');
  });

  test('Aadhaar by name', () => {
    const r = classifyField('aadhaar_no', []);
    expect(r).not.toBeNull();
    expect(r.piiCategory).toBe('AADHAAR');
  });

  test('DOB by name + date samples', () => {
    const r = classifyField('date_of_birth', ['1990-05-21', '1985-11-03']);
    expect(r).not.toBeNull();
    expect(r.piiCategory).toBe('DOB');
    expect(r.confidenceLevel).toBe('HIGH');
  });

  test('GENDER by name + samples', () => {
    const r = classifyField('gender', ['Male', 'Female', 'Other']);
    expect(r).not.toBeNull();
    expect(r.piiCategory).toBe('GENDER');
  });

  test('CREDENTIAL — password field', () => {
    const r = classifyField('password_hash', ['$2b$10$abcde...']);
    expect(r).not.toBeNull();
    expect(r.piiCategory).toBe('CREDENTIAL');
  });

  test('BANK_ACCOUNT — IFSC code', () => {
    const r = classifyField('ifsc_code', ['HDFC0001234']);
    expect(r).not.toBeNull();
    expect(r.piiCategory).toBe('BANK_ACCOUNT');
  });

  test('USER_ID — IP address field', () => {
    const r = classifyField('ip_addr', ['192.168.1.1', '10.0.0.5']);
    expect(r).not.toBeNull();
    expect(r.piiCategory).toBe('USER_ID');
  });
});

// ---------------------------------------------------------------------------
// classifyField — abbreviated / obscure column names (LLM would catch these,
// but we verify pattern layer still fires on the abbreviations we mapped)
// ---------------------------------------------------------------------------
describe('classifyField — abbreviated names', () => {
  test('ph → PHONE', () => {
    const r = classifyField('ph', ['9123456780']);
    expect(r).not.toBeNull();
    expect(r.piiCategory).toBe('PHONE');
  });

  test('dob → DOB', () => {
    const r = classifyField('dob', []);
    expect(r).not.toBeNull();
    expect(r.piiCategory).toBe('DOB');
  });

  test('mob → PHONE', () => {
    const r = classifyField('mob', []);
    expect(r).not.toBeNull();
    expect(r.piiCategory).toBe('PHONE');
  });

  test('pwd → CREDENTIAL', () => {
    const r = classifyField('pwd', []);
    expect(r).not.toBeNull();
    expect(r.piiCategory).toBe('CREDENTIAL');
  });

  test('addr → ADDRESS (weak match)', () => {
    const r = classifyField('addr', []);
    expect(r).not.toBeNull();
    expect(r.piiCategory).toBe('ADDRESS');
  });
});

// ---------------------------------------------------------------------------
// False positive prevention — CRITICAL for compliance tools
// ---------------------------------------------------------------------------
describe('classifyField — false positive prevention', () => {
  test('created_at timestamp is NOT DOB', () => {
    const r = classifyField('created_at', ['2024-01-15 10:30:00']);
    expect(r).toBeNull();
  });

  test('updated_at is NOT DOB', () => {
    const r = classifyField('updated_at', []);
    expect(r).toBeNull();
  });

  test('account_type enum is NOT BANK_ACCOUNT', () => {
    const r = classifyField('account_type', ['savings', 'current', 'salary']);
    expect(r).toBeNull();
  });

  test('bank_name is NOT PII (entity name)', () => {
    const r = classifyField('bank_name', ['HDFC Bank', 'SBI', 'Axis']);
    expect(r).toBeNull();
  });

  test('company_name is NOT personal NAME', () => {
    const r = classifyField('company_name', ['Acme Corp', 'TechStart']);
    expect(r).toBeNull();
  });

  test('status enum is not classified', () => {
    const r = classifyField('status', ['active', 'inactive', 'pending']);
    expect(r).toBeNull();
  });

  test('balance numeric is not classified', () => {
    const r = classifyField('balance', ['15000.50', '8500.00']);
    expect(r).toBeNull();
  });

  test('username maps to USER_ID not NAME', () => {
    const r = classifyField('username', ['john_doe', 'alice123']);
    expect(r).not.toBeNull();
    expect(r.piiCategory).toBe('USER_ID');
  });

  test('ip_address maps to USER_ID not ADDRESS', () => {
    const r = classifyField('ip_address', ['192.168.1.1']);
    expect(r).not.toBeNull();
    expect(r.piiCategory).toBe('USER_ID');
  });
});

// ---------------------------------------------------------------------------
// Value-only detection (no name match)
// ---------------------------------------------------------------------------
describe('classifyField — value-only detection', () => {
  test('detects email from samples when column is named generically', () => {
    const r = classifyField('field1', ['a@b.com', 'x@y.org']);
    expect(r).not.toBeNull();
    expect(r.piiCategory).toBe('EMAIL');
  });

  test('detects PAN from samples', () => {
    const r = classifyField('data_col', ['ABCDE1234F']);
    expect(r).not.toBeNull();
    expect(r.piiCategory).toBe('PAN');
  });

  test('majority name detection — 3 of 4 look like names', () => {
    const r = classifyField('col_x', ['Rahul Sharma', 'Priya Patel', 'John Doe', '12345']);
    expect(r).not.toBeNull();
    expect(r.piiCategory).toBe('NAME');
  });

  test('minority name samples — only 1 of 4 looks like name → no detection', () => {
    const r = classifyField('col_x', ['Rahul Sharma', '12345', 'foobar', 'xyz']);
    // Only 1/4 = 25%, below the 60% threshold
    expect(r).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// maskValue
// ---------------------------------------------------------------------------
describe('maskValue', () => {
  test('masks email — keeps first char of local + full domain', () => {
    expect(maskValue('john@example.com')).toBe('j***@example.com');
  });

  test('masks long string — keeps last 4 chars', () => {
    expect(maskValue('9876543210')).toBe('******3210');
  });

  test('masks short string — keeps first char', () => {
    expect(maskValue('AB1')).toBe('A**');
  });

  test('null returns null', () => {
    expect(maskValue(null)).toBeNull();
  });

  test('empty string returns empty string', () => {
    expect(maskValue('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// classifyFields (batch API)
// ---------------------------------------------------------------------------
describe('classifyFields', () => {
  test('filters out null results', () => {
    const fields = [
      { name: 'email',      samples: ['a@b.com'] },
      { name: 'status',     samples: ['active'] },
      { name: 'created_at', samples: [] },
      { name: 'mobile',     samples: ['9876543210'] },
    ];
    const results = classifyFields(fields);
    expect(results.length).toBe(2);
    expect(results.map(r => r.piiCategory)).toEqual(expect.arrayContaining(['EMAIL', 'PHONE']));
  });

  test('returns empty array for clean schema', () => {
    const fields = [
      { name: 'id',         samples: ['1', '2', '3'] },
      { name: 'created_at', samples: ['2024-01-01'] },
      { name: 'is_active',  samples: ['true', 'false'] },
    ];
    expect(classifyFields(fields)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Counter / boolean suppression (false positive prevention — new)
// ---------------------------------------------------------------------------
describe('classifyField — counter and boolean suppression', () => {
  test('login_count is NOT classified (counter suffix suppression)', () => {
    const r = classifyField('login_count', ['42', '7', '100']);
    expect(r).toBeNull();
  });

  test('visit_total is NOT classified', () => {
    const r = classifyField('visit_total', ['500', '120']);
    expect(r).toBeNull();
  });

  test('is_active boolean is NOT classified', () => {
    const r = classifyField('is_active', ['true', 'false']);
    expect(r).toBeNull();
  });

  test('has_email boolean is NOT classified', () => {
    const r = classifyField('has_email', ['true', 'false']);
    expect(r).toBeNull();
  });

  test('standalone id is NOT classified', () => {
    const r = classifyField('id', ['1', '2', '3']);
    expect(r).toBeNull();
  });

  test('join_date with date values is NOT classified as DOB', () => {
    const r = classifyField('join_date', ['2023-12-14', '2022-05-01']);
    expect(r).toBeNull();
  });

  test('opened_date with date values is NOT classified as DOB', () => {
    const r = classifyField('opened_date', ['2020-06-11', '2019-03-20']);
    expect(r).toBeNull();
  });

  test('last_login with date values is NOT classified as DOB', () => {
    const r = classifyField('last_login', ['2024-11-30 20:16:49']);
    // last_login should not be DOB (operational timestamp)
    if (r) expect(r.piiCategory).not.toBe('DOB');
  });

  test('last_challenged_at is NOT NAME (standalone "last" must not match NAME)', () => {
    const r = classifyField('last_challenged_at', []);
    expect(r).toBeNull();
  });

  test('last_webauthn_challenge_data is NOT NAME', () => {
    const r = classifyField('last_webauthn_challenge_data', []);
    expect(r).toBeNull();
  });

  test('first_seen is NOT NAME (standalone "first" must not match NAME)', () => {
    const r = classifyField('first_seen', []);
    expect(r).toBeNull();
  });

  test('first_seen with date values is NOT DOB (event timestamp)', () => {
    const r = classifyField('first_seen', ['2024-01-01', '2023-06-15']);
    expect(r).toBeNull();
  });

  test('standalone state is NOT ADDRESS (OAuth/FSM state, not geographic)', () => {
    const r = classifyField('state', ['active', 'pending', 'closed']);
    expect(r).toBeNull();
  });

  test('billing_state is still ADDRESS (state within multi-token field)', () => {
    const r = classifyField('billing_state', []);
    expect(r).not.toBeNull();
    expect(r.piiCategory).toBe('ADDRESS');
  });

  test('first_name is still NAME after removing standalone first keyword', () => {
    const r = classifyField('first_name', ['Rahul', 'Priya']);
    expect(r).not.toBeNull();
    expect(r.piiCategory).toBe('NAME');
  });

  test('last_name is still NAME after removing standalone last keyword', () => {
    const r = classifyField('last_name', ['Sharma', 'Patel']);
    expect(r).not.toBeNull();
    expect(r.piiCategory).toBe('NAME');
  });
});

// ---------------------------------------------------------------------------
// New abbreviations and patterns (future-proofing)
// ---------------------------------------------------------------------------
describe('classifyField — extended abbreviations', () => {
  test('ph with phone samples → PHONE', () => {
    const r = classifyField('ph', ['9876543210']);
    expect(r).not.toBeNull();
    expect(r.piiCategory).toBe('PHONE');
  });

  test('phn → PHONE', () => {
    const r = classifyField('phn', []);
    expect(r).not.toBeNull();
    expect(r.piiCategory).toBe('PHONE');
  });

  test('bd → DOB', () => {
    const r = classifyField('bd', []);
    expect(r).not.toBeNull();
    expect(r.piiCategory).toBe('DOB');
  });

  test('bday → DOB', () => {
    const r = classifyField('bday', ['1990-05-21']);
    expect(r).not.toBeNull();
    expect(r.piiCategory).toBe('DOB');
  });

  test('fn → NAME', () => {
    const r = classifyField('fn', ['Rahul', 'Priya']);
    expect(r).not.toBeNull();
    expect(r.piiCategory).toBe('NAME');
  });

  test('ln → NAME', () => {
    const r = classifyField('ln', []);
    expect(r).not.toBeNull();
    expect(r.piiCategory).toBe('NAME');
  });

  test('haddr → ADDRESS', () => {
    const r = classifyField('haddr', []);
    expect(r).not.toBeNull();
    expect(r.piiCategory).toBe('ADDRESS');
  });

  test('addr1 → ADDRESS', () => {
    const r = classifyField('addr1', []);
    expect(r).not.toBeNull();
    expect(r.piiCategory).toBe('ADDRESS');
  });

  test('gndr → GENDER', () => {
    const r = classifyField('gndr', ['Male', 'Female']);
    expect(r).not.toBeNull();
    expect(r.piiCategory).toBe('GENDER');
  });

  test('ifsc_cd → BANK_ACCOUNT by name', () => {
    const r = classifyField('ifsc_cd', []);
    expect(r).not.toBeNull();
    expect(r.piiCategory).toBe('BANK_ACCOUNT');
  });

  test('IFSC value detected even in generic column', () => {
    const r = classifyField('col_x', ['HDFC0001234']);
    expect(r).not.toBeNull();
    expect(r.piiCategory).toBe('BANK_ACCOUNT');
  });

  test('IPv4 value detected in generic column', () => {
    const r = classifyField('remote_host', ['192.168.1.1', '10.0.0.5']);
    expect(r).not.toBeNull();
    expect(r.piiCategory).toBe('USER_ID');
  });

  test('cvv → CREDENTIAL', () => {
    const r = classifyField('cvv', ['123', '456']);
    expect(r).not.toBeNull();
    expect(r.piiCategory).toBe('CREDENTIAL');
  });

  test('acct_no → BANK_ACCOUNT', () => {
    const r = classifyField('acct_no', []);
    expect(r).not.toBeNull();
    expect(r.piiCategory).toBe('BANK_ACCOUNT');
  });
});
