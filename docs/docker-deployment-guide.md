# Docker Deployment Guide — Tutor Socratico

Despliegue en servidor Ubuntu local con Dockploy (Traefik).

---

## 1. Prerrequisitos

```bash
# Docker + Docker Compose
sudo apt update
sudo apt install -y docker.io docker-compose-v2

# Iniciar Docker
sudo systemctl enable --now docker

# (Opcional) Ejecutar docker sin sudo
sudo usermod -aG docker $USER
# Cerrar sesion y volver a entrar para que aplique
```

### Dockploy

Dockploy gestiona Traefik automaticamente. Asegurate de que Dockploy este instalado y funcionando en el servidor antes de desplegar.

---

## 2. Preparar el servidor

### 2.1 Clonar el repositorio

```bash
git clone https://github.com/irenemg8/TFG-Tutor-Virtual.git
cd TFG-Tutor-Virtual
```

### 2.2 Configurar variables de entorno

```bash
cp .env.example .env
nano .env
```

Valores obligatorios a cambiar:

| Variable | Descripcion |
|---|---|
| `PG_PASSWORD` | Contraseña para PostgreSQL |
| `SESSION_SECRET` | String aleatorio largo (`openssl rand -hex 32`) |
| `OAUTH_CLIENT_SECRET` | Proporcionado por el admin de CAS UPV |

### 2.3 Generar secrets

```bash
# Session secret
openssl rand -hex 32

# PostgreSQL password
openssl rand -hex 16
```

---

## 3. Desplegar con Dockploy

### 3.1 Build

```bash
sudo docker compose build
```

### 3.2 Iniciar servicios

```bash
sudo docker compose up -d
```

Dockploy detectara el contenedor `app` por las labels de Traefik y configurara automaticamente:
- HTTPS con certificado Let's Encrypt
- Routing para `tutor-socratico.gnd.upv.es`
- Headers de seguridad

### 3.3 Verificar

```bash
# Estado de contenedores
sudo docker compose ps

# Logs en vivo
sudo docker compose logs -f app

# Health check
curl http://localhost:3001/api/health
```

### 3.4 Ingestar datos en ChromaDB (primera vez)

```bash
sudo docker compose exec app node backend/src/infrastructure/vectordb/ingest.js
```

---

## 4. Traefik (gestionado por Dockploy)

No necesitas configurar Nginx ni Traefik manualmente. Dockploy gestiona:

- **Routing automatico** via labels Docker
- **HTTPS** con certresolver `letsencrypt`
- **Headers de seguridad** configurados en las labels

Si necesitas ajustar algo, modifica las labels `traefik.*` en `docker-compose.yml`.

### Verificar Traefik

```bash
# Ver rutas configuradas
sudo docker exec dockploy-traefik traefik healthcheck --ping

# O via dashboard (si esta habilitado)
# http://<servidor>:8080/dashboard/
```

---

## 5. Comandos utiles

```bash
# Ver logs
sudo docker compose logs -f app
sudo docker compose logs -f postgres
sudo docker compose logs -f chromadb

# Reiniciar un servicio
sudo docker compose restart app

# Detener todo
sudo docker compose down

# Detener + borrar volumenes (CUIDADO: borra datos)
sudo docker compose down -v

# Ejecutar comando dentro del contenedor
sudo docker compose exec app sh

# Reconstruir tras cambios de codigo
sudo docker compose build --no-cache && sudo docker compose up -d
```

---

## 6. Arquitectura

```
Internet
  │
  ▼
┌─────────────┐
│   Traefik   │  :443 (HTTPS) — gestionado por Dockploy
│  (Dockploy) │
└──────┬──────┘
       │ Docker labels
       ▼
┌─────────────┐
│    App      │  :3001 (interno)
│  (Node.js)  │  ← Sirve frontend estatico + API
└──┬──────┬───┘
   │      │
   ▼      ▼
┌──────┐ ┌──────────┐
│  Pg  │ │ ChromaDB │
│ :5432│ │  :8000   │
└──────┘ └──────────┘
```

**Servicios externos:**
- **Ollama**: Cluster UPV (`ollama.gti-ia.upv.es`) o local
- **CAS UPV**: Autenticacion OAuth2

---

## 7. Troubleshooting

### La app no arranca

```bash
sudo docker compose logs app
```

### PostgreSQL no esta listo

El contenedor `app` espera a que Postgres pase el healthcheck. Si tarda:

```bash
sudo docker compose logs postgres
```

### ChromaDB vacio

```bash
sudo docker compose exec app node backend/src/infrastructure/vectordb/ingest.js
```

### Error de conexion a Ollama

Verificar que `OLLAMA_API_URL_UPV` es accesible desde el contenedor:

```bash
sudo docker compose exec app wget -qO- https://ollama.gti-ia.upv.es:443/api/tags
```

### Error de CAS OAuth2

Verificar que `OAUTH_REDIRECT_URI` coincide exactamente con la registrada en CAS:

```
https://tutor-socratico.gnd.upv.es/api/auth/cas/callback
```

### Traefik no enruta el trafico

```bash
# Verificar que las labels estan aplicadas
sudo docker inspect tutor-socratico-app | grep -A 50 Labels

# Ver logs de Traefik
sudo docker logs dockploy-traefik 2>&1 | tail -50
```
