# Website repository checks: sandbox design

Status: design only; no runner, workflow, service, or production configuration is changed by this document.

## Goal and boundary

Let the Website Studio agent request bounded lint/build checks for an exact pull-request commit when that repository has
no usable CI. The check is advisory evidence for the human reviewer, not permission to publish. Existing GitHub checks
remain the first choice and the authoritative result when present. The agent must never control the command, image,
network policy, runner host, or credentials.

The hostile input is the entire repository at the selected SHA: source files, package manifests, lockfiles, build scripts,
compiler plugins, dependency lifecycle hooks, archive paths, and all output. Assume those files can execute arbitrary
code, forge logs, consume all resources, attack network services, and try to escape their environment.

## Recommended delivery order

1. **Use existing GitHub CI when present.** Read status/check runs for the exact PR head. Never edit workflows from the
   agent. Do not call `pull_request_target`, expose secrets, or use a persistent/self-hosted runner for untrusted PR code.
   Repositories with no checks remain explicitly "not configured".
2. **First sandbox MVP: GitHub-hosted Actions with a centrally maintained reusable workflow**, if repository/App
   permissions and GitHub's security model support the required dispatch. The trusted workflow definition must come from
   the protected Smart Knife/base branch, check out only the requested SHA, grant `contents: read` at most, use no
   secrets, and run on a fresh GitHub-hosted runner. Agent edits to `.github/workflows/**` stay blocked. If we cannot
   prove the workflow source is trusted and the token has no write authority, do not enable this option.
3. **Custom runner only if step 2 cannot cover required repos.** Put it on a dedicated KVM host/VM pool, not inside the
   Samurai Knife web process or alongside user data. Prefer Firecracker microVMs with a minimal immutable image and
   jailer/seccomp/cgroup limits. A rootless container alone is not the isolation boundary. Validate KVM support and
   operational cost before choosing Firecracker; otherwise use a maintained VM service with equivalent isolation.

## Custom runner components

```text
Website Studio API -> bounded job queue -> trusted broker -> one-shot microVM -> result store -> Changes UI / agent
                       |                   |                 |
                       |                   |                 +-- no host mounts, secrets, or GitHub credentials
                       |                   +-- read-only GitHub fetch, archive validation, policy-selected command
                       +-- account/repo/SHA authorization, quotas, status lifecycle
```

- **Request/API:** accept only a connected repository, an open PR head SHA belonging to its work branch, and a fixed
  profile id (`node-lint`, `node-build`, later explicit language profiles). Never accept shell text, arbitrary arguments,
  image names, environment variables, or a user-supplied URL. One running job per account/repo; idempotency key includes
  repo + SHA + profile.
- **Broker:** obtain the exact SHA from GitHub using a short-lived, read-only installation token; fetch the archive and
  release the token before execution. Enforce compressed/unpacked byte, file-count, path-depth and extraction-time
  caps. Reject traversal, absolute paths, device nodes, hard links, and symlinks escaping the checkout. Pin the SHA and
  verify the extracted source manifest before launch.
- **Guest:** disposable VM per job from a signed, immutable image. Run as an unprivileged guest user. No host filesystem,
  Docker socket, OpenClaw state, app data, credentials, SSH agent, cloud metadata, or reusable writable cache is mounted.
  No direct network. If dependencies must be downloaded, only a brokered, rate-limited HTTPS proxy to explicitly
  approved package registries is available; it blocks private/link-local destinations, arbitrary hosts, IP literals,
  redirects outside the allowlist, and non-HTTPS. Registry access carries no credentials. Package install scripts still
  execute as hostile code inside the VM.
- **Commands:** server-owned profile maps to fixed executables/arguments and bounded phases. Read package manager and
  lockfile metadata as untrusted data; never evaluate package scripts on the host. For Node, start with locked install
  plus selected lint/build scripts in the guest. Report each phase separately; arbitrary repo-defined scripts mean the
  whole guest remains untrusted even if the command name is `lint`.
- **Limits (initial conservative defaults, tune only from measurements):** 2 vCPU, 4 GiB RAM, 8 GiB scratch disk,
  256 processes, 10-minute guest wall clock / 15-minute total job deadline, 1 MiB returned logs, 20 MiB source archive,
  250 MiB unpacked source, one concurrent job per account and two globally. Hard-kill the VM at deadline; do not merely
  stop collecting output. Apply host-level cgroup limits to broker and VM processes too.
- **Result:** store only repo, immutable SHA, profile/image digest, start/finish time, phase exit codes, resource totals,
  and capped stdout/stderr. Mark all repository output as untrusted text; escape it in UI and never feed it to the model as
  instructions. No artifacts by default. If artifacts are later needed, use a separate quota-limited download path with
  content-type checks and no inline rendering.
- **Cleanup:** destroy the VM, writable disk, network namespace/proxy grant and temporary source after completion,
  cancellation, timeout, or broker restart. Reconcile orphaned jobs at service startup. Keep a bounded audit record, not
  the checkout or full logs indefinitely.

## Threat controls and residual risk

| Threat | Required control | Residual risk |
| --- | --- | --- |
| Fork bomb / CPU, memory, disk exhaustion | VM + host cgroups, PID/disk quotas, global queue cap, hard deadline | Hypervisor/host resource bugs remain possible |
| Data theft / exfiltration | No secrets in guest; no direct egress; allowlisted unauthenticated registry proxy only | A registry endpoint can receive attacker-chosen traffic; do not send credentials or private data |
| Host or cross-job access | One VM and disk per job; no host mounts/socket; patched hypervisor, jailer/seccomp; dedicated host | Hypervisor/kernel vulnerabilities are not eliminated |
| Malformed source/archive | Broker extraction caps, path and link validation, immutable SHA | Parser vulnerabilities in the broker remain; keep broker small and patched |
| Log injection / prompt injection | Strict byte cap, UI escaping, output marked untrusted, no execution based on output | Agent may still misread misleading diagnostics; require exact status and source SHA in reports |
| PR changes workflow or asks for secrets | Workflow path remains blocked; central workflow only; `contents: read`; no PR secrets | GitHub permission/configuration mistakes can invalidate this boundary |
| Persistent compromise | Disposable VM/disk, signed image, no shared writable cache, scheduled image rebuild | A compromised host requires rebuild and incident response |

## State machine and publication interaction

`queued -> fetching -> starting -> running -> succeeded | failed | timed_out | cancelled`.
Every transition is bound to `(account, repository, PR number, head SHA, profile, image digest)`. A changed PR head makes
the old result stale; it must never appear as the new commit's check. Publishing continues to require passing GitHub
checks when configured, no pending GitHub checks, and the user's existing review action. Sandbox results are labeled
**Sandbox (advisory)**, never a green GitHub check. A failed or timed-out sandbox must not be disguised as a CI pass.
The agent can request or inspect jobs only; it cannot cancel another account's job or publish the PR.

## Rollout and acceptance gates

1. Prove the GitHub-hosted reusable workflow path on a test repository: hostile PR, no secrets, read-only permissions,
   no workflow edits accepted, exact-SHA binding, bounded runtime, logs visible only to the owner.
2. Threat-model the broker/API and archive parser; add tests for traversal, symlink escape, zip bombs, oversized files,
   malformed manifests, cross-account lookup, changed-head staleness, timeout cleanup, queue floods, and output escaping.
3. For a custom runner, document the dedicated host, KVM/hypervisor update path, firewall, observability, kill switch,
   disk encryption/cleanup, backup exclusions, and incident procedure before any production install.
4. Run adversarial resource and network tests from inside a disposable VM; verify host CPU/RAM/disk remain bounded and
   that no private, loopback, metadata, or arbitrary internet address is reachable.
5. Canary with an administrator-owned test repo; compare checks to a clean runner, inspect deletion after success and
   timeout, then explicitly review whether a wider rollout is justified. No self-hosted runner on a general-purpose app
   host until these gates pass.

## Open decisions before implementation

- Is the centrally maintained GitHub-hosted workflow permitted by the GitHub App/auth model, or does every repo need its
  own workflow file? If the latter, keep checks advisory until a safe bootstrap/protection model exists.
- What is the supported language/runtime matrix and package-registry allowlist?
- Is a dedicated KVM host available, and what is the concurrency/retention budget?
- Should admins be able to opt a repository out of all sandbox execution? Default should be opt-in during rollout.
