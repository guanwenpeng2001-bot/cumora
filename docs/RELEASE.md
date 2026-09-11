# Release Manual (fork)

## Desktop releases

Desktop auto-update uses GitHub Releases. `package.json` → `build.extends` loads
`scripts/electron-publish.cjs`; its default target remains
`guanwenpeng2001-bot/cumora`. Set `CUMORA_GITHUB_OWNER` and
`CUMORA_GITHUB_REPO` in the build environment to publish packages and embed the
update feed for your repository. Set the same variables when building the web
frontend (Vite injects only these public coordinates) and when starting the API
server (daemon release lookup reads its process environment). Unset or blank
values retain the current fork defaults. Changing a feed does not migrate
already-installed clients: distribute a build with the new configuration.

Build desktop packages locally with `npm run electron:build` (or the platform
variant); publishing is a separate, explicit operation with electron-builder.
Signing/notarization credentials are needed for the platforms you distribute.
The GitHub provider emits the `latest*.yml` feeds used by electron-updater;
there is no upstream R2 feed or upstream release repository fallback.

`.github/workflows/release.yml` accepts `v*` tags or manual dispatch, but its job
is disabled unless repository variable `CUMORA_ENABLE_RELEASE_DISPATCH=true`.
When enabled it sends `repository_dispatch` with event type `release` and
`ref`/`version` payload to `${{ github.repository }}`, using the workflow token
with `contents: write`. Install a matching receiver in your repository before
enabling it. No receiver is included here, so sending the event alone does not
build, sign, or publish desktop artifacts. Do not enable it merely to obtain a
green workflow. It never dispatches to `yetone/cumora-releases` and does not
deploy the backend.

## Fixed agent CLI releases

The CLI is a separate artifact, built from `agent-cli/` by
`.github/workflows/agent-cli-release.yml`. Manually select an existing immutable
`agent-cli-v<fork-version>` tag; the workflow builds a standalone bundle,
packs it with checksums, and creates a draft Release in the current repository.
Publishing the draft and rolling it out to machines are separate operations.
Update `src/lib/agentCliRelease.ts`'s pinned tag when adopting a new CLI version.
Changing owner/repo does not create that tag or its assets in the target repo.

For a server-specific CLI, set `CUMORA_DEFAULT_SERVER` while running
`node agent-cli/build.mjs`, or configure that repository variable for the CLI
release workflow. It is baked into the bundle, not read from the installed
machine's `CUMORA_DEFAULT_SERVER`. Without a baked default, first pairing must
supply `--server` or runtime `CUMORA_SERVER_URL`. Saved pairing configuration
wins over runtime/baked defaults; explicit `--server` wins over saved config.
Missing server configuration fails before pairing, service installation, or
network requests. Local help/version/management commands remain available.

## Upstream cloud backend reference

The following backend procedures describe the retained upstream GKE workflows,
not the self-hosted deployment path in `deploy/README.md`. Their cloud credentials
and infrastructure are not provisioned by this fork's desktop/CLI release setup.

## Backend release: build candidate, then ignite production

Every push to `main` runs `.github/workflows/build.yml`. Before publishing an
image it must pass both TypeScript projects, the big-brain and tracked-LLM
guards, unit tests, and the Postgres/Redis integration suite. A successful run
produces immutable SHA-tagged server (and, when affected, agent-computer)
images. It does not deploy them.

To deploy a candidate:

1. Open **Actions → Deploy → Run workflow**.
2. Enter the exact short SHA tag produced by Build. Avoid `latest` when a SHA
   is available; Deploy resolves either tag to a digest before touching GKE.
3. Set `include_agent=Y` when the build changed `server/src/agents/**`, the
   bundled CLI/runtime, or the agent-computer image. Otherwise use `N`.
   Leave `repair_0002=off` unless you are clearing the migration 0002
   precondition — see below.
4. Approve the protected `production` environment. The approver should not be
   the person who built the feature for high-risk changes.
5. Verify the workflow summary contains the selected digest, previous server
   image, completed rollout, and passed authenticated smoke.

Deploy first proves that the existing production API and smoke credential are
healthy, runs one candidate-image migration Job and verifies its immutable
ledger/index gates, records the current revision as the rollback baseline,
updates the server (and optionally agent runtime) by digest, waits for GKE, then
exercises real authenticated tenant paths: auth, conversations, and the
Shipping overview/schema. A migration failure leaves the Deployment untouched;
a failed post-deploy smoke automatically runs
`kubectl rollout undo`, waits for the old revision to become ready, and fails
the workflow.

#### When migration 0002 refuses to apply

Migration 0002 normalizes conversation membership (ADR 0004) and fails closed
when a `conversations.members` entry names an id with no participant in that
conversation's tenant. The Job log carries a precheck report first — counts by
category plus a masked sample — so read that before doing anything.

These entries predate the tenant guard in `startPulledGroup` and grant nothing
today: every read path is tenant-scoped, so a foreign member id is unreachable
membership, and ADR 0004's composite FK cannot represent it at all. Rerunning
Deploy with `repair_0002=archive-detach` lets 0002 clear its own precondition:

- every offending `(conversation, member)` pair is copied into
  `conversation_members_detached_0002` — with its ordinal *and* the whole
  pre-detach members array — before it is removed;
- `messages` is never touched, so an archived member that posted in the
  conversation keeps its authorship;
- the precheck re-runs afterwards, so anything a detach cannot fix (a
  conversation with no `company_id`, say) still stops the deploy;
- all of it runs inside 0002's transaction, so any later failure rolls the
  detach back with it.

The archive is a complete record, not a one-click undo. Once 0002 has applied,
its projection trigger enforces ADR 0004 on every write, so putting a detached
id back into `conversations.members` fails until that id is a real participant
in that tenant — which is the invariant the migration exists to establish. What
the archive gives you is the ability to see exactly what was removed and from
where:

```sql
SELECT conversation_id, member_id, ordinal, authored_messages,
       participant_elsewhere, original_members
  FROM conversation_members_detached_0002
 ORDER BY conversation_id, ordinal;
```

A genuine restore means first making the id resolvable (recreate or move the
participant into that tenant), then re-adding it through `addConversationMember`.
`original_members` records the exact pre-detach array to restore against.

`repair_0002` applies to that one run only — it is passed as an explicit
container `env` entry that overrides the `cumora` Secret, and defaults to
`off`, so an ordinary deploy keeps failing closed.

Shipping features additionally track a production readback deadline, default
24 hours after a successful release. The Ship workspace surfaces due items;
the server turns missed deadlines into `overdue` release state plus high
severity friction. `.github/workflows/production-readback.yml` independently
checks authenticated production paths each day. A feature only reaches
`Learned` after its production release has explicit readback evidence and no
failing regression asset.

### Required backend secrets and environment protection

On `yetone/cumora`:

| Name | Purpose |
|------|---------|
| `GCP_WIF_PROVIDER` | Workload Identity Federation provider used to resolve and deploy images. |
| `GCP_DEPLOY_SA` | Least-privilege service account for Artifact Registry and the production GKE deployment. |
| `CUMORA_SMOKE_TOKEN` | Dedicated, revocable session/service token used only for authenticated smoke/readback. |
| `CUMORA_SMOKE_COMPANY_ID` | Non-sensitive tenant id that the smoke identity belongs to. |

Protect the `production` GitHub environment with required reviewers. Put the
smoke secrets in both `production` and `production-readback` (or configure the
latter to inherit repository secrets). Rotate the smoke token like any other
production credential and never print it in workflow output.

