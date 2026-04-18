"use strict";

const config = require("./environment");

/**
 * Database connection configuration.
 * Provides connection setup for both MongoDB and PostgreSQL.
 */

async function connectMongoDB() {
  const mongoose = require("mongoose");
  await mongoose.connect(config.MONGODB_URI);
  console.log("[DB] Connected to MongoDB Atlas");
  return mongoose;
}

async function connectPostgreSQL() {
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: config.PG_CONNECTION_STRING });
  await pool.query("SELECT 1");
  console.log("[DB] Connected to PostgreSQL");
  return pool;
}

async function connectDatabase() {
  if (config.DATABASE_TYPE === "postgresql") {
    return { type: "postgresql", pool: await connectPostgreSQL() };
  }
  return { type: "mongodb", mongoose: await connectMongoDB() };
}

module.exports = { connectMongoDB, connectPostgreSQL, connectDatabase };
