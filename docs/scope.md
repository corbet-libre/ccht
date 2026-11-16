# ccht scope: cloud-AI apps on the user's own accounts

Status: draft spec, 2026-11-16 (lane L24, read-only inventory). No code, no Cloudflare
account change, no OAuth client was created for this document.

## Scope, in Julian's words

> ccht should also adopt cloudflare. The idea is for ccht to be uncomplicated and serve
> all the code necessary to build ai infused apps where the ai computation is done in
> the cloud and at the users behest who logs in with his accounts. ... Different
> browser UIs will have different needs, so ccht offers up components for reuse, so not
> every of our apps has to redesign the wheel.

Boundary kept from `AGENTS.md`: ccht owns login mechanisms and generic UI contracts and
components; apps own product flows, storage, prompts and authority. CareerVector rule
(`CLAUDE.md` section 1): a provider login authorizes a connector on a device, never the
app's identity; no BYOK, model picker or pricing in an app's own UX.

## Shape

```text
ccht
|-- Rust crate (rlib; features native, web)
|   |-- Conversation, Event, WireEvent, Prompt      conversation.rs  (ACP v1 schema)
|   |-- AuthState, Credential, CredentialsProvider  auth.rs
|   |-- Transport (Stdio, Socket)                   transport.rs
|   |-- DockManager                                 dock.rs
|   |-- SessionConfiguration                        configuration.rs
|   |-- native::{NativeClient, pool, session,       ACP agents: Codex, Claude, OpenCode
|   |            env, well_known, drivers}          drivers: CodexDeviceDriver, LoginDriver
|   `-- web.rs                                      Wasm bindings
|-- py/ (PyO3 binding of the Conversation model; not on PyPI yet)
`-- web/ (@corbet-labs/ccht, npm and JSR)
    |-- core        createConversation, sse, signals, dock, history, handoff, assistant
    |-- accounts    createAccounts  (rows from providers exposing `account`)
    |-- auth        generic login contract used by AccountConnection
    |-- agent       createBrowserAgent: in-page model/tool loop emitting ACP updates
    |-- providers   pollinations, builtin (Prompt API), webllm, openrouter (+OAuth PKCE),
    |               openai-compatible stream, json-tools, inspectProviders
    |-- tools       localTools, remoteMcp (MCP Streamable HTTP), mergeTools
    `-- components  AccountConnection AccountsButton AccountsPanel AssistantPanel
                    ChatDock Dock ProviderPicker StepConfig (+ sheet.ts, styling hooks)
```

Release: one `release` workflow dispatch on `main` builds crate, npm tgz and PyPI wheel
(`docs/releasing.md`); the wheel waits for the crate on crates.io; JSR is generated from
the npm archive. Tests: Rust unit and fixture tests (native fixture agent, browser-agent
fixtures), Vitest for every web module and component. Current version 0.3.3.

## User stories

| # | As | I want | So that |
| --- | --- | --- | --- |
| 1 | app developer | to drop in `AssistantPanel` plus `AccountsButton` | I do not rebuild chat or sign-in UI |
| 2 | app user | to sign in with my Cloudflare account in the browser | answers run on my free daily Workers AI allowance, not the app's bill |
| 3 | app user | to sign in with OpenRouter or Hugging Face | I can use my own credits where I have them |
| 4 | TUI user | to sign in with the same account from a terminal | the CLI works without a browser extension |
| 5 | app user | to see clearly when I am out of allowance (HTTP 429, code 3036) | I know to wait for 00:00 UTC or switch provider |
| 6 | app developer | one release line for web, Rust and TUI | all four apps update together by ranges |
| 7 | app user | the sign-in to authorize a connector, never the app account | nothing about the app identity changes (CareerVector rule) |

## Module map

| Capability | Rust | Web | Python | State |
| --- | --- | --- | --- | --- |
| Conversation model, replay | yes | yes (Wasm) | yes | has |
| ACP native agents | yes | n/a (server runs it) | no | has |
| Device login for Codex | yes (`CodexDeviceDriver`) | n/a | no | has |
| Browser agent, tools (MCP), handoff | n/a | yes | no | has |
| Keyless, built-in, WebLLM providers | n/a | yes | no | has |
| OpenRouter sign-in (PKCE) | n/a | yes | no | has |
| Accounts UI, chat UI, dock, step config | n/a | Svelte | no | has |
| Cloudflare Workers AI provider | no | no | no | missing |
| Cloudflare OAuth (PKCE) flow and token store | no | no | no | missing |
| Hugging Face provider (PKCE, `inference-api`) | no | no | no | missing |
| Loopback PKCE helper for TUI/CLI (generic) | no | n/a | no | missing |
| Per-host token storage for native (keyring) | `CredentialsProvider` trait, memory impl only | localStorage | no | partial |
| Refresh handling, 429 mapping in the provider | n/a | per provider | no | missing |

## Cloudflare provider design

Facts below are from Cloudflare docs read 2026-11-16; "not documented" is stated where
the page gave nothing, and each such item is a test to run before code.

| Item | Fact or design |
| --- | --- |
| Client type | Public client: authorization code, token auth `none`, PKCE S256 required. No device, implicit, password or client-credentials grant. Source: developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/ |
| Registration | Dashboard (Manage Account, OAuth clients) or `POST /client/v4/accounts/{account_id}/oauth_clients`. New clients are private; making one public is permanent, needs name, logo, client URL, scopes and DNS TXT verification (`cloudflare_oauth_client_publisher=` prefix, polled up to 2 days, domain fixed afterwards). |
| Endpoints | `https://dash.cloudflare.com/oauth2/{auth,token,revoke,userinfo,logout}`, plus `/.well-known/openid-configuration` and `jwks.json`. |
| Scopes | Names equal API token permission names; authoritative list `GET https://api.cloudflare.com/client/v4/oauth/scopes`. Workers AI REST quickstart names Workers AI Read and Edit (`ai.read`, `ai.write` in the changelog). Scope for `/ai/v1/chat/completions` and `aig.run` for AI Gateway: not documented. |
| Web redirect | `https://<app>/<callback>` of the verified domain. Same code path as `openrouter-oauth.ts` (verifier in `sessionStorage`, state, 30 minute expiry). |
| TUI redirect | Loopback `http://127.0.0.1:<port>/callback`. Rules for loopback redirect URIs are not documented: test with the private client first. |
| Token storage | Web: the visitor's `localStorage`, sent only to `https://api.cloudflare.com/client/v4/`. Native: `CredentialsProvider` backed by the host keyring or a 0600 file per host; ccht ships the trait, apps pick the store. |
| Calling | `POST /client/v4/accounts/{account_id}/ai/run/{model}` or the OpenAI-compatible `/ai/v1/chat/completions`, reusing `openAiStream`. `account_id` discovery with an OAuth token (accounts listing): not documented, test. |
| Allowance | 10,000 Neurons per day free, reset 00:00 UTC; Workers Paid $0.011 per 1,000 Neurons. Free plan overage fails: "Account limited", code 3036, HTTP 429 (map to `rate_limited`). About 20 Neurons for a 1k-in/500-out chat on llama-3.2-3b, so roughly 500 such chats a day. Source: workers-ai/platform/pricing/ and /errors/. |
| Open facts | Access-token lifetime, refresh token availability and lifetime, CORS on the token endpoint and on `api.cloudflare.com` from a browser, whether an OAuth bearer token is accepted by `/ai/run`. If CORS fails, the fallback is a thin same-origin relay in the app (cccc already has one); that adds a server and is a Julian decision. |

Design: `cloudflare({ clientId, scopes?, storage?, session? })` in `providers/`, with the
same `account` shape as `openrouter()` so `AccountsPanel` shows a row with no UI change;
`billing: 'user_account'`; PKCE helpers lifted from `openrouter-oauth.ts` into a shared
module; Rust side gets a loopback PKCE helper behind `native` for TUIs.

## Other providers with browser sign-in

| Provider | Mechanism | Public client | Lifetime | Billing | CORS | Source |
| --- | --- | --- | --- | --- | --- | --- |
| OpenRouter (in ccht) | `/auth?callback_url`, code to `POST /api/v1/auth/keys` | yes, no client id, PKCE optional | long-lived key, no refresh | user's credits | not documented | openrouter.ai/docs/guides/overview/auth/oauth |
| Hugging Face | `/oauth/authorize`, `/oauth/token`, scope `inference-api` | yes (no secret, S256 only; CIMD supported) | 8 h default for Spaces apps, refresh grant listed | account owning the token; free users need bought credits, PRO $2/month | not documented | huggingface.co/docs/hub/oauth, /inference-providers/pricing |
| OpenAI "Sign in with ChatGPT" | OAuth token used as bearer on `/v1/responses` | not documented | not documented | likely the user's plan, not stated | not documented | developers.openai.com/siwc/token-sharing-open-source/models-and-inference |

Others (Together, Fireworks, Groq, Mistral, Replicate, GitHub Models, Anthropic, xAI,
Cerebras): one search found no third-party sign-in documentation; not proof of absence.

## Consumers

| Consumer | Pin today | ccht parts used | Local code ccht should own |
| --- | --- | --- | --- |
| careervector-tui (branch `assistant-rail`) | Rust `=0.1.0`; does not compile against the transport API | `native::*`, `Conversation`, `StdioTransport`, `drivers::CodexDeviceDriver`, `AuthState` | `runtime.rs` login supervision and status mapping (1358 lines), `auth.rs` wrapper (135), `assistant.rs` connector resolution (480) |
| naming "Namer" worker | Rust `=0.2.0` | `native::{NativeClient, SessionOptions}`, `Event`, `SessionConfiguration`, `NativeError` | `model_provider.rs` (1075 lines, own provider catalogue and phase settings via `genai`) is app policy; the provider list and sign-in belong to ccht |
| naming frontend | npm `0.2.6` | `ChatDock`, `Dock`, `StepConfig`, Wasm asset | `scripts/ccht-assets.mjs` Wasm copy/verify step: ccht should ship the verified asset layout |
| fsl/ccti | Rust `0.2.1` | `SessionConfiguration`, ACP permission and select types | none found; `prov.rs` is image provenance, unrelated |
| web/cccc | npm `^0.3.3`, JSR `0.3.3` | `agent`, `providers`, `accounts`, `history`, `tools`, `assistant`, Accounts and Assistant components | `chat/providers.ts` same-origin relay provider and free-model catalogue; `chat/provider.ts` endpoint validation (`modelEndpoint`) |

From grep only; line counts are for orientation, not a finding that every line moves.

## Version alignment plan

1. One line, `0.3`: Rust `ccht = "0.3"`, npm `"^0.3.3"`, JSR `jsr:@corbet-labs/ccht@^0.3.3`. While below 1.0 a minor bump is breaking, so the range is the contract; the Cloudflare provider ships as 0.4.0 additive-only if possible, and consumers then move `0.3` to `0.4` in one pass.
2. Order: cccc (already on 0.3.3, no change), ccti 0.2.1 to 0.3, naming (worker `=0.2.0` and frontend `0.2.6` together, they share the Wasm model), careervector-tui last (0.1.0 to 0.3 is the largest API gap; port `assistant-rail` onto the transport API).
3. Replace every exact pin with a caret range; Renovate (already watching) opens the bumps, merged on green tests. No one-off fork pins.
4. Each consumer's CI runs against the range, so a ccht release that breaks one shows up as that app's red check, not as a drift.

## Open questions for Julian

| # | Question | Why it blocks |
| --- | --- | --- |
| 1 | Which domain verifies the public Cloudflare OAuth client (permanent, and the client URL users see on the consent screen)? | Public visibility cannot be undone and the domain cannot change. |
| 2 | If `api.cloudflare.com` has no CORS for browser calls, may ccht apps run a thin same-origin relay, or is Cloudflare TUI-only until it does? | Adds a server to an "uncomplicated" library. |
| 3 | Hugging Face as the second sign-in provider, or Cloudflare alone first? | Scope of 0.4.0. |
