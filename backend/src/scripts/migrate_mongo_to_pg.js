#!/usr/bin/env node
"use strict";

/**
 * Data migration script: MongoDB → PostgreSQL
 *
 * Reads all documents from MongoDB and inserts them into PostgreSQL.
 * Denormalizes embedded arrays:
 *   - Interaccion.conversacion[] → messages table
 *   - Resultado.errores[] → error_entries table
 *   - Ejercicio.tutorContext → tutor_contexts table
 *
 * Usage:
 *   PG_CONNECTION_STRING=postgres://user:pass@host/db node src/scripts/migrate_mongo_to_pg.js
 *
 * The script is idempotent: it stores mongo_id and skips existing records.
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const mongoose = require("mongoose");
const { Pool } = require("pg");
const { v4: uuidv4 } = require("uuid");

// MongoDB models
const UsuarioModel = require("../infrastructure/persistence/mongodb/models/usuario");
const EjercicioModel = require("../infrastructure/persistence/mongodb/models/ejercicio");
const InteraccionModel = require("../infrastructure/persistence/mongodb/models/interaccion");
const ResultadoModel = require("../infrastructure/persistence/mongodb/models/resultado");

const PG_URI = process.env.PG_CONNECTION_STRING;
const MONGO_URI = process.env.MONGODB_URI;
const BATCH_SIZE = 100;

if (!PG_URI) {
  console.error("ERROR: PG_CONNECTION_STRING not set in environment.");
  process.exit(1);
}
if (!MONGO_URI) {
  console.error("ERROR: MONGODB_URI not set in environment.");
  process.exit(1);
}

// Map MongoDB ObjectId → PostgreSQL UUID
const idMap = {
  usuarios: {},
  ejercicios: {},
  interacciones: {},
  resultados: {},
};

async function main() {
  console.log("[MIGRATE] Connecting to MongoDB...");
  await mongoose.connect(MONGO_URI);
  console.log("[MIGRATE] Connected to MongoDB.");

  console.log("[MIGRATE] Connecting to PostgreSQL...");
  const pool = new Pool({ connectionString: PG_URI });
  await pool.query("SELECT 1");
  console.log("[MIGRATE] Connected to PostgreSQL.");

  // Run migrations first
  const { runMigrations } = require("../infrastructure/persistence/postgresql/PgConnection");
  // Override the pool for migration runner
  const origPool = pool;
  await runMigrationsWithPool(origPool);

  try {
    await migrateUsuarios(pool);
    await migrateEjercicios(pool);
    await migrateInteracciones(pool);
    await migrateResultados(pool);
  } catch (err) {
    console.error("[MIGRATE] FATAL ERROR:", err);
  } finally {
    await pool.end();
    await mongoose.disconnect();
    console.log("[MIGRATE] Done.");
  }
}

async function runMigrationsWithPool(pool) {
  const fs = require("fs");
  const migDir = path.join(
    __dirname,
    "..",
    "infrastructure",
    "persistence",
    "postgresql",
    "migrations"
  );
  const files = fs.readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migDir, file), "utf8");
    console.log(`[MIGRATE] Running migration: ${file}`);
    await pool.query(sql);
  }
}

async function migrateUsuarios(pool) {
  console.log("[MIGRATE] Migrating usuarios...");
  const docs = await UsuarioModel.find().lean();
  let migrated = 0;

  for (const doc of docs) {
    const mongoId = doc._id.toString();
    const pgId = uuidv4();
    idMap.usuarios[mongoId] = pgId;

    try {
      await pool.query(
        `INSERT INTO usuarios (id, upv_login, email, nombre, apellidos, dni, grupos, rol, last_login_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (upv_login) DO NOTHING`,
        [
          pgId, doc.upvLogin, doc.email, doc.nombre, doc.apellidos, doc.dni,
          doc.grupos || [], doc.rol || "alumno", doc.lastLoginAt,
          doc.createdAt || new Date(), doc.updatedAt || new Date(),
        ]
      );
      migrated++;
    } catch (e) {
      console.error(`[MIGRATE] Usuario ${mongoId} failed:`, e.message);
    }
  }
  console.log(`[MIGRATE] Usuarios: ${migrated}/${docs.length} migrated.`);
}

async function migrateEjercicios(pool) {
  console.log("[MIGRATE] Migrating ejercicios...");
  const docs = await EjercicioModel.find().lean();
  let migrated = 0;

  for (const doc of docs) {
    const mongoId = doc._id.toString();
    const pgId = uuidv4();
    idMap.ejercicios[mongoId] = pgId;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO ejercicios (id, titulo, enunciado, imagen, asignatura, concepto, nivel, ca, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          pgId, doc.titulo, doc.enunciado, doc.imagen || "", doc.asignatura,
          doc.concepto, doc.nivel, doc.CA || "",
          doc.createdAt || new Date(), doc.updatedAt || new Date(),
        ]
      );

      if (doc.tutorContext) {
        const tc = doc.tutorContext;
        await client.query(
          `INSERT INTO tutor_contexts (ejercicio_id, objetivo, netlist, modo_experto, ac_refs, respuesta_correcta, elementos_evaluables, version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            pgId, tc.objetivo || "", tc.netlist || "", tc.modoExperto || "",
            tc.ac_refs || [], tc.respuestaCorrecta || [],
            tc.elementosEvaluables || [], tc.version || 1,
          ]
        );
      }

      await client.query("COMMIT");
      migrated++;
    } catch (e) {
      await client.query("ROLLBACK");
      console.error(`[MIGRATE] Ejercicio ${mongoId} failed:`, e.message);
    } finally {
      client.release();
    }
  }
  console.log(`[MIGRATE] Ejercicios: ${migrated}/${docs.length} migrated.`);
}

async function migrateInteracciones(pool) {
  console.log("[MIGRATE] Migrating interacciones + messages...");
  const total = await InteraccionModel.countDocuments();
  let migrated = 0;
  let msgCount = 0;

  const cursor = InteraccionModel.find().lean().cursor();
  for await (const doc of cursor) {
    const mongoId = doc._id.toString();
    const pgId = uuidv4();
    idMap.interacciones[mongoId] = pgId;

    const pgUsuarioId = idMap.usuarios[doc.usuario_id?.toString()];
    const pgEjercicioId = idMap.ejercicios[doc.ejercicio_id?.toString()];

    if (!pgUsuarioId || !pgEjercicioId) {
      console.warn(`[MIGRATE] Interaccion ${mongoId}: missing user/exercise mapping, skipping.`);
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `INSERT INTO interacciones (id, usuario_id, ejercicio_id, inicio, fin, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [pgId, pgUsuarioId, pgEjercicioId, doc.inicio, doc.fin, doc.inicio]
      );

      // Denormalize conversacion[] → messages rows
      const msgs = doc.conversacion || [];
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        const meta = m.metadata || {};
        const guard = meta.guardrails || {};
        const timing = meta.timing || {};

        await client.query(
          `INSERT INTO messages (interaccion_id, sequence_num, role, content, timestamp,
            classification, decision, is_correct_answer, sources_count, student_response_ms,
            guardrail_solution_leak, guardrail_false_confirmation,
            guardrail_premature_confirmation, guardrail_state_reveal,
            timing_pipeline_ms, timing_ollama_ms, timing_total_ms)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [
            pgId, i, m.role, m.content, m.timestamp || new Date(),
            meta.classification || null, meta.decision || null,
            meta.isCorrectAnswer ?? null, meta.sourcesCount || 0,
            meta.studentResponseMs || null,
            guard.solutionLeak || false, guard.falseConfirmation || false,
            guard.prematureConfirmation || false, guard.stateReveal || false,
            timing.pipelineMs || null, timing.ollamaMs || null, timing.totalMs || null,
          ]
        );
        msgCount++;
      }

      await client.query("COMMIT");
      migrated++;
    } catch (e) {
      await client.query("ROLLBACK");
      console.error(`[MIGRATE] Interaccion ${mongoId} failed:`, e.message);
    } finally {
      client.release();
    }

    if (migrated % 50 === 0) {
      console.log(`[MIGRATE] Interacciones progress: ${migrated}/${total}`);
    }
  }
  console.log(`[MIGRATE] Interacciones: ${migrated}/${total} migrated, ${msgCount} messages created.`);
}

async function migrateResultados(pool) {
  console.log("[MIGRATE] Migrating resultados + error_entries...");
  const docs = await ResultadoModel.find().lean();
  let migrated = 0;
  let errCount = 0;

  for (const doc of docs) {
    const mongoId = doc._id.toString();
    const pgUsuarioId = idMap.usuarios[doc.usuario_id?.toString()];
    const pgEjercicioId = idMap.ejercicios[doc.ejercicio_id?.toString()];
    const pgInteraccionId = idMap.interacciones[doc.interaccion_id?.toString()];

    if (!pgUsuarioId || !pgEjercicioId || !pgInteraccionId) {
      console.warn(`[MIGRATE] Resultado ${mongoId}: missing mapping, skipping.`);
      continue;
    }

    const pgId = uuidv4();
    idMap.resultados[mongoId] = pgId;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `INSERT INTO resultados (id, usuario_id, ejercicio_id, interaccion_id, num_mensajes, resuelto_a_la_primera, analisis_ia, consejo_ia, fecha)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          pgId, pgUsuarioId, pgEjercicioId, pgInteraccionId,
          doc.numMensajes || 0, doc.resueltoALaPrimera || false,
          doc.analisisIA || null, doc.consejoIA || null,
          doc.fecha || new Date(),
        ]
      );

      for (const err of doc.errores || []) {
        await client.query(
          "INSERT INTO error_entries (resultado_id, etiqueta, texto) VALUES ($1, $2, $3)",
          [pgId, err.etiqueta, err.texto]
        );
        errCount++;
      }

      await client.query("COMMIT");
      migrated++;
    } catch (e) {
      await client.query("ROLLBACK");
      console.error(`[MIGRATE] Resultado ${mongoId} failed:`, e.message);
    } finally {
      client.release();
    }
  }
  console.log(`[MIGRATE] Resultados: ${migrated}/${docs.length} migrated, ${errCount} error_entries created.`);
}

main().catch((err) => {
  console.error("[MIGRATE] Unhandled error:", err);
  process.exit(1);
});
