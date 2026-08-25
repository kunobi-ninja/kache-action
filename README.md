# kache-action

GitHub Action for [kache](https://github.com/kunobi-ninja/kache) — a content-addressed Rust build cache.

## What is kache?

[kache](https://github.com/kunobi-ninja/kache) is a zero-copy, content-addressed Rust build cache that drops in as your `RUSTC_WRAPPER`. It caches rustc compilation artifacts keyed by blake3 hashes of normalized rustc invocations, so cache keys stay portable across machines and checkouts. A few things make it fast:

- **Zero-copy restores** — hits land in `target/` via reflinks (copy-on-write clones) where the filesystem supports them (APFS, btrfs, XFS-with-reflink), and hardlinks or copies otherwise, so artifact bytes are never duplicated.
- **Per-crate, content-addressed store** — identical artifact blobs are stored once and shared, indexed by a local SQLite DB.
- **Local store + optional S3 remote** — local caching works on its own; an optional S3-compatible remote (AWS, Ceph, MinIO, R2) shares the cache across machines and runners.
- **Background daemon** — handles async S3 uploads, remote checks, and manifest-driven warm prefetch of expensive artifacts.
- **LRU eviction** — the local store is capped (`KACHE_MAX_SIZE`, default 50GiB) and evicts least-recently-used entries.

Installs kache, sets it as `RUSTC_WRAPPER`, and persists the cache between runs. Supported C/C++ object compiles can also be cached with an opt-in setting. Works out of the box with GitHub's built-in cache, or with any S3-compatible backend.

## Usage

```yaml
- uses: kunobi-ninja/kache-action@v1
```

That's it. This installs kache, sets `RUSTC_WRAPPER`, and uses GitHub Actions cache to persist artifacts between runs. No configuration needed.

### With S3

If you have an S3 bucket (or any S3-compatible storage like MinIO, R2, etc.), the action will use that instead of GitHub's cache:

```yaml
- uses: kunobi-ninja/kache-action@v1
  with:
    s3-bucket: my-build-cache
    s3-access-key-id: ${{ secrets.S3_ACCESS_KEY_ID }}
    s3-secret-access-key: ${{ secrets.S3_SECRET_ACCESS_KEY }}
```

For non-AWS providers, set `s3-endpoint`:

```yaml
- uses: kunobi-ninja/kache-action@v1
  with:
    s3-bucket: my-build-cache
    s3-endpoint: https://minio.internal:9000
    s3-access-key-id: ${{ secrets.S3_ACCESS_KEY_ID }}
    s3-secret-access-key: ${{ secrets.S3_SECRET_ACCESS_KEY }}
```

### C/C++ object caching

Enable the C/C++ compiler wrappers explicitly:

```yaml
- uses: kunobi-ninja/kache-action@v1
  with:
    cache-c-cpp: true
```

On Linux and macOS nothing is exported. The Rust `cc` crate already recognizes kache as a compiler wrapper through `RUSTC_WRAPPER` (cc 1.2.66 and newer), and applies it to whatever compiler it selects, so cross-compiled targets keep their own toolchain and still compile through the cache.

On Windows the action sets `CC_<host-triple>` and `CXX_<host-triple>` to `kache clang-cl`, because without an explicit compiler `cc` selects MSVC `cl.exe`, which kache does not support. Scoping those to the runner's own triple leaves other targets to `cc`.

If `CC` or `CXX` is already set at the job level, that compiler is preserved and wrapped as-is (a value already headed by another cache wrapper such as `sccache` or `ccache` is left untouched). Note that a bare `CC` applies to every target: set `CC_<target>` instead if the job cross-compiles.

Dependencies built through the `cmake` crate (openssl-sys, zstd-sys, …) drop the `cc` crate's wrapper, so the action also exports `CMAKE_C_COMPILER_LAUNCHER` and `CMAKE_CXX_COMPILER_LAUNCHER` pointing at kache when they are unset — CMake keeps its own compiler selection and runs kache in front of each compile. A launcher you configured yourself always wins.

Plain make or autotools build scripts read `CC`/`CXX` directly rather than going through the `cc` crate, so they need those set explicitly:

```yaml
env:
  CC: kache cc
  CXX: kache c++
```

Kache conservatively caches supported single-source object compiles. Unsupported shapes pass through to the real compiler. C/C++ artifacts currently stay in the local Kache store: GitHub Actions cache can persist that store between jobs, but Kache does not upload C/C++ artifacts to S3 yet.

### Full example

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable

      - uses: kunobi-ninja/kache-action@v1
        with:
          s3-bucket: my-build-cache
          s3-region: eu-west-1
          s3-access-key-id: ${{ secrets.S3_ACCESS_KEY_ID }}
          s3-secret-access-key: ${{ secrets.S3_SECRET_ACCESS_KEY }}

      - run: cargo build --release
      - run: cargo test
      # Post step runs automatically: saves cache + prints summary
```

## Supported platforms

| Runner OS | Architecture |
|-----------|-------------|
| Linux     | x64, arm64  |
| macOS     | x64, arm64  |
| Windows   | x64, arm64  |

## Cache backends

| Backend | When | How |
|---------|------|-----|
| **GitHub Actions cache** | No S3 configured (default) | Saves/restores the local kache store via `@actions/cache`. Key is based on the kache version, OS, arch, and `Cargo.lock` hash. |
| **S3** | `s3-bucket` is set | Starts the kache daemon, which warm-prefetches expensive artifacts from the build manifest; pushes with `kache sync --push` in the post step (and saves a manifest for the next run). Set `sync: true` to also pull the *entire* remote cache on setup. Supports AWS S3, MinIO, R2, etc. |

GitHub Actions cache has a 10 GB limit per repo. For larger projects or shared caches across repos, use S3.

### Restore without saving

Use `save-cache: false` to restore an existing cache without writing changes back. This is useful for keeping one-off PR and branch jobs from consuming cache storage:

```yaml
- uses: kunobi-ninja/kache-action@v1
  with:
    save-cache: ${{ github.ref_name == github.event.repository.default_branch }}
```

With GitHub Actions cache, restore still runs but the post-step save is skipped. With S3, kache runs in remote read-only mode, so daemon uploads, manifest writes, and the final push are disabled while reads and prefetch remain available.

### Cache location

By default, the action uses kache's native per-user cache directory. To keep the
cache and build workspace on the same filesystem, set `cache-dir` explicitly:

```yaml
- uses: kunobi-ninja/kache-action@v1
  with:
    cache-dir: ${{ runner.temp }}/kache
```

This is useful on GitHub-hosted Windows runners and ephemeral self-hosted runners
whose home and workspace directories are on different volumes. Persistent
self-hosted runners can omit the input to retain a warm cache between jobs.

For trusted Linux ephemeral runners that mount a persistent per-node directory, keep
the store persistent but move every daemon/socket/log/session file into the job:

```yaml
- uses: kunobi-ninja/kache-action@v1
  with:
    cache-dir: ${{ runner.temp }}/kache
    node-cache: true
```

`node-cache` requires an explicit `cache-dir`, derives a unique runtime directory
under `runner.temp`, and disables GitHub Actions cache persistence. The mounted
store must exist only on a runner scale set restricted to mutually trusted
repositories/workflows. The action rejects fork PRs as defense in depth, but an
`if:` condition is not a security boundary: untrusted pods must never receive the
mount.

At startup the action verifies that the mounted store is writable, has at least
10 GiB free, and that the installed Kache release honors the job-scoped runtime.
An operational failure falls back to `${{ runner.temp }}/kache-fallback` while
keeping ordinary S3/v3 behavior. Trust-policy violations still fail closed.

## Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `version` | latest release | Kache version to install |
| `s3-bucket` | — | S3 bucket name (enables S3 backend) |
| `s3-region` | `us-east-1` | S3 region |
| `s3-prefix` | `artifacts` | S3 key prefix |
| `s3-endpoint` | — | Custom S3 endpoint (MinIO, R2, etc.) |
| `s3-access-key-id` | — | S3 access key ID |
| `s3-secret-access-key` | — | S3 secret access key |
| `cache-executables` | `false` | Also cache bin/dylib/proc-macro outputs |
| `cache-c-cpp` | `false` | Cache supported C/C++ object compiles. Rides on `RUSTC_WRAPPER` via the `cc` crate on Unix; sets `CC_<host-triple>` to `kache clang-cl` on Windows. |
| `github-cache` | `true` | Use GitHub Actions cache for the local store when S3 is not configured |
| `cache-dir` | native kache cache directory | Local kache store directory. Use `${{ runner.temp }}/kache` to colocate it with the runner workspace. |
| `node-cache` | `false` | Reuse `cache-dir` as a trusted node-local store across ephemeral jobs. Requires a runner mount trust boundary and disables GitHub Actions cache persistence. |
| `runtime-dir` | job-scoped under `runner.temp` in Actions | Override sockets, locks, logs, events, and build-session state. Every Actions job is isolated, even when `cache-dir` is persistent. |
| `save-cache` | `true` | Save cache changes after the build. Set to `false` for restore-only jobs; with S3 this also disables remote uploads. |
| `cache-key-prefix` | `kache` | Prefix for the GitHub Actions cache key |
| `sync` | `false` | Pull the **entire** remote cache on setup (slow; prefer `warm`). S3 only. |
| `warm` | `true` | Auto-prefetch expensive artifacts from the build manifest on daemon startup. S3 only. |
| `manifest-key` | — | Manifest key for scoping builds (default: target triple). Use different keys for clippy/test/release builds that share one S3 bucket. |
| `namespace` | `manifest-key` | Enables content-addressed **shards** (see [Manifest vs shards](#manifest-vs-shards)) — sharded prefetch + shard upload. Defaults to `manifest-key`, so scoping a build also turns shards on. Leave both empty to disable shards. |
| `min-compile-ms` | `1000` | Skip prefetching crates that compiled faster than this (ms) — cheaper to recompile. |
| `token` | `${{ github.token }}` | GitHub token for fetching releases and posting PR comments (needs `pull-requests: write` for comments) |
| `pr-comment` | `true` | Post/update a sticky PR comment with cache stats. |
| `job-summary` | `true` | Write cache stats to the GitHub Actions job summary. |
| `max-size` | `50GiB` (kache default) | Max local kache store size before LRU eviction (e.g. `100GiB`). Maps to `KACHE_MAX_SIZE`. Controls the **local** store, not a remote/S3 cap. |

> **S3-only inputs:** `sync`, `warm`, `manifest-key`, `namespace`, and `min-compile-ms` only take effect with the S3 backend. They tune how the kache daemon *selectively prefetches* expensive artifacts from the remote during setup. The GitHub Actions cache backend has nothing to prefetch — it restores the entire local store in one shot via `@actions/cache` and starts no daemon — so these inputs are ignored when S3 is not configured.

## Manifest vs shards

Both make the daemon's warm prefetch *selective* (pull the expensive artifacts, skip the cheap ones) instead of syncing the whole remote — but they degrade differently as your build drifts:

- **Build manifest** (`manifest-key`) — a snapshot of *one build's* full key set. The next run with the same key prefetches exactly those artifacts. Ideal when the build is identical run-to-run; as the dependency graph drifts, more of the snapshot goes stale.
- **Shards** (`namespace`) — content-addressed indexes keyed by *chunks of the dependency graph*. Unchanged chunks keep matching even when other parts of the build change, so prefetch stays effective across partial changes and across branches/PRs whose exact manifests don't line up.

**When to set `namespace`:** you usually don't need to — it defaults to `manifest-key`, so scoping a build enables both. The payoff is largest when your **dependency graph churns** between runs or you want **cross-branch/PR** prefetch sharing. For a build whose deps are stable run-to-run (only your own crates change), the manifest alone already prefetches most of the set, and shards add little. Leaving `manifest-key` and `namespace` both empty disables shards entirely.

> Why scope at all? Without a key, the manifest defaults to the target triple, which **every** build sharing the bucket (clippy/test/release/e2e) writes — so they clobber each other's manifest and prefetch falls back to near-zero. Give each build variant a distinct `manifest-key` and they stop fighting.

## How it works

**Setup step** (runs before your build):
1. Downloads the kache binary from [GitHub Releases](https://github.com/kunobi-ninja/kache/releases) and verifies its SHA256 checksum
2. Sets `RUSTC_WRAPPER=kache` and exports the relevant env vars — optional C/C++ wrappers, S3 credentials, `KACHE_VERSION`, `KACHE_MAX_SIZE`, and (for S3) the manifest/warm config (`KACHE_MANIFEST_KEY`, `KACHE_NAMESPACE`, `KACHE_MIN_COMPILE_MS`)
3. Restores the cache:
   - **S3** — starts the kache daemon, which warm-prefetches expensive artifacts from the build manifest (and from per-dependency shards when `namespace` is set). With `sync: true` it instead (or additionally) pulls the entire remote cache up front via `kache sync --pull`.
   - **GitHub** — restores the local store via `@actions/cache`.

**Post step** (runs after your build, even on failure):
1. Saves the cache unless `save-cache: false`:
   - **S3** — records the build manifest with `kache save-manifest` (so the next run knows what to warm), uploading per-dependency shards too when `namespace` is set, then pushes with `kache sync --push`.
   - **GitHub** — saves the local store via `@actions/cache`.
2. Generates the report with `kache report --format github --since 24h` and posts/updates a sticky PR comment from it (hit rate plus a cache-miss breakdown)
3. Writes that same report as the job summary unless `job-summary: false`

If a PR description contains `[no-cache]`, setup and the post step are both skipped for that run.

On self-hosted runners, the kache binary is cached via `@actions/tool-cache` so it's only downloaded once per version.

## PR comments

On pull requests, the post step posts (or updates) a comment rendered by `kache report --format github`, showing:

- Hit rate, local/remote hit counts, and miss count at a glance
- A breakdown of cache misses by compile time, so you can see which crates are the most expensive to rebuild

The comment is updated in-place on re-runs — no spam. Requires `pull-requests: write` permission on the token (the default `GITHUB_TOKEN` has this in most setups). The job summary is controlled independently with `job-summary`.

In matrix builds, each job posts its own comment, labeled with the job name and target triple (e.g. `### kache build cache — build (x86_64-unknown-linux-musl)`), so stats are never ambiguous or overwritten between jobs. Set `pr-comment: false` and/or `job-summary: false` to disable either output independently.

## License

Apache-2.0
