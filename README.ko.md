<h1 align="center">Codex Assistant</h1>

<p align="center">
  의존성 0개의 로컬 프록시 — <a href="https://github.com/openai/codex">Codex CLI</a>가 단일
  <code>base_url</code>로 <strong>DeepSeek</strong>, <strong>샤오미 MiMo</strong>, <strong>OpenAI</strong>와 통신하도록 합니다.
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
  <strong>한국어</strong> ·
  <a href="./README.es.md">Español</a>
</p>

---

Codex CLI는 **OpenAI Responses API**를, DeepSeek과 MiMo는 **Chat Completions**를 사용합니다.
Codex Assistant는 둘 사이를 양방향으로 변환합니다 — 스트리밍 SSE, 도구 호출, 사고 모드 라운드트립을 포함하여 — Codex 클라이언트를 패치하지 않고 지원되는 모든 모델을 사용할 수 있습니다.

## 기능

- **다중 공급자 라우팅** — 모델 이름으로 DeepSeek / MiMo / OpenAI 자동 선택
- **양방향 프로토콜 변환** — Responses API ↔ Chat Completions, 스트리밍 SSE 브리지 포함
- **공급자별 Reasoning Effort 변환** — Codex의 `none | minimal | low | medium | high | xhigh`를 각 업스트림의 네이티브 형식으로 매핑
- **사고 모드 + 도구 호출 라운드트립** — `reasoning_content`를 캐시·재생하여 DeepSeek의 사고 모드가 다중 턴 도구 호출에서도 유지됨
- **인바운드 인증** — `PROXY_AUTH_KEY` / `PROXY_KEYS`, 키 단위 공급자 잠금 가능
- **세션 연속성** — `previous_response_id`가 공급자 간에 작동 (LRU 제한 저장소)
- **내장 `web_fetch` 도구** — URL 다용 시나리오에서 샌드박스 제한 우회
- **도구 호출 회로 차단기** — 소프트 경고 + 하드 제거로 폭주 루프 방지
- **단일 파일, 무의존성** — `proxy.mjs` 1개 (~2000줄), `npm install` 불필요

## 빠른 시작

### 1. 설정

```bash
git clone https://github.com/wujfeng712-ui/Codex Assistant.git
cd Codex Assistant
cp env.example .env
```

`.env` 편집 (최소):

```bash
PROXY_AUTH_KEY=sk-proxy-local-$(openssl rand -hex 24)   # 자동 생성
DEEPSEEK_API_KEY=sk-...                                  # platform.deepseek.com에서 발급
```

### 2. 프록시 시작

```bash
node --env-file=.env proxy.mjs
```

> Node 18–19 또는 백그라운드 모드가 필요한가요? [Advanced Usage](#advanced-usage) 참조.

### 3. Codex CLI를 프록시로 가리키기

`~/.codex/config.toml` 편집:

```toml
model = "deepseek-v4-flash"
model_provider = "local_proxy"

[model_providers.local_proxy]
name = "local_proxy"
base_url = "http://127.0.0.1:4000/v1"
wire_api = "responses"
requires_openai_auth = true
```

Codex 인증 키 설정:

```bash
# ~/.codex/auth.json
{ "OPENAI_API_KEY": "<.env의 PROXY_AUTH_KEY와 동일>" }
```

> **[CC Switch](https://github.com/farion1231/cc-switch) 사용 중이신가요?** 수동 편집 대신 GUI에서 공급자를 추가하세요. [CC Switch와 함께 사용하기](#cc-switch와-함께-사용하기) 참조.

`codex` 실행 — 완료.

## 아키텍처

```
┌─────────────┐    Responses API    ┌──────────────┐
│  Codex CLI  │────────────────────▶│ Codex Assistant │
│             │  Authorization:     │    :4000     │
└─────────────┘  Bearer <key>       └──────┬───────┘
                                           │  모델 이름 기반 라우팅
                   ┌───────────────────────┼────────────────────────┐
                   │                       │                        │
                   ▼                       ▼                        ▼
          ┌────────────────┐      ┌────────────────┐       ┌──────────────┐
          │   DeepSeek V4  │      │  Xiaomi MiMo   │       │    OpenAI    │
          │ Chat Complet.  │      │ Chat Complet.  │       │  Responses   │
          └────────────────┘      └────────────────┘       └──────────────┘
```

## 설정

모든 설정은 환경 변수로 (전체 설명은 `env.example` 참조):

### 인증

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PROXY_AUTH_KEY` | — | 단일 인바운드 키 (공급자 잠금 없음) |
| `PROXY_KEYS` | — | 다중 키 표: `<key>:<provider>,...`, provider ∈ `deepseek` / `mimo` / `openai` / `*` |

둘 다 비어 있음 = 인증 비활성화 (권장하지 않음).

### 업스트림 공급자

| 변수 | 기본값 | 설명 |
|---|---|---|
| `DEEPSEEK_API_KEY` | — | DeepSeek 업스트림 키 |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com/v1` | DeepSeek base URL |
| `DEEPSEEK_MODELS` | `deepseek-v4-pro,deepseek-v4-flash` | 노출할 모델 목록 |
| `MIMO_API_KEY` | — | Xiaomi MiMo 업스트림 키 |
| `MIMO_BASE_URL` | `https://token-plan-cn.xiaomimimo.com/v1` | MiMo base URL |
| `MIMO_MODELS` | `mimo-v2.5-pro` | 노출할 모델 목록 (**소문자 필수**) |
| `OPENAI_API_KEY` | — | OpenAI 업스트림 키 (선택) |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI base URL |
| `OPENAI_MODELS` | — | 명시적 OpenAI 모델 목록 |
| `OPENAI_MODEL_PREFIXES` | `gpt-,o1,o3,o4,codex-,chatgpt-` | 휴리스틱 라우팅 접두사 |

### 모델 카탈로그

| 변수 | 기본값 | 설명 |
|---|---|---|
| `MODEL_CATALOG_PATH` | — | `proxy-models.json` 경로. 위 `*_MODELS` 변수를 덮어씀. Codex가 `model_catalog_json`으로 읽는 동일 파일 |

### 튜닝

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PROXY_PORT` | `4000` | 리스닝 포트 |
| `DEFAULT_PROVIDER` | auto | 모델 미상 시 폴백 |
| `LOG_LEVEL` | `info` | `silent` / `error` / `warn` / `info` / `debug` |
| `ACCESS_LOG` | on | `0`으로 설정하면 요청별 액세스 로그 억제 |
| `UPSTREAM_TIMEOUT_MS` | `120000` | 업스트림 요청 타임아웃 |
| `STORE_TTL_MS` | `3600000` | 응답 저장소 항목 TTL |
| `STORE_MAX` | `500` | 응답 저장소 LRU 용량 |
| `GITHUB_TOKEN` | — | 선택, 미설정 시 `gh auth token` 지연 호출 |

## 라우팅 규칙

각 요청은 모델 이름으로 다음 우선순위에 따라 라우팅됩니다:

1. **정확 일치** — `DEEPSEEK_MODELS` / `MIMO_MODELS` / `OPENAI_MODELS`에 모델 등장
2. **접두사 휴리스틱** — `OPENAI_MODEL_PREFIXES` 항목으로 시작 → OpenAI
3. **이름 힌트** — `deepseek` 또는 `mimo` 포함 → 해당 공급자
4. **폴백** — `DEFAULT_PROVIDER`, 그 다음 키가 설정된 첫 공급자

## Reasoning Effort 변환

Codex는 `none | minimal | low | medium | high | xhigh`를 전송합니다. 각 업스트림의 허용 범위는 다릅니다:

| Codex effort | DeepSeek | MiMo | OpenAI |
|---|---|---|---|
| `none` | `thinking: {type: "disabled"}` | `thinking: {type: "disabled"}` | 필드 제거 |
| `minimal` | `reasoning_effort: "low"` | `reasoning_effort: "low"` | 패스스루 |
| `low` / `medium` / `high` | 패스스루 | 패스스루 | 패스스루 |
| `xhigh` | `reasoning_effort: "xhigh"` | `high`로 클램프 | `high`로 클램프 |

> **참고:** DeepSeek은 `enable_thinking: false`를 조용히 무시합니다. 본 프록시는 대신 `thinking: {type: "disabled"}`를 사용합니다.

## 엔드포인트

| 메서드 | 경로 | 인증 | 설명 |
|---|---|---|---|
| `GET` | `/health` | 불필요 | 헬스 체크 |
| `GET` | `/v1/models` | 필요 | 병합된 모델 목록 |
| `POST` | `/v1/responses` | 필요 | Codex CLI 메인 엔드포인트 (Responses API) |
| `POST` | `/v1/chat/completions` | 필요 | Chat Completions 패스스루 |
| `GET` | `/cop?url=...` | 필요 | URL 가져오기 (Jina Reader / 네이티브 HTTP) |
| `POST` | `/cop` | 필요 | 사용자 정의 method/headers/body로 URL 가져오기 |

## 스모크 테스트

```bash
./scripts/smoke.sh                    # 기본 localhost:4000
./scripts/smoke.sh http://host:4000   # 사용자 지정 대상
MODEL=mimo-v2.5-pro ./scripts/smoke.sh  # 다른 모델 테스트
```

엔드포인트, 입력 형태, 인증 게이트, 스트리밍 완료, effort 변환, 도구 호출 라운드트립, 공급자 잠금을 포함한 30개 항목 검사.

## CC Switch와 함께 사용하기

[CC Switch](https://github.com/farion1231/cc-switch)는 여러 AI CLI 도구(Claude Code, Codex, Gemini CLI 등)의 공급자 설정을 원클릭으로 관리·전환하는 인기 데스크톱 앱입니다.

### 설정

1. CC Switch 열기 → **Codex** 탭 → **공급자 추가**
2. 공급자 정보 입력:

   | 필드 | 값 |
   |---|---|
   | 이름 | `Codex Assistant` (원하는 라벨) |
   | API Key | `.env`의 `PROXY_AUTH_KEY` |
   | Base URL | `http://127.0.0.1:4000/v1` |

3. **활성화** 클릭 — CC Switch가 `~/.codex/auth.json` 작성 및 `config.toml` 업데이트를 자동 수행합니다.

### 다중 공급자 전환

여러 업스트림 키(예: DeepSeek용, MiMo용)가 있는 경우, `.env`의 `PROXY_KEYS`로 공급자별 인바운드 키를 생성합니다:

```bash
PROXY_KEYS=sk-deepseek-aaa:deepseek,sk-mimo-bbb:mimo,sk-all-ccc:*
```

각 키에 대해 CC Switch 프로필을 만들면, 프로필 전환으로 Codex Assistant의 라우팅 대상이 바뀝니다.

### CLI 대안

터미널을 선호한다면 [cc-switch-cli](https://github.com/SaladDay/cc-switch-cli)로 GUI 없이 프로필을 전환할 수 있습니다:

```bash
# 프로필 목록
cc-switch list

# Codex Assistant 프로필로 전환
cc-switch use Codex Assistant
```

> **팁:** 프로필 전환 후 터미널을 재시작하거나 새 셸에서 `codex`를 실행해야 새 인증이 적용됩니다.

## Advanced Usage

- **Node 18–19 시작** — `--env-file`은 Node 20에서 추가됨. 이전 버전에서는:
  ```bash
  set -a && source .env && set +a && node proxy.mjs
  ```
- **백그라운드 모드**:
  ```bash
  nohup node --env-file=.env proxy.mjs > /tmp/Codex Assistant.log 2>&1 &
  ```
- **다중 키 공급자 잠금** — 각 인바운드 키를 특정 공급자에 고정. 다중 프로파일 설정용. `PROXY_KEYS` 형식은 `env.example` 참조.
- **모델 카탈로그 단일 출처** — `MODEL_CATALOG_PATH`를 Codex의 `model_catalog_json`과 동일 JSON에 가리켜 모델 목록 자동 동기화.

## 문제 해결

| 증상 | 원인 | 해결 |
|---|---|---|
| `EADDRINUSE :4000` | 포트 사용 중 | `lsof -ti:4000 \| xargs kill` 또는 `.env`에서 `PROXY_PORT` 변경 |
| `401 Unauthorized` | 인증 키 불일치 | `~/.codex/auth.json`의 `OPENAI_API_KEY`가 `.env`의 `PROXY_AUTH_KEY`와 일치하는지 확인 |
| `--env-file: not recognized` | Node.js < 20 | `set -a && source .env && set +a && node proxy.mjs` 사용 |
| 업스트림 타임아웃 | 공급자 응답 지연 | `.env`에서 `UPSTREAM_TIMEOUT_MS` 증가 (기본 120 000 ms) |
| 모델을 찾을 수 없음 | `*_MODELS`에 미등록 | `DEEPSEEK_MODELS` / `MIMO_MODELS` / `OPENAI_MODELS`에 추가하거나 `MODEL_CATALOG_PATH` 사용 |

## 요구사항

- Node.js 18+
- macOS / Linux / Windows
- 업스트림 API 키 최소 1개 (DeepSeek, MiMo 또는 OpenAI)

## 라이선스

MIT — [LICENSE](./LICENSE) 참조.
