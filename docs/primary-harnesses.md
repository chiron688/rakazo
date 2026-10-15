# Primary harness profiles (experimental)

Rakazo keeps the bot's identity, visible conversation, memory, permissions, routines,
and group membership. An optional execution profile selects the agent execution loop
for that bot. Unconfigured bots continue through the existing Pi runtime. Non-Pi
turns do not ask Pi to interpret or delegate the request. Auto Review and other
explicit helper calls retain their existing independent runtime and usage records.

## Scope

The initial supported deployment is a restricted Linux Docker supervisor. Web,
Electron (shared web UI), and mobile configure the same backend profile. Desktop,
Railway, E2B, and other sandbox providers without the isolated bidirectional process
contract reject native profiles; they never run the CLI on the API or worker host.

Pinned engines:

- Pi: the existing 0.87.1 runtime, unchanged by default.
- Claude: official Claude Agent SDK 0.3.300, Anthropic messages protocol.
- Codex: official Codex 0.162.1 app-server, OpenAI Responses protocol.
- Kimi Code: official `@moonshot-ai/kimi-code@2.2.0` ACP runtime, configured for
  the OpenAI Chat Completions provider protocol. The native control protocol and
  model-provider protocol are separate choices.

Kimi Code 2.2.0 is pinned to the [official release](https://github.com/MoonshotAI/kimi-code/releases/tag/%40moonshot-ai/kimi-code%402.2.0).
The archived Python Kimi CLI/Wire runtime is no longer launched. Existing legacy
profiles are not rewritten: Advanced settings keeps their binding visible and
requires **New revision** to create a profile with the supported pin. This creates
a new profile revision/session scope rather than reusing a legacy Wire session.
Protocol updates require new conformance fixtures and review of permissions and
session behavior; a version string alone does not establish compatibility.

Native agents use Rakazo's mediated tools for reading, writing, shell commands,
memory, messaging, group handoff, and integrations. Those operations run against
the bot's authorized computer and retain existing approval/effect rules. Vendor
native tools, arbitrary MCP servers, project hooks, and native subagents are not
permitted. Native image and uploaded-audio support is model- and protocol-scoped,
as described below. Unsupported media fails explicitly rather than switching
engines or substituting transcription. Rakazo-mediated helpers are supported
with the limits documented below.

## Capability matrix

| Capability | Pi default | Claude Agent / Codex / Kimi Code |
| --- | --- | --- |
| Direct, group/handoff, routine turns | Existing behavior | Supported; target profile snapshotted at enqueue |
| Shell, file, memory, integration tools | Existing behavior | Rakazo-mediated tools and existing approvals |
| Questions, protected input, takeover | Existing behavior | Parent bot uses existing durable input/approval paths |
| Short helper agents | Existing behavior | Same-harness/account/model, four distinct requests/run, depth one |
| Native session continuation | Existing behavior | Private scoped transcripts + validated checkpoint/epoch |
| Worker crash / uncertain effect | Existing recovery | Interrupted run fails closed; fresh user run can start a new epoch |
| Images, uploaded audio, live-call transcripts | Existing image/transcript behavior | Separate media matrix below; no engine or transcription fallback |
| Vendor-native shell/hooks/MCP/subagents | Not applicable | Disabled; no bypass of Rakazo tools |
| API-key account | Existing behavior | Explicit selected account required |
| OAuth/subscription account | Existing behavior | Explicitly rejected |
| Execution environment | Existing providers | Restricted rootful Linux Docker; operator verification required |

A missing account, unsupported version/protocol, unavailable environment or revoked
permission produces an actionable failed run. None changes the selected harness or
billing account automatically. Helper model override and nested delegation requests
also fail explicitly. This matrix describes implemented paths, not live provider or
real-host acceptance results; those validation limits are listed below.

## Native media matrix

Transport support is an upper bound, not a promise that an arbitrary model accepts
media. Each immutable native profile declares its selected model's
`inputModalities` (`image`, `audio`, or both). The declaration defaults to `[]` for
new profiles, old rows, and old snapshots; it never inherits media support from
another account, a provider name, or an unrelated connection default. Known
image-incompatible model configurations are rejected. A declaration does not
replace a live compatibility test of a custom endpoint/model.

| Input / output | Claude Agent 0.3.300 | Codex 0.162.1 | Kimi Code 2.2.0 |
| --- | --- | --- | --- |
| Uploaded/current/history images | Implemented with explicit model `image` declaration; actual-engine offline probe passed | Implemented with explicit model `image` declaration; actual-engine offline probe passed | Implemented through ACP with explicit model `image` declaration; actual-engine offline probe passed |
| Mediated tool-result images | Implemented and actual-engine offline probe passed | Implemented and actual-engine offline probe passed | Implemented and actual-engine offline probe passed |
| Native uploaded audio | Unsupported by this harness | Implemented only for a declared audio-capable custom Responses endpoint/model; actual-engine offline audio/resume probe passed | Unsupported: ACP advertises `audio: false` |
| Official OpenAI Responses audio | Not applicable | Rejected, including provider aliases pointing at OpenAI/ChatGPT domains | Not applicable |
| Live-call/dictation transcripts | Existing text path | Existing text path | Existing text path |

The Kimi restriction follows its [versioned ACP contract](https://github.com/MoonshotAI/kimi-code/blob/%40moonshot-ai%2Fkimi-code%402.2.0/docs/en/reference/kimi-acp.md).
The presence of a file-upload endpoint does not mean a native model accepts audio.
Pi's existing image handling is unchanged; native uploaded audio is not enabled
for Pi. The normal file chooser accepts raw audio separately from dictation and
live calls. Native uploaded audio is never replaced with an STT transcript. Live
calls continue to use their existing transcription provider and send text.

In Advanced settings, **Model accepts images** and, only for eligible custom Codex
endpoints, **Model accepts uploaded audio** are explicit model declarations.
Changing the model, account, provider, protocol, harness, or endpoint clears the
draft declarations. Selected profiles distinguish unavailable transport inputs
from supported inputs not enabled for that model. No blanket media capability is
inferred from choosing a harness.

### Media authorization, limits, and history

Media is hydrated from database-authorized artifact IDs for the active user and
space. Runtime code does not fetch attachment URLs or interpret names as paths.
Stored size, MIME, SHA-256 digest, safe storage reference, and decoded image/audio
container checks must pass before Rakazo passes original bytes to the native harness.
The Claude SDK and Kimi ACP may optimize/re-encode large images before HTTP: small
image probes preserve bytes, but byte-for-byte provider payload identity is not
promised for that SDK. Rakazo does not substitute a transcript or perform an
implicit audio conversion.
PNG, JPEG, WebP, and GIF images are supported by the shared boundary. Audio upload
containers are WAV, MPEG/MP3, MP4/M4A, WebM, Ogg, and FLAC; each endpoint/model may
accept a narrower set and is not automatically transcoded.

A native prompt has a shared limit of four media items and 10 MiB of decoded bytes
across current input and hydrated history. Images also have a 40-million-pixel
validation limit, at most 256 animation frames, and a five-second decode timeout. History hydration considers at most three recent media-bearing
turns, preserving message/speaker attribution. Current input consumes the budget
first; unavailable or over-budget historical media is replaced with an explicit
omission notice, not silently treated as seen. Current unsupported or invalid
media fails the turn. Native session/profile revisions retain their existing
account, bot, thread, epoch, and lease isolation; media does not create a shared
cross-profile cache. Tool images pass the same media validation boundary.

## Enable on a controlled deployment

1. Apply the additive database migration with the normal migration workflow.
2. Build the pinned runtime image:

   ```sh
   docker build -t rakazo/harness:local infra/sandboxes/harness
   ```

3. Configure and independently verify the supervisor's restricted host firewall
   according to the computer networking documentation. Native runtime bridges are
   distinct from team-computer bridges; access to private destinations and the
   Docker host must be blocked. Merely naming a bridge does not enforce egress.
4. Set PRIMARY_HARNESSES_ENABLED=true in API, worker, and supervisor;
   SANDBOX_COMPUTER_EGRESS=restricted and PRIMARY_HARNESS_EGRESS_VERIFIED=true in
   supervisor. The verification flag is operator attestation, not an automatic
   firewall test. Do not set it before verifying the rules on that host.
5. Open a bot's Advanced settings, create a named profile, and select the harness,
   explicit connection account, protocol, endpoint, and model. Profile versions
   are immutable. Sharing a profile reuses authorized connection configuration,
   not mutable bot/session state.

No provider account is required for Pi's existing default path beyond its current
configuration. Native profiles are API-key-first. OAuth/subscription credentials
are rejected; the implementation does not extract or reuse subscription tokens.
A real API call can incur a provider charge. Default tests never call a provider.

## Identity, credentials, and continuity

The database snapshots the addressed bot's immutable profile at run insertion,
including exact credential and credential-secret references, version, actual
computer, and model-scoped input declarations. The additive media migration sets
existing profile rows to `inputModalities = []`; it does not upgrade their pinned
runtime or silently enable media. This covers direct messages, group mentions/handoffs, routine wakes,
and other enqueue paths. Changing the bot or space default cannot reroute queued
work. Starting a run and every mediated tool call recheck membership, ownership,
and credential revocation. Periodic checks cancel in-flight native processes when
run authorization or ownership disappears. Revocation cannot undo an operation
already accepted by an external service.

Two profiles can select the same provider/model with different accounts. Missing,
revoked, or replaced accounts fail closed; there is no newest-account lookup,
provider fallback, deployment-key fallback, or automatic engine switch for an
explicit profile. Endpoints are protocol-specific and independently validated;
an Anthropic endpoint is never normalized as an OpenAI endpoint.

Native session bindings are scoped to space, user, bot, thread, profile revision,
and epoch. The isolated runtime gets a private session volume; HOME and credentials
remain ephemeral. Team workspaces are never mounted into the native runtime.
Replacing an account connection rotates the epoch before another run can resume.
Changing harness/profile or clearing conversation history creates a new native
session. Canonical Rakazo history remains the durable user-visible source of truth;
other group bots' messages keep their speaker identity. Native checkpoints are not
portable between engines or accounts.

A running session is fenced by run ID and lease fence. An unexplained EOF or process
failure is not a successful turn. Interrupted work is not automatically replayed;
a fresh user turn may start a new scoped epoch using visible context. Approval and
input pauses are distinguished from crashes. Approvals remain bound to Rakazo's
existing durable effect/approval records. Duplicate, stale, expired, or foreign
answers cannot grant another run permission.

## Isolation and lifecycle

The supervisor launches a separate non-root container with read-only root filesystem,
private HOME/tmp, scoped session storage, resource limits, and no workspace/home or
Docker socket mount. Only trusted pinned runtime code is present, so repository
configuration cannot replace an endpoint, key, hook, MCP server, or approval policy.
All filesystem and shell activity is mediated through Rakazo's existing sandbox
and authorization layer. A worktree is not a security boundary.

The bidirectional transport bounds frame size, queued messages, tool results,
request counts, output, and run time. Kimi journal inspection uses 64 KiB incremental reads,
16 MiB record/batch bounds, and a 1 GiB session-log limit. Hitting a native-session
capacity limit fails explicitly; after an interrupted run, a fresh user turn can
reconstruct a new scoped epoch from Rakazo history. Unknown security requests are denied.
Cancellation, disconnect, timeout, and computer shutdown terminate the entire
runtime container. Credentials and provider error bodies are not written to
protocol diagnostics. Usage unavailable from a vendor remains unknown, never zero.

## Rollback

Disable PRIMARY_HARNESSES_ENABLED to reject new native turns. Stop or cancel active
native runs before changing runtime images. Keep new tables and audit records;
downgrading code does not imply deleting session/profile data. An existing native
profile does not become Pi implicitly. Select Pi explicitly to change that bot.

## Verification

Offline unit suites cover profile/account isolation, immutable queue snapshots,
scoped sessions and fencing, protocol fragmentation/errors/terminal behavior,
mediated tool calls, cancellation, and settings interactions. PostgreSQL integration
and actual container isolation require the normal Docker-equipped test environment.

Provider compatibility must be tested separately with deliberately supplied test
accounts. Z.AI and Kimi publish Claude-compatible configurations; that documentation
is not proof that these pinned versions pass live authentication, tools, resume,
quota errors, and cancellation. Do not describe fixture success as live compatibility.
No live provider compatibility is claimed by this document.

### Private session retention

Stopping/replacing a computer preserves private session volumes for continuation.
Destroying that computer terminates native processes and removes its labeled
volumes. Clearing a thread invalidates its binding/epoch immediately, so old
transcripts cannot be resumed; old epoch volumes remain inaccessible to new runs
until computer destruction or operator cleanup. There is no automatic per-thread
volume garbage collector in this initial version. Administrators should apply
retention/encryption/backup policy to Docker storage as they do to other private
conversation data. Never remove volumes belonging to an active run.

### Reproduce acceptance checks

Run the default offline suite with `pnpm test`. Direct profile, session, transport,
and runtime specifications live beside their implementations. They use fake
credentials and deterministic process/provider fixtures.

On a disposable migrated PostgreSQL database, run:

```sh
VERIFY_DATABASE=1 pnpm exec vitest run packages/db/src/execution-profiles.postgres.test.ts
```

`DATABASE_URL` must already identify that test database. This suite creates and
removes its own synthetic records; do not point it at a production database.

On a configured Linux Docker host with the trusted image already built and the
restricted firewall independently verified, run:

```sh
RAKAZO_HARNESS_DOCKER_TESTS=1 PRIMARY_HARNESS_EGRESS_VERIFIED=true \
  pnpm exec vitest run infra/sandboxes/supervisor/src/isolated-process.docker.test.ts
```

This checks real duplex input/output, credential-free Docker metadata, process-tree
termination, and scoped persistence. It does not build or pull an image, modify
firewall rules, or make a model-provider call. Mocked firewall tests alone do not
establish real host enforcement.

## Dependency terms and display names

These engines retain their upstream terms; Rakazo's repository license does not
relicense bundled vendor software. Deployment operators should review the linked
terms and preserve required dependency license and attribution notices:

- Claude Agent SDK: [SDK license and branding guidance](https://code.claude.com/docs/en/agent-sdk/overview),
  [Commercial Terms](https://www.anthropic.com/legal/commercial-terms), and
  [authentication and hosting conditions](https://code.claude.com/docs/en/legal-and-compliance).
  The embedded SDK integration uses the selected user's API key. It does not offer
  Claude.ai login, collect subscription tokens, resell provider usage, or modify
  the vendor binary. The UI label is **Claude Agent**, as recommended for dropdowns.
  An operator must independently assess applicable hosting and account terms;
  this implementation is not legal approval of a deployment.
- Codex 0.162.1: [Apache-2.0 license](https://github.com/openai/codex/blob/rust-v0.162.1/LICENSE).
  Provider API service terms remain separate from the software license.
- Kimi Code 2.2.0: the [pinned npm metadata](https://registry.npmjs.org/@moonshot-ai/kimi-code/2.2.0)
  declares MIT and Node >=22.19.0. See the [pinned release](https://github.com/MoonshotAI/kimi-code/releases/tag/%40moonshot-ai/kimi-code%402.2.0)
  and [versioned source and license](https://github.com/MoonshotAI/kimi-code/tree/%40moonshot-ai%2Fkimi-code%402.2.0).
  Review its current package notices and provider service terms independently of
  Rakazo's license. Legacy Python Kimi CLI licensing does not establish the new
  runtime's terms or protocol compatibility.

## Mediated helper limits

`run_subagent` launches another isolated instance of the selected native harness,
with the exact same account, model, protocol, and profile revision. Helpers retain
the parent bot's authorization and use the same mediated tool/effect boundary.
They have a separate private session epoch and separately attributed usage.
Vendor-native subagents remain disabled. Explicit helper model overrides are
rejected; there is no implicit Pi or provider fallback.

A run allows at most four distinct helper requests, at one level of nesting.
Repeating the same normalized helper name, task, and instructions as a new call
within that run is rejected to avoid ambiguous approval continuation. Helper results are
bounded to 1 KiB of UTF-8 text, with an explicit truncation marker. Helpers cannot
ask the user or request takeover themselves. A protected-tool approval pause
propagates through the parent; checkpoints are persisted before child effects.
Same-run approval continuation can restore a matching helper invocation and its
completed result. A new user run never reuses an old helper result. Helper session
volumes follow the private-session retention policy above.

### Ambiguous mutation replay after a pause

A host tool response alone does not prove the native engine durably recorded it.
For every native harness, a same-run continuation rejects a mutation whose exact
tool/arguments fingerprint was already completed before the current attempt,
unless it is the exact persisted approved effect being resumed. This prevents a
missing native result from becoming a second side effect with a new call ID.
Distinct requests, read-only built-ins and fresh user runs remain available;
an intentional identical mutation must start a new user turn. The run reports
this ambiguity explicitly rather than silently repeating or pretending success.
This guard supplements, rather than replaces, the existing external-effect audit
and cannot make an arbitrary remote API transaction atomic with the database.

## Reproduce real-engine offline probes

Ordinary tests use deterministic protocol fixtures and skip vendor subprocesses.
The opt-in integration tests execute the actual pinned engines against local HTTP
API stubs using fake keys, then replace HOME and resume their private session data.
They check tool declarations, bridged calls, explicit completion, streaming, usage,
native identity, and absence of the fake key in persisted state. These tests do not
validate Docker isolation or live provider compatibility.

Install the image's exact npm packages in a disposable directory and provide its
absolute `node_modules` path as `RAKAZO_NATIVE_HARNESS_TEST_MODULES`. Kimi now uses
the pinned npm package and ACP; no legacy Python CLI environment is used. This
variable is a dependency path, never an account credential. From the repository root:

```sh
RAKAZO_NATIVE_HARNESS_TEST_MODULES=/absolute/test-deps/node_modules \
pnpm exec vitest run \
  packages/adapters/src/primary-harness-offline-integration.test.ts \
  packages/adapters/src/primary-harness-kimi-offline-integration.test.ts
```

The npm pins are `@anthropic-ai/claude-agent-sdk@0.3.300`,
`@anthropic-ai/sdk@0.134.0`, `@modelcontextprotocol/sdk@1.30.0`, `zod@4.6.2`,
`@openai/codex@0.162.1`, and `@moonshot-ai/kimi-code@2.2.0`. Dependency installation is separate from tests, so
ordinary unit tests never download vendor programs or contact a model provider.
The dedicated CI compatibility job installs these exact engines separately and
runs the opt-in probes; it uses only loopback fake APIs. The PostgreSQL journey
job also includes the execution-profile migration suite.

### Current media acceptance status

Claude Agent SDK and Codex app-server actual-engine offline image, tool-image, and
fresh/resumed-session probes have passed against local fake endpoints. Kimi Code
2.2 actual ACP current/history-image, mediated screenshot, and fresh/resumed tool
probes also passed with byte-preserving small-image payloads. Codex custom-endpoint raw
audio and resumed-session probes passed using an explicitly supplied model catalog
that declares audio input. Large-media probes also pass: duplicated native media echoes are filtered inside
the restricted runtime while forwarded model output stays bounded. Claude/Kimi native large-image optimization means
these results do not imply universal byte identity after native preprocessing.
Older Kimi CLI 1.51.0 results are not evidence for the replacement.

No paid/live provider call, real-host Docker isolation/firewall acceptance, or
PostgreSQL migration execution is claimed here. Browser screenshot capture was
blocked by the execution environment's Chromium Unix-socket and separate-loopback
restrictions; the offline Playwright scenarios require CI screenshot evidence.
The web fixture does not capture native mobile UI. Repository-wide checks and
protocol mocks do not replace these outstanding acceptance gates.

Kimi Code ACP's [pinned image conversion implementation](https://github.com/MoonshotAI/kimi-code/blob/%40moonshot-ai%2Fkimi-code%402.2.0/packages/acp-server/src/convert.ts)
can compress oversized images and adds an explicit warning that fine detail may
be lost. Original validated bytes reach ACP; optimized provider bytes are not
claimed to be identical. Provider-error media stripping/degradation is separately
detected in the native journal and fails the run before another host tool effect.
