// DataGuard — MongoDB Seed Data
// Runs via docker-entrypoint-initdb.d when the container is first created.
// All data is fictional. No real personal information is used.

db = db.getSiblingDB('seed_db');

// ─────────────────────────────────────────────
// Collection: customers
// Simulates a user registration collection with nested addresses
// ─────────────────────────────────────────────
db.customers.drop();
db.customers.insertMany([
  {
    userId: 'USR001',
    profile: {
      firstName:  'Aarav',
      lastName:   'Sharma',
      email:      'aarav.sharma@email.com',
      dateOfBirth:'1990-04-15',
      gender:     'Male',
    },
    contact: {
      mobileNo:   '+919876543210',
      altPhone:   null,
      address: {
        street:   '12 MG Road, Sector 5',
        city:     'Bengaluru',
        state:    'Karnataka',
        pincode:  '560001',
        country:  'India',
      },
    },
    accountCreated: new Date('2022-01-10'),
  },
  {
    userId: 'USR002',
    profile: {
      firstName:  'Priya',
      lastName:   'Mehta',
      email:      'priya.mehta@gmail.com',
      dateOfBirth:'1985-11-22',
      gender:     'Female',
    },
    contact: {
      mobileNo:   '9845123456',
      address: {
        street:   'Flat 4B, Sunrise Apartments',
        city:     'Mumbai',
        state:    'Maharashtra',
        pincode:  '400001',
        country:  'India',
      },
    },
    accountCreated: new Date('2021-06-15'),
  },
  {
    userId: 'USR003',
    profile: {
      firstName:  'Rahul',
      lastName:   'Gupta',
      email:      'rahul.g@company.in',
      dateOfBirth:'1992-07-08',
      gender:     'Male',
    },
    contact: {
      mobileNo:   '07812345678',
      address: {
        street:   '78 Park Street',
        city:     'Kolkata',
        state:    'West Bengal',
        pincode:  '700016',
        country:  'India',
      },
    },
    accountCreated: new Date('2023-03-20'),
  },
]);

// ─────────────────────────────────────────────
// Collection: orders
// Simulates an order management collection
// ─────────────────────────────────────────────
db.orders.drop();
db.orders.insertMany([
  {
    orderId:  'ORD001',
    customer: {
      custId:       'USR001',
      customerName: 'Aarav Sharma',
      emailAddr:    'aarav.sharma@email.com',
      phoneNo:      '+919876543210',
    },
    shipping: {
      recipientName: 'Aarav Sharma',
      streetAddress: '12 MG Road, Sector 5',
      city:          'Bengaluru',
      pinCode:       '560001',
    },
    payment: {
      method:        'card',
      cardNo:        '4111111111111111',
      panNumber:     'ABCDE1234F',
    },
    amount: 2999,
    status: 'delivered',
    createdAt: new Date('2023-11-05'),
  },
  {
    orderId:  'ORD002',
    customer: {
      custId:       'USR002',
      customerName: 'Priya Mehta',
      emailAddr:    'priya.mehta@gmail.com',
      phoneNo:      '9845123456',
    },
    shipping: {
      recipientName: 'Priya Mehta',
      streetAddress: 'Flat 4B, Sunrise Apartments',
      city:          'Mumbai',
      pinCode:       '400001',
    },
    payment: {
      method:    'upi',
      upiId:     'priya.mehta@upi',
    },
    amount: 5499,
    status: 'shipped',
    createdAt: new Date('2024-01-22'),
  },
]);

// ─────────────────────────────────────────────
// Collection: employees
// Simulates an HR employee collection
// ─────────────────────────────────────────────
db.employees.drop();
db.employees.insertMany([
  {
    empId:       'EMP001',
    fullName:    'Rohan Verma',
    emailId:     'rohan.v@company.com',
    mob:         '9845001234',
    dobDt:       '1988-05-20',
    sex:         'Male',
    aadhaarNo:   '1234 5678 9012',
    panNo:       'ABCDE1234F',
    bankDetails: {
      accountNo: '1234567890123456',
      ifscCode:  'HDFC0001234',
      bankName:  'HDFC Bank',
    },
    credentials: {
      username: 'rohan.verma',
      pwd:      '$2b$10$XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    },
    department:  'Engineering',
    joinedDate:  '2018-01-15',
  },
  {
    empId:       'EMP002',
    fullName:    'Nisha Tiwari',
    emailId:     'nisha.t@company.com',
    mob:         '9756789012',
    dobDt:       '1992-09-10',
    sex:         'Female',
    aadhaarNo:   '2345 6789 0123',
    panNo:       'FGHIJ5678K',
    bankDetails: {
      accountNo: '9876543210987654',
      ifscCode:  'ICIC0004567',
      bankName:  'ICICI Bank',
    },
    credentials: {
      username: 'nisha.tiwari',
      pwd:      '$2b$10$YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY',
    },
    department:  'Product',
    joinedDate:  '2019-06-01',
  },
  {
    empId:       'EMP003',
    fullName:    'Amit Chandra',
    emailId:     'amit.c@company.com',
    mob:         '9867892345',
    dobDt:       '1985-12-05',
    sex:         'Male',
    aadhaarNo:   '3456 7890 1234',
    panNo:       'LMNOP9012L',
    bankDetails: {
      accountNo: '1122334455667788',
      ifscCode:  'SBIN0012345',
      bankName:  'SBI',
    },
    credentials: {
      username: 'amit.chandra',
      pwd:      'hashed_password_placeholder',
    },
    department:  'Analytics',
    joinedDate:  '2020-03-10',
  },
]);

// ─────────────────────────────────────────────
// Collection: support_tickets
// Simulates a customer support system
// ─────────────────────────────────────────────
db.support_tickets.drop();
db.support_tickets.insertMany([
  {
    ticketId:    'TKT001',
    submittedBy: {
      name:      'Sunita Patel',
      email:     'sunita.patel@work.com',
      phone:     '+91 98123 45678',
    },
    subject:     'Payment failed',
    description: 'My UPI payment failed but money was debited.',
    status:      'open',
    createdAt:   new Date('2024-02-01'),
  },
  {
    ticketId:    'TKT002',
    submittedBy: {
      name:      'Vikram Nair',
      email:     'vikram.nair@example.org',
      phone:     '9900112233',
    },
    subject:     'Wrong address',
    description: 'Delivery address was not updated correctly.',
    status:      'resolved',
    createdAt:   new Date('2024-01-15'),
  },
]);

print('MongoDB seed data loaded successfully.');
