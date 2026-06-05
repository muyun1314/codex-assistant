<h1 align="center">Codex Assistant</h1>

<p align="center">
  Proxy local sin dependencias que permite a <a href="https://github.com/openai/codex">Codex CLI</a>
  comunicarse con <strong>DeepSeek</strong>, <strong>Xiaomi MiMo</strong> y <strong>OpenAI</strong> a través de una única
  <code>base_url</code>.
</p>

<p align="center">
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-18%2B-339933?logo=node.js&logoColor=white" alt="Node.js 18+"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="Zero Dependencies">
</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.zh-CN.md">简体中文</a> ·
  <a href="./README.ja.md">日本語</a> ·
  <a href="./README.ko.md">한국어</a> ·
  <strong>Español</strong>
</p>

---

Codex CLI usa la **OpenAI Responses API**. DeepSeek y MiMo usan **Chat Completions**.
Codex Assistant traduce entre ambos en las dos direcciones — incluyendo SSE en streaming, llamadas a herramientas y rondas de modo de pensamiento — para que puedas usar cualquier modelo compatible dentro de Codex sin parchear el cliente.

## Características

- **Enrutamiento multi-proveedor** — DeepSeek / MiMo / OpenAI, seleccionados automáticamente por nombre de modelo
- **Traducción bidireccional de protocolos** — Responses API ↔ Chat Completions con puente SSE en streaming
- **Traducción de reasoning effort por proveedor** — `none | minimal | low | medium | high | xhigh` de Codex mapeados al formato nativo de cada upstream
- **Ronda de modo de pensamiento + tool calls** — almacena en caché y retransmite `reasoning_content` para que el modo de pensamiento de DeepSeek sobreviva a llamadas a herramientas multi-turno
- **Puerta de autenticación entrante** — `PROXY_AUTH_KEY` / `PROXY_KEYS` con bloqueo opcional de proveedor por clave
- **Continuidad de sesión** — `previous_response_id` funciona entre proveedores (almacén con LRU acotado)
- **Herramienta `web_fetch` integrada** — evita restricciones de sandbox en conversaciones intensivas en URLs
- **Cortocircuito de tool calls** — aviso suave + eliminación dura ante bucles desbocados de herramientas
- **Archivo único, sin dependencias** — un solo `proxy.mjs` (~2000 líneas), sin `npm install`

## Inicio rápido

### 1. Configurar

```bash
git clone https://github.com/muyun1314/Codex Assistant.git
cd Codex Assistant
cp env.example .env
```

Edita `.env` — al mínimo:

```bash
PROXY_AUTH_KEY=sk-proxy-local-$(openssl rand -hex 24)   # generar uno
DEEPSEEK_API_KEY=sk-...                                  # desde platform.deepseek.com
```

### 2. Iniciar el proxy

```bash
node --env-file=.env proxy.mjs
```

> ¿Necesitas Node 18–19 o modo en segundo plano? Consulta [Uso avanzado](#uso-avanzado).

### 3. Apuntar Codex CLI al proxy

Edita `~/.codex/config.toml`:

```toml
model = "deepseek-v4-flash"
model_provider = "local_proxy"

[model_providers.local_proxy]
name = "local_proxy"
base_url = "http://127.0.0.1:4000/v1"
wire_api = "responses"
requires_openai_auth = true
```

Configura la clave de autenticación para Codex:

```bash
# ~/.codex/auth.json
{ "OPENAI_API_KEY": "<misma PROXY_AUTH_KEY del .env>" }
```

> **¿Usas [CC Switch](https://github.com/farion1231/cc-switch)?** Omite la edición manual — añade un proveedor desde la GUI. Ver [Uso con CC Switch](#uso-con-cc-switch).

Ejecuta `codex` — listo.

## Arquitectura

```
┌─────────────┐    Responses API    ┌──────────────┐
│  Codex CLI  │────────────────────▶│ Codex Assistant │
│             │  Authorization:     │    :4000     │
└─────────────┘  Bearer <key>       └──────┬───────┘
                                           │  enrutado por nombre de modelo
                   ┌───────────────────────┼────────────────────────┐
                   │                       │                        │
                   ▼                       ▼                        ▼
          ┌────────────────┐      ┌────────────────┐       ┌──────────────┐
          │   DeepSeek V4  │      │  Xiaomi MiMo   │       │    OpenAI    │
          │ Chat Complet.  │      │ Chat Complet.  │       │  Responses   │
          └────────────────┘      └────────────────┘       └──────────────┘
```

## Configuración

Todos los ajustes mediante variables de entorno (documentación completa en `env.example`):

### Autenticación

| Variable | Por defecto | Descripción |
|---|---|---|
| `PROXY_AUTH_KEY` | — | Clave entrante única (sin bloqueo de proveedor) |
| `PROXY_KEYS` | — | Tabla multi-clave: `<key>:<provider>,...` donde provider ∈ `deepseek` / `mimo` / `openai` / `*` |

Ambas vacías = autenticación deshabilitada (no recomendado).

### Proveedores upstream

| Variable | Por defecto | Descripción |
|---|---|---|
| `DEEPSEEK_API_KEY` | — | Clave upstream de DeepSeek |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com/v1` | base URL de DeepSeek |
| `DEEPSEEK_MODELS` | `deepseek-v4-pro,deepseek-v4-flash` | Modelos a anunciar |
| `MIMO_API_KEY` | — | Clave upstream de Xiaomi MiMo |
| `MIMO_BASE_URL` | `https://token-plan-cn.xiaomimimo.com/v1` | base URL de MiMo |
| `MIMO_MODELS` | `mimo-v2.5-pro` | Modelos a anunciar (**deben ser minúsculas**) |
| `OPENAI_API_KEY` | — | Clave upstream de OpenAI (opt-in) |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | base URL de OpenAI |
| `OPENAI_MODELS` | — | Lista explícita de modelos OpenAI |
| `OPENAI_MODEL_PREFIXES` | `gpt-,o1,o3,o4,codex-,chatgpt-` | Prefijos heurísticos de enrutamiento |

### Catálogo de modelos

| Variable | Por defecto | Descripción |
|---|---|---|
| `MODEL_CATALOG_PATH` | — | Ruta a un `proxy-models.json`. Sobrescribe las variables `*_MODELS`. Mismo archivo que Codex lee vía `model_catalog_json` |

### Ajustes finos

| Variable | Por defecto | Descripción |
|---|---|---|
| `PROXY_PORT` | `4000` | Puerto de escucha |
| `DEFAULT_PROVIDER` | auto | Fallback cuando el modelo es desconocido |
| `LOG_LEVEL` | `info` | `silent` / `error` / `warn` / `info` / `debug` |
| `ACCESS_LOG` | on | Pon `0` para suprimir el log de acceso por petición |
| `UPSTREAM_TIMEOUT_MS` | `120000` | Timeout de la petición upstream |
| `STORE_TTL_MS` | `3600000` | TTL de entrada del response store |
| `STORE_MAX` | `500` | Capacidad LRU del response store |
| `GITHUB_TOKEN` | — | Opcional; cae a `gh auth token` de forma perezosa |

## Reglas de enrutamiento

Cada petición se enruta por nombre de modelo, en orden de prioridad:

1. **Coincidencia exacta** — el modelo aparece en `DEEPSEEK_MODELS`, `MIMO_MODELS` u `OPENAI_MODELS`
2. **Heurística de prefijo** — el modelo empieza por una entrada de `OPENAI_MODEL_PREFIXES` → OpenAI
3. **Pista por nombre** — el modelo contiene `deepseek` o `mimo` → proveedor correspondiente
4. **Fallback** — `DEFAULT_PROVIDER`, luego el primer proveedor con clave configurada

## Traducción de Reasoning Effort

Codex envía `none | minimal | low | medium | high | xhigh`. Cada upstream acepta un subconjunto distinto:

| Codex effort | DeepSeek | MiMo | OpenAI |
|---|---|---|---|
| `none` | `thinking: {type: "disabled"}` | `thinking: {type: "disabled"}` | campo eliminado |
| `minimal` | `reasoning_effort: "low"` | `reasoning_effort: "low"` | passthrough |
| `low` / `medium` / `high` | passthrough | passthrough | passthrough |
| `xhigh` | `reasoning_effort: "xhigh"` | recortado a `high` | recortado a `high` |

> **Nota:** DeepSeek ignora silenciosamente `enable_thinking: false`. El proxy usa `thinking: {type: "disabled"}` en su lugar.

## Endpoints

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| `GET` | `/health` | No | Health check |
| `GET` | `/v1/models` | Sí | Lista combinada de modelos |
| `POST` | `/v1/responses` | Sí | Endpoint principal de Codex CLI (Responses API) |
| `POST` | `/v1/chat/completions` | Sí | Passthrough directo de Chat Completions |
| `GET` | `/cop?url=...` | Sí | Fetch de URL (Jina Reader / HTTP nativo) |
| `POST` | `/cop` | Sí | Fetch de URL con method/headers/body personalizados |

## Smoke Test

```bash
./scripts/smoke.sh                    # usa localhost:4000 por defecto
./scripts/smoke.sh http://host:4000   # destino personalizado
MODEL=mimo-v2.5-pro ./scripts/smoke.sh  # probar otro modelo
```

Ejecuta 30 comprobaciones cubriendo endpoints, formas de entrada, puerta de auth, completado en streaming, traducción de effort, rondas de tool-call y bloqueo de proveedor.

## Uso con CC Switch

[CC Switch](https://github.com/farion1231/cc-switch) es una popular app de escritorio para gestionar y cambiar configuraciones de proveedores en múltiples herramientas CLI de IA (Claude Code, Codex, Gemini CLI, etc.) con un solo clic.

### Configuración

1. Abre CC Switch → pestaña **Codex** → **Añadir proveedor**
2. Rellena la información del proveedor:

   | Campo | Valor |
   |---|---|
   | Nombre | `Codex Assistant` (o cualquier etiqueta) |
   | API Key | Tu `PROXY_AUTH_KEY` del `.env` |
   | Base URL | `http://127.0.0.1:4000/v1` |

3. Haz clic en **Activar** — CC Switch escribe automáticamente en `~/.codex/auth.json` y actualiza `config.toml`.

### Cambio multi-proveedor

Si tienes múltiples claves upstream (ej. una para DeepSeek, otra para MiMo), usa `PROXY_KEYS` en `.env` para crear claves de entrada por proveedor:

```bash
PROXY_KEYS=sk-deepseek-aaa:deepseek,sk-mimo-bbb:mimo,sk-all-ccc:*
```

Luego crea un perfil de CC Switch para cada clave — al cambiar de perfil cambias a qué proveedor upstream enruta Codex Assistant.

### Alternativa por CLI

Si prefieres la terminal, [cc-switch-cli](https://github.com/SaladDay/cc-switch-cli) ofrece el mismo cambio de perfiles sin GUI:

```bash
# Listar perfiles
cc-switch list

# Cambiar al perfil Codex Assistant
cc-switch use Codex Assistant
```

> **Consejo:** Tras cambiar de perfil, reinicia tu terminal (o ejecuta `codex` en un nuevo shell) para que la nueva autenticación surta efecto.

## Uso avanzado

- **Arranque en Node 18–19** — `--env-file` se añadió en Node 20. En versiones anteriores:
  ```bash
  set -a && source .env && set +a && node proxy.mjs
  ```
- **Modo en segundo plano**:
  ```bash
  nohup node --env-file=.env proxy.mjs > /tmp/Codex Assistant.log 2>&1 &
  ```
- **Bloqueo de proveedor multi-clave** — asigna cada clave entrante a un proveedor concreto para configuraciones multi-perfil. Formato `PROXY_KEYS` en `env.example`.
- **Catálogo de modelos como fuente única** — apunta `MODEL_CATALOG_PATH` al mismo JSON que Codex usa (`model_catalog_json` en `config.toml`) para mantener las listas de modelos sincronizadas automáticamente.

## Solución de problemas

| Síntoma | Causa | Solución |
|---|---|---|
| `EADDRINUSE :4000` | Puerto en uso | `lsof -ti:4000 \| xargs kill` o cambia `PROXY_PORT` en `.env` |
| `401 Unauthorized` | Clave de auth no coincide | Verifica que `OPENAI_API_KEY` en `~/.codex/auth.json` coincide con `PROXY_AUTH_KEY` en `.env` |
| `--env-file: not recognized` | Node.js < 20 | Usa `set -a && source .env && set +a && node proxy.mjs` |
| Timeout upstream | Respuesta lenta del proveedor | Aumenta `UPSTREAM_TIMEOUT_MS` en `.env` (por defecto 120 000 ms) |
| Modelo no encontrado | Modelo no está en `*_MODELS` | Añádelo a `DEEPSEEK_MODELS` / `MIMO_MODELS` / `OPENAI_MODELS`, o usa `MODEL_CATALOG_PATH` |

## Requisitos

- Node.js 18+
- macOS / Linux / Windows
- Al menos una API key upstream (DeepSeek, MiMo u OpenAI)

## Licencia

MIT — ver [LICENSE](./LICENSE).
