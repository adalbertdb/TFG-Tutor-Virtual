"use strict";

const config = require("./config/environment");

/**
 * Dependency Injection Container.
 * Wires all ports to their concrete implementations based on DATABASE_TYPE.
 * Supports: "mongodb", "postgresql", "dual-write" (migration mode).
 *
 * Usage:
 *   const container = require('./container');
 *   await container.initialize();
 *   const { usuarioRepo, messageRepo, orchestrator, ... } = container;
 */

const container = {
  _initialized: false,

  // Repositories (ports)
  usuarioRepo: null,
  ejercicioRepo: null,
  interaccionRepo: null,
  messageRepo: null,
  resultadoRepo: null,

  // Domain services (ports)
  securityService: null,
  llmService: null,
  guardrailPipeline: null,
  kgConceptPatterns: [],

  // Agent system
  orchestrator: null,
  agents: null,

  async initialize() {
    if (this._initialized) return;

    const dbType = config.DATABASE_TYPE;
    console.log(`[Container] Initializing with DATABASE_TYPE=${dbType}`);

    if (dbType === "mongodb") {
      await this._initMongoDB();
    } else if (dbType === "postgresql") {
      await this._initPostgreSQL();
    } else if (dbType === "dual-write") {
      await this._initDualWrite();
    } else {
      throw new Error(`Unknown DATABASE_TYPE: ${dbType}`);
    }

    // DB-independent adapters
    const HeuristicSecurityAdapter = require("./infrastructure/security/HeuristicSecurityAdapter");
    const { emitEvent } = require("./infrastructure/events/ragEventBus");
    this.securityService = new HeuristicSecurityAdapter({
      logger: function (event, payload) { emitEvent(event, "end", payload); },
    });

    // LLM adapter (port: ILlmService)
    const OllamaLlmAdapter = require("./infrastructure/llm/OllamaLlmAdapter");
    this.llmService = new OllamaLlmAdapter();

    // Load KG concept patterns (same as ragMiddleware does at boot)
    const { loadKG, getAllEntries } = require("./infrastructure/search/knowledgeGraph");
    const { loadConceptPatternsFromKG } = require("./domain/services/rag/guardrails");
    try {
      loadKG();
      this.kgConceptPatterns = loadConceptPatternsFromKG(getAllEntries());
      console.log("[Container] Loaded " + this.kgConceptPatterns.length + " KG concept patterns");
    } catch (err) {
      console.warn("[Container] KG concept patterns not available:", err.message);
    }

    // Guardrail pipeline (NEW: parallel + surgical-first + consolidated retry + budget)
    const { createDefaultGuardrails } = require("./infrastructure/guardrails");
    const GuardrailPipeline = require("./domain/services/GuardrailPipeline");
    const trace = require("./infrastructure/events/pipelineDebugLogger");
    this.guardrailPipeline = new GuardrailPipeline({
      guardrails: createDefaultGuardrails(),
      llmService: this.llmService,
      budgetMs: Number(process.env.GUARDRAIL_BUDGET_MS || 45000),
      minRetryBudgetMs: Number(process.env.GUARDRAIL_MIN_RETRY_BUDGET_MS || 10000),
      logger: trace,
    });

    // Build agent registry + orchestrator
    const { createAgentRegistry } = require("./domain/agents/agentRegistry");
    const TutoringOrchestrator = require("./domain/agents/orchestrator");
    const { classifyQuery } = require("./domain/services/rag/queryClassifier");
    const { runFullPipeline } = require("./domain/services/rag/ragPipeline");
    const { buildTutorSystemPrompt } = require("./domain/services/promptBuilder");
    const { logInteraction } = require("./infrastructure/llm/logger");
    const ragConfig = require("./infrastructure/llm/config");

    this.agents = createAgentRegistry({
      ejercicioRepo: this.ejercicioRepo,
      interaccionRepo: this.interaccionRepo,
      messageRepo: this.messageRepo,
      llmService: this.llmService,
      guardrailPipeline: this.guardrailPipeline,
      kgConceptPatterns: this.kgConceptPatterns,
      classifyQuery: classifyQuery,
      runFullPipeline: runFullPipeline,
      securityService: this.securityService,
      buildSystemPrompt: buildTutorSystemPrompt,
      logInteraction: logInteraction,
      emitEvent: emitEvent,
      config: ragConfig,
    });
    this.orchestrator = new TutoringOrchestrator(this.agents, { emitEvent: emitEvent });

    this._initialized = true;
    console.log("[Container] Initialization complete");
  },

  async _initMongoDB() {
    const { connectMongoDB } = require("./config/database");
    await connectMongoDB();

    const MongoUsuarioRepository = require("./infrastructure/persistence/mongodb/MongoUsuarioRepository");
    const MongoEjercicioRepository = require("./infrastructure/persistence/mongodb/MongoEjercicioRepository");
    const MongoInteraccionRepository = require("./infrastructure/persistence/mongodb/MongoInteraccionRepository");
    const MongoMessageRepository = require("./infrastructure/persistence/mongodb/MongoMessageRepository");
    const MongoResultadoRepository = require("./infrastructure/persistence/mongodb/MongoResultadoRepository");

    this.usuarioRepo = new MongoUsuarioRepository();
    this.ejercicioRepo = new MongoEjercicioRepository();
    this.interaccionRepo = new MongoInteraccionRepository();
    this.messageRepo = new MongoMessageRepository();
    this.resultadoRepo = new MongoResultadoRepository();
  },

  async _initPostgreSQL() {
    const { createPool, runMigrations } = require("./infrastructure/persistence/postgresql/PgConnection");
    const pool = createPool(config.PG_CONNECTION_STRING);
    await pool.query("SELECT 1");
    await runMigrations(pool);

    const PgUsuarioRepository = require("./infrastructure/persistence/postgresql/PgUsuarioRepository");
    const PgEjercicioRepository = require("./infrastructure/persistence/postgresql/PgEjercicioRepository");
    const PgInteraccionRepository = require("./infrastructure/persistence/postgresql/PgInteraccionRepository");
    const PgMessageRepository = require("./infrastructure/persistence/postgresql/PgMessageRepository");
    const PgResultadoRepository = require("./infrastructure/persistence/postgresql/PgResultadoRepository");

    this.usuarioRepo = new PgUsuarioRepository(pool);
    this.ejercicioRepo = new PgEjercicioRepository(pool);
    this.interaccionRepo = new PgInteraccionRepository(pool);
    this.messageRepo = new PgMessageRepository(pool);
    this.resultadoRepo = new PgResultadoRepository(pool);
  },

  async _initDualWrite() {
    // MongoDB is primary (reads), PostgreSQL is secondary (writes mirrored)
    const { connectMongoDB } = require("./config/database");
    await connectMongoDB();

    const { createPool, runMigrations } = require("./infrastructure/persistence/postgresql/PgConnection");
    const pool = createPool(config.PG_CONNECTION_STRING);
    await pool.query("SELECT 1");
    await runMigrations(pool);

    const { createDualWriteProxy } = require("./infrastructure/persistence/postgresql/DualWriteRepository");

    // MongoDB repos (primary)
    const MongoUsuarioRepository = require("./infrastructure/persistence/mongodb/MongoUsuarioRepository");
    const MongoEjercicioRepository = require("./infrastructure/persistence/mongodb/MongoEjercicioRepository");
    const MongoInteraccionRepository = require("./infrastructure/persistence/mongodb/MongoInteraccionRepository");
    const MongoMessageRepository = require("./infrastructure/persistence/mongodb/MongoMessageRepository");
    const MongoResultadoRepository = require("./infrastructure/persistence/mongodb/MongoResultadoRepository");

    // PostgreSQL repos (secondary)
    const PgUsuarioRepository = require("./infrastructure/persistence/postgresql/PgUsuarioRepository");
    const PgEjercicioRepository = require("./infrastructure/persistence/postgresql/PgEjercicioRepository");
    const PgInteraccionRepository = require("./infrastructure/persistence/postgresql/PgInteraccionRepository");
    const PgMessageRepository = require("./infrastructure/persistence/postgresql/PgMessageRepository");
    const PgResultadoRepository = require("./infrastructure/persistence/postgresql/PgResultadoRepository");

    const mongoUsuario = new MongoUsuarioRepository();
    const mongoEjercicio = new MongoEjercicioRepository();
    const mongoInteraccion = new MongoInteraccionRepository();
    const mongoMessage = new MongoMessageRepository();
    const mongoResultado = new MongoResultadoRepository();

    const pgUsuario = new PgUsuarioRepository(pool);
    const pgEjercicio = new PgEjercicioRepository(pool);
    const pgInteraccion = new PgInteraccionRepository(pool);
    const pgMessage = new PgMessageRepository(pool);
    const pgResultado = new PgResultadoRepository(pool);

    // Dual-write proxies: writes go to both, reads from MongoDB
    this.usuarioRepo = createDualWriteProxy(
      mongoUsuario, pgUsuario,
      ["create", "upsertByUpvLogin", "updateById"]
    );
    this.ejercicioRepo = createDualWriteProxy(
      mongoEjercicio, pgEjercicio,
      ["create", "updateById", "deleteById"]
    );
    this.interaccionRepo = createDualWriteProxy(
      mongoInteraccion, pgInteraccion,
      ["create", "deleteById", "updateFin"]
    );
    this.messageRepo = createDualWriteProxy(
      mongoMessage, pgMessage,
      ["appendMessage"]
    );
    this.resultadoRepo = createDualWriteProxy(
      mongoResultado, pgResultado,
      ["create"]
    );

    console.log("[Container] Dual-write mode: MongoDB (primary) + PostgreSQL (secondary)");
  },
};

module.exports = container;
