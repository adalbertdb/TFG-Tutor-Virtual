// backend/src/index.js
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const fs = require("fs");

// Rutas




const userRoutes = require("./interfaces/http/routes/usuarios");
const ejerciciosRoutes = require("./interfaces/http/routes/ejercicios");
const interaccionesRoutes = require("./interfaces/http/routes/interacciones");
const ollamaChatRoutes = require("./interfaces/http/routes/ollamaChatRoutes");
const orchestratorMiddleware = require("./interfaces/http/middleware/orchestratorMiddleware");
const ragMiddleware = require("./interfaces/http/middleware/ragMiddleware");
const { setupWorkflowSocket } = require("./interfaces/sse/workflowSocket");
const container = require("./container");
const resultadoRoutes = require("./interfaces/http/routes/resultados");
const progresoRoutes = require("./interfaces/http/routes/progresoRoutes");
const exportRoutes = require("./interfaces/http/routes/exportRoutes");

// Auth (CAS + demo)
const { router: authRouter, requireAuth } = require("./interfaces/http/routes/auth");
const { globalAuth, requireRole } = require("./interfaces/http/middleware/authMiddleware");

const app = express();
console.log("✅ BACKEND INDEX CARGADO:", __filename);

// ====== SAFEGUARD: DEV_BYPASS_AUTH in production ======
if (
  process.env.DEV_BYPASS_AUTH === "true" &&
  process.env.NODE_ENV === "production"
) {
  console.error(
    "CRITICAL: DEV_BYPASS_AUTH is enabled in production. Refusing to start."
  );
  process.exit(1);
}

const port = Number(process.env.PORT || 3000);

// ✅ Si estás detrás de Nginx (HTTPS fuera), esto es obligatorio para cookies secure
app.set("trust proxy", 1);

// ====== CORS ======
app.use(
  cors({
    origin: [
      process.env.FRONTEND_BASE_URL || "http://localhost:5173",
      process.env.WORKFLOW_BASE_URL || "http://localhost:5174",
    ].map((u) => {
      try { return new URL(u).origin; } catch { return u; }
    }),
    credentials: true,
  })
);

// ====== Middlewares base ======
app.use(express.json());

// ====== Static (imágenes ejercicios) ======
// Tus imágenes están en: backend/src/static
const staticDir = path.join(__dirname, "static");
console.log("STATIC DIR =", staticDir);
console.log("STATIC EXISTS =", fs.existsSync(staticDir));
if (fs.existsSync(staticDir)) {
  console.log("STATIC FILES =", fs.readdirSync(staticDir).slice(0, 50));
}

// Endpoint de debug (NO está bajo /static para que no lo intercepte express.static)
app.get("/api/debug/static", (_req, res) => {
  res.json({
    ok: true,
    staticDir,
    exists: fs.existsSync(staticDir),
    files: fs.existsSync(staticDir) ? fs.readdirSync(staticDir).slice(0, 50) : [],
  });
});

// Servido real de estáticos
app.use("/static", express.static(staticDir, { fallthrough: false }));

// ====== Mongo ======
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("Conectado a MongoDB Atlas"))
  .catch((error) => console.error("Error al conectar a MongoDB:", error));

// ====== Sesión ======
app.use(
  session({
    name: "sid_irene",
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI }),
    cookie: {
      httpOnly: true,
      // ✅ secure=true en producción (HTTPS/Nginx).
      // En desarrollo local (DEV_BYPASS_AUTH=true), secure=false para que HTTP funcione.
      secure: process.env.DEV_BYPASS_AUTH !== "true",
      sameSite: "lax",
    },
  })
);

// ====== Healthcheck ======
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// ====== Auth ======
app.use(authRouter);

// ====== Global Auth Middleware (BEFORE all API routes) ======
// Rejects unauthenticated requests to all /api/* except whitelisted public routes.
// Sets req.userId and req.userRole from session (NEVER from client).
app.use("/api", globalAuth);

// ====== API ======
app.use("/api/usuarios", userRoutes);
app.use("/api/ejercicios", ejerciciosRoutes);
app.use("/api/interacciones", interaccionesRoutes);
// Orchestrator takes priority when USE_ORCHESTRATOR=1 (Phase 5 refactor).
// If disabled or unready it calls next() and ragMiddleware handles the request.
app.use("/api/ollama", orchestratorMiddleware);
app.use("/api/ollama", ragMiddleware);
app.use("/api/ollama", ollamaChatRoutes);
app.use("/api/progreso", progresoRoutes);
app.use("/api/resultados", resultadoRoutes);
app.use("/api/export", exportRoutes);

app.post("/api/llm/query", requireAuth, (req, res) => {
  res.json({ ok: true, user: req.session.user });
});

// ====== Servir FRONTEND (React build) ======
const frontendDist = path.join(__dirname, "..", "..", "frontend", "dist");
console.log("FRONTEND DIST =", frontendDist);

// Assets con caché largo; index.html sin caché
app.use(
  express.static(frontendDist, {
    immutable: true,
    maxAge: "365d",
    setHeaders: (res, filePath) => {
      if (filePath.endsWith("index.html")) {
        res.setHeader("Cache-Control", "no-store");
      }
    },
  })
);

// SPA fallback: NO capturar /api ni /static
app.get(/^\/(?!api\/|static\/).*/, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(frontendDist, "index.html"));
});

// ====== Arranque servidor HTTP interno (Nginx hará HTTPS fuera) ======
const server = app.listen(port, "0.0.0.0", () => {
  console.log(`✅ Backend (HTTP interno) escuchando en puerto ${port}`);

  // Initialize DI container for hex architecture (USE_ORCHESTRATOR=1 route)
  // Non-blocking: if it fails, the legacy ragMiddleware still serves requests.
  container.initialize()
    .then(() => {
      console.log("[Startup] Hex container ready. USE_ORCHESTRATOR=" + (process.env.USE_ORCHESTRATOR === "1" ? "ON" : "OFF"));
    })
    .catch((err) => {
      console.error("[Startup] Container initialization FAILED — orchestrator route disabled:", err.message);
    });

  // Warmup Ollama (no bloquea)
  const axios = require("axios");

  async function warmupOllamaUPV() {
    const upvUrl = process.env.OLLAMA_API_URL_UPV || process.env.OLLAMA_BASE_URL_UPV;
    if (!upvUrl) {
      console.log("[OLLAMA] Warmup SKIP (OLLAMA_API_URL_UPV no definido).");
      return;
    }

    const url = String(upvUrl).replace(/\/$/, "");
    const model = process.env.OLLAMA_MODEL || "qwen2.5:latest";
    const keepAlive = process.env.OLLAMA_KEEP_ALIVE || "60m";

    try {
      console.log("[OLLAMA] Warmup (UPV)...");
      await axios.post(
        `${url}/api/chat`,
        {
          model,
          stream: false,
          keep_alive: keepAlive,
          messages: [
            { role: "system", content: "Responde solo con OK." },
            { role: "user", content: "OK" },
          ],
          options: { num_predict: 1, temperature: 0 },
        },
        { timeout: 20000 }
      );
      console.log("[OLLAMA] Warmup OK (UPV)");
    } catch (e) {
      console.warn("[OLLAMA] Warmup FAILED (UPV):", e?.message || e);
    }
  }

  warmupOllamaUPV();
});

setupWorkflowSocket(server);
