'use strict';

const { MongoClient } = require('mongodb');
const logger = require('../utils/logger');

const CONNECT_TIMEOUT_MS = 10_000;
const SAMPLE_LIMIT       = 100;

/**
 * Build a MongoClient from config.
 * connectionString takes precedence over host/port/database.
 */
function buildClient(config) {
  const uri = (config.connectionString && config.connectionString.trim())
    || buildUri(config);

  const isSrv = uri.startsWith('mongodb+srv');

  return new MongoClient(uri, {
    connectTimeoutMS:            CONNECT_TIMEOUT_MS,
    serverSelectionTimeoutMS:    CONNECT_TIMEOUT_MS,
    // Let the driver auto-handle TLS from the URI scheme.
    // For mongodb+srv we explicitly allow invalid certs so cloud hosts
    // (Render, Railway, etc.) work without needing the Atlas CA bundle.
    ...(isSrv ? { tls: true, tlsAllowInvalidCertificates: true } : {}),
  });
}

function buildUri(config) {
  const host     = config.host     || 'localhost';
  const port     = config.port     || 27017;
  const database = config.database || 'test';
  const user     = config.user;
  const password = config.password;

  if (user && password) {
    return `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
  }
  return `mongodb://${host}:${port}/${database}`;
}

/**
 * Test connectivity. Returns { success, latencyMs?, error? }.
 */
async function testConnection(config) {
  const client = buildClient(config);
  const start  = Date.now();
  try {
    await client.connect();
    await client.db().command({ ping: 1 });
    return { success: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Discover all collections and their field paths.
 * Returns:
 *   [ { name: collectionName, fields: [ { name: dotPath, samples: [] } ] } ]
 *
 * Fields are derived by recursively flattening sample documents.
 */
function resolveDatabase(config) {
  if (config.database && config.database.trim()) return config.database.trim();
  // Extract database name from connection string path segment
  // e.g. mongodb+srv://user:pass@host/mydb?opts  →  mydb
  if (config.connectionString) {
    try {
      const url = new URL(config.connectionString.replace('mongodb+srv://', 'https://').replace('mongodb://', 'https://'));
      const dbFromPath = url.pathname.replace(/^\//, '').split('?')[0];
      if (dbFromPath) return dbFromPath;
    } catch {}
  }
  return undefined; // let the driver use its default
}

// Remove numeric array indices from dot-paths so addresses.0.street and
// addresses.1.street both merge into addresses.street — avoids duplicate findings.
function normalizeArrayPath(path) {
  return path.replace(/\.\d+(?=\.|$)/g, '');
}

/**
 * Sample documents from a collection using _id-range queries wherever possible.
 *
 * Strategy:
 *  - Small collections (≤ 2× limit): sequential scan sorted by _id (deterministic, fast)
 *  - Large collections with ObjectId _id: range-based begin/middle/end slices using
 *    ObjectId.createFromTime() — all three fetches use the _id index, zero full-scan penalty
 *  - Large collections with non-ObjectId _id: fall back to sort+skip, but with _id sort
 *    so at least the order is deterministic across runs
 */
async function sampleCollection(db, name, total) {
  const { ObjectId } = require('mongodb');
  const slice = Math.ceil(SAMPLE_LIMIT / 3);

  if (total <= SAMPLE_LIMIT * 2) {
    return db.collection(name).find({}).sort({ _id: 1 }).limit(SAMPLE_LIMIT).toArray();
  }

  // Fetch anchor documents (first and last) to determine _id range
  const [firstDoc, lastDoc] = await Promise.all([
    db.collection(name).findOne({}, { sort: { _id: 1 }, projection: { _id: 1 } }),
    db.collection(name).findOne({}, { sort: { _id: -1 }, projection: { _id: 1 } }),
  ]);

  if (firstDoc && lastDoc && firstDoc._id instanceof ObjectId) {
    // ObjectId encodes a Unix timestamp in the first 4 bytes.
    // Interpolate the midpoint timestamp → construct a mid ObjectId → O(1) range query,
    // no .skip() needed so no server-side sequential scan of half the collection.
    const t1    = firstDoc._id.getTimestamp().getTime();
    const t2    = lastDoc._id.getTimestamp().getTime();
    const midId = ObjectId.createFromTime(Math.floor((t1 + t2) / 2 / 1000));

    const [startDocs, midDocs, endDocs] = await Promise.all([
      db.collection(name).find({}).sort({ _id: 1 }).limit(slice).toArray(),
      db.collection(name).find({ _id: { $gte: midId } }).sort({ _id: 1 }).limit(slice).toArray(),
      // Fetch end slice in reverse then flip — avoids a large skip to the tail
      db.collection(name).find({}).sort({ _id: -1 }).limit(slice).toArray(),
    ]);

    return [...startDocs, ...midDocs, ...endDocs.reverse()];
  }

  // Fallback for non-ObjectId primary keys: use skip but at least sort for determinism
  const midSkip = Math.max(0, Math.floor(total / 2) - Math.floor(slice / 2));
  const endSkip = Math.max(midSkip + slice, total - slice);
  const [startDocs, midDocs, endDocs] = await Promise.all([
    db.collection(name).find({}).sort({ _id: 1 }).limit(slice).toArray(),
    db.collection(name).find({}).sort({ _id: 1 }).skip(midSkip).limit(slice).toArray(),
    db.collection(name).find({}).sort({ _id: 1 }).skip(endSkip).limit(slice).toArray(),
  ]);
  return [...startDocs, ...midDocs, ...endDocs];
}

async function discoverCollections(config) {
  const client = buildClient(config);
  try {
    await client.connect();
    const db = client.db(resolveDatabase(config));
    logger.info('MongoDB connected — discovering collections', { database: config.database });

    const collectionInfos = await db.listCollections().toArray();
    const results = [];

    for (const info of collectionInfos) {
      const name = info.name;
      try {
        const total = await db.collection(name).estimatedDocumentCount();
        const docs  = await sampleCollection(db, name, total);

        if (docs.length === 0) {
          results.push({ name, fields: [] });
          continue;
        }

        // Aggregate all field paths seen across sample docs.
        // Numeric indices are normalised out so array sub-fields merge into one path.
        const fieldMap = new Map(); // dotPath → sample values

        for (const doc of docs) {
          const flat = flattenDocument(doc);
          for (const [path, value] of Object.entries(flat)) {
            const normalPath = normalizeArrayPath(path);
            if (!fieldMap.has(normalPath)) fieldMap.set(normalPath, []);
            if (value !== null && value !== undefined) {
              fieldMap.get(normalPath).push(value);
            }
          }
        }

        const fields = Array.from(fieldMap.entries()).map(([fieldPath, samples]) => ({
          name:    fieldPath,
          samples: samples.slice(0, SAMPLE_LIMIT),
        }));

        results.push({ name, fields });
      } catch (err) {
        logger.warn(`Failed to sample collection ${name}`, { message: err.message });
        results.push({ name, fields: [], error: err.message });
      }
    }

    return results;
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Recursively flatten a MongoDB document into a dot-path object.
 * Arrays are indexed: e.g. addresses[0].street → "addresses.0.street"
 * _id is excluded.
 *
 * @param {object} doc
 * @param {string} prefix
 * @param {number} maxDepth - guard against pathological nesting
 * @returns {Record<string, any>}
 */
function flattenDocument(doc, prefix = '', maxDepth = 8) {
  const result = {};
  if (!doc || typeof doc !== 'object' || maxDepth <= 0) return result;

  for (const [key, value] of Object.entries(doc)) {
    if (key === '_id') continue;          // skip Mongo internal ID
    const path = prefix ? `${prefix}.${key}` : key;

    if (value === null || value === undefined) {
      result[path] = null;
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        result[path] = null;
      } else {
        // Index only the first element to infer structure; use all for sampling
        for (let i = 0; i < Math.min(value.length, 3); i++) {
          const elem = value[i];
          if (elem !== null && typeof elem === 'object' && !Array.isArray(elem)) {
            Object.assign(result, flattenDocument(elem, `${path}.${i}`, maxDepth - 1));
          } else {
            result[`${path}.${i}`] = elem;
          }
        }
      }
    } else if (typeof value === 'object' && !(value instanceof Date)) {
      Object.assign(result, flattenDocument(value, path, maxDepth - 1));
    } else {
      // Scalar or Date — store as string for regex matching
      result[path] = value instanceof Date ? value.toISOString() : value;
    }
  }

  return result;
}

module.exports = { testConnection, discoverCollections };
