-- DataGuard — PostgreSQL Seed Data
-- Creates two schemas with realistic fake PII data for scanner testing.
-- All data is fictional. No real personal information is used.

-- ─────────────────────────────────────────────
-- Schema: customers
-- Simulates an e-commerce customer database
-- ─────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS customers;

CREATE TABLE customers.users (
  id            SERIAL PRIMARY KEY,
  first_name    VARCHAR(100),
  last_name     VARCHAR(100),
  email         VARCHAR(255),
  phone_number  VARCHAR(20),
  date_of_birth DATE,
  gender        VARCHAR(20),
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE TABLE customers.addresses (
  id          SERIAL PRIMARY KEY,
  user_id     INT REFERENCES customers.users(id),
  address     TEXT,
  city        VARCHAR(100),
  state       VARCHAR(100),
  pincode     VARCHAR(10),
  country     VARCHAR(50) DEFAULT 'India'
);

CREATE TABLE customers.payment_info (
  id             SERIAL PRIMARY KEY,
  user_id        INT REFERENCES customers.users(id),
  account_number VARCHAR(20),
  ifsc_code      VARCHAR(11),
  pan_number     VARCHAR(10),
  card_number    VARCHAR(20)
);

-- ─────────────────────────────────────────────
-- Schema: hr
-- Simulates an HR / employee database
-- ─────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS hr;

CREATE TABLE hr.employees (
  emp_id       SERIAL PRIMARY KEY,
  full_name    VARCHAR(200),
  email_id     VARCHAR(255),
  mob          VARCHAR(15),
  dob_dt       DATE,
  gender       VARCHAR(10),
  aadhaar_no   VARCHAR(14),
  pan_no       VARCHAR(10),
  designation  VARCHAR(100),
  department   VARCHAR(100),
  salary       NUMERIC(12,2),
  joined_date  DATE
);

CREATE TABLE hr.credentials (
  emp_id    INT REFERENCES hr.employees(emp_id),
  username  VARCHAR(100),
  password  VARCHAR(255),
  api_key   VARCHAR(255),
  PRIMARY KEY (emp_id)
);

-- ─────────────────────────────────────────────
-- Schema: analytics
-- Simulates an analytics database — less obvious PII
-- ─────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS analytics;

CREATE TABLE analytics.events (
  id         BIGSERIAL PRIMARY KEY,
  user_id    INT,
  session_id VARCHAR(64),
  event_type VARCHAR(50),
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE analytics.user_profiles (
  uid          INT PRIMARY KEY,
  display_nm   VARCHAR(200),
  contact_no   VARCHAR(20),
  emailAddress VARCHAR(255),
  location     TEXT
);

-- ─────────────────────────────────────────────
-- Seed data: customers.users
-- ─────────────────────────────────────────────
INSERT INTO customers.users (first_name, last_name, email, phone_number, date_of_birth, gender) VALUES
  ('Aarav',    'Sharma',    'aarav.sharma@email.com',    '+919876543210', '1990-04-15', 'Male'),
  ('Priya',    'Mehta',     'priya.mehta@gmail.com',     '9845123456',    '1985-11-22', 'Female'),
  ('Rahul',    'Gupta',     'rahul.g@company.in',        '07812345678',   '1992-07-08', 'Male'),
  ('Sunita',   'Patel',     'sunita.patel@work.com',     '+91 98123 45678','1988-02-29','Female'),
  ('Vikram',   'Nair',      'vikram.nair@example.org',   '9900112233',    '1995-09-11', 'Male'),
  ('Anjali',   'Singh',     'anjali.singh@mail.co',      '+919712345678', '1993-12-01', 'Female'),
  ('Deepak',   'Yadav',     'deepak.yadav@test.com',     '9654321098',    '1987-06-30', 'Male'),
  ('Kavita',   'Kumar',     'kavita.kumar@domain.com',   '+919876001234', '1991-03-17', 'Female'),
  ('Sanjay',   'Joshi',     'sanjay.joshi@biz.in',       '9123456780',    '1984-08-25', 'Male'),
  ('Meena',    'Agarwal',   'meena.agarwal@firm.co.in',  '+917890123456', '1996-01-14', 'Female');

INSERT INTO customers.addresses (user_id, address, city, state, pincode) VALUES
  (1, '12 MG Road, Sector 5',       'Bengaluru',  'Karnataka',      '560001'),
  (2, 'Flat 4B, Sunrise Apartments','Mumbai',     'Maharashtra',    '400001'),
  (3, '78 Park Street',             'Kolkata',    'West Bengal',    '700016'),
  (4, 'House 22, Civil Lines',      'Lucknow',    'Uttar Pradesh',  '226001'),
  (5, '5th Cross, Indiranagar',     'Bengaluru',  'Karnataka',      '560038'),
  (6, 'Plot 9, Sector 18',          'Noida',      'Uttar Pradesh',  '201301'),
  (7, '33 Anna Nagar',              'Chennai',    'Tamil Nadu',     '600040'),
  (8, 'Block C, DLF Phase 2',       'Gurugram',   'Haryana',        '122002'),
  (9, '101 Baner Road',             'Pune',       'Maharashtra',    '411045'),
  (10,'Lane 7, Kankurgachi',        'Kolkata',    'West Bengal',    '700054');

INSERT INTO customers.payment_info (user_id, account_number, ifsc_code, pan_number, card_number) VALUES
  (1,  '1234567890123456', 'HDFC0001234', 'ABCDE1234F', '4111111111111111'),
  (2,  '9876543210987654', 'ICIC0004567', 'FGHIJ5678K', '5500005555555559'),
  (3,  '1122334455667788', 'SBIN0012345', 'LMNOP9012L', '3714496353984312'),
  (4,  '9988776655443322', 'AXIS0009876', 'QRSTU3456Q', '6011111111111117'),
  (5,  '5566778899001122', 'KOTAK00001',  'VWXYZ7890V', '4012888888881881');

-- ─────────────────────────────────────────────
-- Seed data: hr.employees
-- ─────────────────────────────────────────────
INSERT INTO hr.employees (full_name, email_id, mob, dob_dt, gender, aadhaar_no, pan_no, designation, department, salary, joined_date) VALUES
  ('Rohan Verma',        'rohan.v@company.com',    '9845001234', '1988-05-20', 'Male',   '1234 5678 9012', 'ABCDE1234F', 'Software Engineer',    'Engineering',  85000,  '2018-01-15'),
  ('Nisha Tiwari',       'nisha.t@company.com',    '9756789012', '1992-09-10', 'Female', '2345 6789 0123', 'FGHIJ5678K', 'Product Manager',      'Product',      120000, '2019-06-01'),
  ('Amit Chandra',       'amit.c@company.com',     '9867892345', '1985-12-05', 'Male',   '3456 7890 1234', 'LMNOP9012L', 'Data Analyst',         'Analytics',    70000,  '2020-03-10'),
  ('Sonal Bhatt',        'sonal.b@company.com',    '9978903456', '1994-07-28', 'Female', '4567 8901 2345', 'QRSTU3456Q', 'UX Designer',          'Design',       75000,  '2021-08-22'),
  ('Kiran Rao',          'kiran.r@company.com',    '9089014567', '1990-03-16', 'Male',   '5678 9012 3456', 'VWXYZ7890V', 'DevOps Engineer',      'Infrastructure',95000, '2017-11-30'),
  ('Pooja Desai',        'pooja.d@company.com',    '9190125678', '1987-11-02', 'Female', '6789 0123 4567', 'ABCDE9876F', 'HR Manager',           'HR',           90000,  '2016-04-14'),
  ('Suresh Iyer',        'suresh.i@company.com',   '9201236789', '1983-08-19', 'Male',   '7890 1234 5678', 'FGHIJ4321K', 'Finance Lead',         'Finance',      115000, '2015-09-07'),
  ('Divya Nambiar',      'divya.n@company.com',    '9312347890', '1995-01-24', 'Female', '8901 2345 6789', 'LMNOP8765L', 'Marketing Specialist', 'Marketing',    65000,  '2022-02-18'),
  ('Prakash Reddy',      'prakash.r@company.com',  '9423458901', '1981-06-11', 'Male',   '9012 3456 7890', 'QRSTU2109Q', 'CTO',                  'Leadership',   250000, '2014-07-01'),
  ('Lakshmi Krishnan',   'lakshmi.k@company.com',  '9534569012', '1993-04-07', 'Female', '0123 4567 8901', 'VWXYZ6543V', 'Legal Counsel',        'Legal',        130000, '2020-10-05');

INSERT INTO hr.credentials (emp_id, username, password, api_key) VALUES
  (1, 'rohan.verma',      '$2b$10$XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', 'ak_live_XXXXXXXXXXXXXXXXXXXX'),
  (2, 'nisha.tiwari',     '$2b$10$YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY', 'ak_live_YYYYYYYYYYYYYYYYYYYY'),
  (3, 'amit.chandra',     'hashed_password_placeholder_1', 'key_placeholder_1'),
  (4, 'sonal.bhatt',      'hashed_password_placeholder_2', 'key_placeholder_2'),
  (5, 'kiran.rao',        'hashed_password_placeholder_3', 'key_placeholder_3');

-- ─────────────────────────────────────────────
-- Seed data: analytics
-- ─────────────────────────────────────────────
INSERT INTO analytics.events (user_id, session_id, event_type, ip_address) VALUES
  (1,  'sess_abc123', 'page_view',  '192.168.1.100'),
  (2,  'sess_def456', 'purchase',   '10.0.0.55'),
  (3,  'sess_ghi789', 'sign_up',    '172.16.0.23'),
  (1,  'sess_abc123', 'click',      '192.168.1.100'),
  (4,  'sess_jkl012', 'logout',     '203.0.113.45');

INSERT INTO analytics.user_profiles (uid, display_nm, contact_no, emailAddress, location) VALUES
  (1,  'Aarav S.',   '+919876543210', 'aarav.sharma@email.com', 'Bengaluru, Karnataka'),
  (2,  'Priya M.',   '9845123456',    'priya.mehta@gmail.com',  'Mumbai, Maharashtra'),
  (3,  'Rahul G.',   '07812345678',   'rahul.g@company.in',     'Kolkata, West Bengal'),
  (4,  'Sunita P.',  '+91 98123 45678','sunita.patel@work.com', 'Lucknow, Uttar Pradesh'),
  (5,  'Vikram N.',  '9900112233',    'vikram.nair@example.org','Chennai, Tamil Nadu');
