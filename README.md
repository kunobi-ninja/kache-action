# kache-action

GitHub Action for [kache](https://github.com/kunobi-ninja/kache) — a content-addressed Rust build cache.

## What is kache?

[kache](https://github.com/kunobi-ninja/kache) is a zero-copy, content-addressed Rust build cache that drops in as your `RUSTC_WRAPPER`. It caches rustc compilation artifacts keyed by blake3 hashes of normalized rustc invocations, so cache keys stay portable across machines and checkouts. A few things make it fast:

- **Zero-copy restores** — hits land in `target/` via reflinks (copy-on-write clones) where the filesystem supports them (APFS, btrfs, XFS-with-reflink), and hardlinks or copies otherwise, so artifact bytes are never duplicated.
- **Per-crate, content-addressed store** — identical artifact blobs are stored once and shared, indexed by a local SQLite DB.
- **Local store + optional S3 remote** — local caching works on its own; an optional S3-compatible remote (AWS, Ceph, MinIO, R2) shares the cache across machines and runners.
- **Background daemon** — handles async S3 uploads, remote checks, and manifest-driven warm prefetch of expensive artifacts.
- **LRU eviction** — the local store is capped (`KACHE_MAX_SIZE`, default 50GiB) and evicts least-recently-used entries.

Installs kache, sets it as `RUSTC_WRAPPER`, and persists the cache between runs. Works out of the box with GitHub's built-in cache, or with any S3-compatible backend.

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
| `github-cache` | `true` | Use GitHub Actions cache for the local store when S3 is not configured |
| `cache-key-prefix` | `kache` | Prefix for the GitHub Actions cache key |
| `sync` | `false` | Pull the **entire** remote cache on setup (slow; prefer `warm`). S3 only. |
| `warm` | `true` | Auto-prefetch expensive artifacts from the build manifest on daemon startup. S3 only. |
| `manifest-key` | — | Manifest key for scoping builds (default: target triple). Use different keys for clippy/test/release builds that share one S3 bucket. |
| `min-compile-ms` | `1000` | Skip prefetching crates that compiled faster than this (ms) — cheaper to recompile. |
| `token` | `${{ github.token }}` | GitHub token for fetching releases and posting PR comments (needs `pull-requests: write` for comments) |
| `pr-comment` | `true` | Post/update a sticky PR comment with cache stats. The job summary is always written regardless. |
| `max-size` | `50GiB` (kache default) | Max local kache store size before LRU eviction (e.g. `100GiB`). Maps to `KACHE_MAX_SIZE`. Controls the **local** store, not a remote/S3 cap. |

> **S3-only inputs:** `sync`, `warm`, `manifest-key`, and `min-compile-ms` only take effect with the S3 backend. They tune how the kache daemon *selectively prefetches* expensive artifacts from the remote during setup. The GitHub Actions cache backend has nothing to prefetch — it restores the entire local store in one shot via `@actions/cache` and starts no daemon — so these inputs are ignored when S3 is not configured.

## How it works

**Setup step** (runs before your build):
1. Downloads the kache binary from [GitHub Releases](https://github.com/kunobi-ninja/kache/releases) and verifies its SHA256 checksum
2. Sets `RUSTC_WRAPPER=kache` and exports the relevant env vars — S3 credentials, `KACHE_VERSION`, `KACHE_MAX_SIZE`, and (for S3) the manifest/warm config (`KACHE_MANIFEST_KEY`, `KACHE_MIN_COMPILE_MS`)
3. Restores the cache:
   - **S3** — starts the kache daemon, which warm-prefetches expensive artifacts from the build manifest. With `sync: true` it instead (or additionally) pulls the entire remote cache up front via `kache sync --pull`.
   - **GitHub** — restores the local store via `@actions/cache`.

**Post step** (runs after your build, even on failure):
1. Saves the cache:
   - **S3** — records the build manifest with `kache save-manifest` (so the next run knows what to warm), then pushes with `kache sync --push`.
   - **GitHub** — saves the local store via `@actions/cache`.
2. Generates the report with `kache report --format github --since 24h` and posts/updates a sticky PR comment from it (hit rate plus a cache-miss breakdown)
3. Writes that same report as the job summary (always, even outside PRs)

If a PR description contains `[no-cache]`, setup and the post step are both skipped for that run.

On self-hosted runners, the kache binary is cached via `@actions/tool-cache` so it's only downloaded once per version.

## PR comments

On pull requests, the post step posts (or updates) a comment rendered by `kache report --format github`, showing:

- Hit rate, local/remote hit counts, and miss count at a glance
- A breakdown of cache misses by compile time, so you can see which crates are the most expensive to rebuild

The comment is updated in-place on re-runs — no spam. Requires `pull-requests: write` permission on the token (the default `GITHUB_TOKEN` has this in most setups). The same report is always written to the job summary regardless of this setting.

In matrix builds, each job posts its own comment, labeled with the job name and target triple (e.g. `### kache build cache — build (x86_64-unknown-linux-musl)`), so stats are never ambiguous or overwritten between jobs. To turn the comment off entirely and rely on the per-job job summary instead, set `pr-comment: false`.

## License

Apache-2.0
