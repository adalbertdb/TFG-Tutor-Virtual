# Docker Deployment Guide — Tutor Socratico (Dokploy)

Despliegue en servidor Ubuntu con Dokploy y GitHub.

---

## 1. Prerrequisitos

```bash
# Docker + Docker Compose
sudo apt update
sudo apt install -y docker.io docker-compose-v2

# Iniciar Docker
sudo systemctl enable --now docker
```

---

## 2. Instalar Dokploy

```bash
curl -sSL https://dokploy.com/install.sh | bash
```

Accede a la UI de Dokploy:
```
http://<IP_DEL_SERVIDOR>:3000
```

Configura la cuenta admin en la primera visita.

---

## 3. Configurar GitHub en Dokploy

1. Ve a **Git Sources** en Dokploy
2. Añade tu cuenta GitHub (o la organizacion)
3. Autoriza a Dokploy a acceder al repositorio `irenemg8/TFG-Tutor-Virtual`

---

## 4. Crear el proyecto en Dokploy

### 4.1 Crear Docker Compose

1. Ve a **Projects** → **Create Project**
2. Selecciona **Docker Compose**
3. Nombre: `tutor-socratico`
4. Source: Selecciona tu repo de GitHub
5. Branch: `main`
6. Compose Path: `docker-compose.yml`
7. Guarda

### 4.2 Variables de entorno

Ve a la pestaña **Environment** del proyecto y añade todas las variables del archivo `.env.example`:

| Variable | Valor ejemplo | Requerido |
|---|---|---|
| `PG_USER` | `tutor` | Si |
| `PG_PASSWORD` | *(generar)* | **Si** |
| `PG_DB` | `tutorvirtual` | Si |
| `SESSION_SECRET` | *(generar)* | **Si** |
| `OAUTH_CLIENT_SECRET` | *(proporcionado por CAS)* | **Si** |
| `VITE_BASE_PATH` | *(vacio)* | No |
| `VITE_BACKEND_URL` | *(vacio)* | No |

Generar secrets:
```bash
openssl rand -hex 32  # SESSION_SECRET
openssl rand -hex 16  # PG_PASSWORD
```

Dokploy guarda estas variables en un archivo `.env` junto al `docker-compose.yml`.

### 4.3 Configurar dominio

Ve a la pestaña **Domains**:

1. Click **Add Domain**
2. Host: `tutor-socratico.gnd.upv.es`
3. Service: `app` (el contenedor que expone puerto 3001)
4. Port: `3001`
5. Guarda

Dokploy añade automaticamente:
- Labels de Traefik para el routing
- HTTPS con Let's Encrypt
- Redireccion HTTP → HTTPS

**No añadir labels de Traefik manualmente** en el `docker-compose.yml`.

### 4.4 Auto Deploy (opcional pero recomendado)

Ve a la pestaña **Deployments** → **Auto Deploy**:

1. Copia la URL del webhook
2. En GitHub repo → Settings → Webhooks → Add webhook
3. Payload URL: *(la URL de Dokploy)*
4. Content type: `application/json`
5. Events: **Push**
6. Guarda

Ahora cada `git push` a `main` despliega automaticamente.

---

## 5. Primer despliegue

### 5.1 Deploy

En Dokploy, click **Deploy**.

Dokploy hará:
1. `git clone` del repo
2. `docker compose build`
3. `docker compose up -d`
4. Configurar Traefik con el dominio

### 5.2 Verificar

```bash
# Ver logs en Dokploy UI (pestaña Logs)
# O via SSH:
sudo docker logs tutor-socratico-app

# Health check interno
curl http://localhost:3001/api/health
```

### 5.3 Ingestar datos en ChromaDB (primera vez)

Desde Dokploy UI → pestaña **Advanced** → ejecutar comando:

```bash
node backend/src/infrastructure/vectordb/ingest.js
```

O via SSH:
```bash
sudo docker exec tutor-socratico-app node backend/src/infrastructure/vectordb/ingest.js
```

---

## 6. URLs del despliegue

| Servicio | URL |
|---|---|
| Frontend | `https://tutor-socratico.gnd.upv.es/` |
| API health | `https://tutor-socratico.gnd.upv.es/api/health` |
| Auth callback | `https://tutor-socratico.gnd.upv.es/api/auth/cas/callback` |

---

## 7. Flujo de trabajo con GitHub

```
Developer
    │
    ▼ git push main
┌─────────────┐
│   GitHub    │
└──────┬──────┘
       │ webhook
       ▼
┌─────────────┐
│   Dokploy   │
│  (Docker)   │
└──────┬──────┘
       │ git clone + build + up
       ▼
┌─────────────┐
│   Traefik   │  :443 HTTPS
└──────┬──────┘
       │
       ▼
┌─────────────┐
│    App      │
│  :3001      │
└──┬──────┬───┘
   │      │
   ▼      ▼
┌──────┐ ┌──────────┐
│  Pg  │ │ ChromaDB │
└──────┘ └──────────┘
```

**Cada push a main:**
1. GitHub envia webhook a Dokploy
2. Dokploy hace `git clone` del repo
3. `docker compose build` (usa cache si no hay cambios)
4. `docker compose up -d` (rolling update)
5. Traefik actualiza el routing

---

## 8. Comandos utiles

```bash
# Ver estado de contenedores
sudo docker compose ps

# Logs en vivo (desde Dokploy UI o SSH)
sudo docker logs -f tutor-socratico-app

# Reiniciar servicio
sudo docker restart tutor-socratico-app

# Ejecutar comando dentro del contenedor
sudo docker exec -it tutor-socratico-app sh

# Backup de PostgreSQL
sudo docker exec tutor-socratico-postgres pg_dump -U tutor tutorvirtual > backup.sql
```

---

## 9. Troubleshooting

### La app no arranca

```bash
# Ver logs
cd /opt/dokploy/applications/tutor-socratico/code && sudo docker compose logs app
```

### PostgreSQL no esta listo

El contenedor `app` espera a que Postgres pase el healthcheck. Si tarda, revisa logs:
```bash
sudo docker logs tutor-socratico-postgres
```

### ChromaDB vacio

```bash
sudo docker exec tutor-socratico-app node backend/src/infrastructure/vectordb/ingest.js
```

### Error de conexion a Ollama

```bash
sudo docker exec tutor-socratico-app wget -qO- https://ollama.gti-ia.upv.es:443/api/tags
```

### Traefik no enruta

1. Verificar dominio configurado en Dokploy UI (pestaña Domains)
2. Verificar que el contenedor `app` esta en la red `dokploy-network`
3. Ver logs de Traefik:
   ```bash
   sudo docker logs traefik
   ```

### Error de CAS OAuth2

Verificar que `OAUTH_REDIRECT_URI` coincide exactamente con la registrada en CAS:
```
https://tutor-socratico.gnd.upv.es/api/auth/cas/callback
```

---

## 10. Arquitectura

```
Internet
  │
  ▼
┌─────────────┐
│   Traefik   │  :443 HTTPS (gestionado por Dokploy)
│  (Docker)   │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│    App      │  :3001 (Docker Compose)
│  (Node.js)  │
└──┬──────┬───┘
   │      │
   ▼      ▼
┌──────┐ ┌──────────┐
│  Pg  │ │ ChromaDB │
└──────┘ └──────────┘
```

**Servicios externos:**
- **Ollama**: Cluster UPV (`ollama.gti-ia.upv.es`)
- **CAS UPV**: Autenticacion OAuth2
