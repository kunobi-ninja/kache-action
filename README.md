# kache-action

GitHub Action for [kache](https://github.com/zondax/kache) — a content-addressed Rust build cache.

Installs kache, sets it as `RUSTC_WRAPPER`, and persists the cache between runs. Works out of the box with GitHub's built-in cache, or with any S3-compatible backend.

## Usage

```yaml
- uses: zondax/kache-action@v1
```

That's it. This installs kache, sets `RUSTC_WRAPPER`, and uses GitHub Actions cache to persist artifacts between runs. No configuration needed.

### With S3

If you have an S3 bucket (or any S3-compatible storage like MinIO, R2, etc.), the action will use that instead of GitHub's cache:

```yaml
- uses: zondax/kache-action@v1
  with:
    s3-bucket: my-build-cache
    s3-access-key-id: ${{ secrets.S3_ACCESS_KEY_ID }}
    s3-secret-access-key: ${{ secrets.S3_SECRET_ACCESS_KEY }}
```

For non-AWS providers, set `s3-endpoint`:

```yaml
- uses: zondax/kache-action@v1
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

      - uses: zondax/kache-action@v1
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

## Cache backends

| Backend | When | How |
|---------|------|-----|
| **GitHub Actions cache** | No S3 configured (default) | Saves/restores the local kache store via `@actions/cache`. Key is based on OS, arch, and `Cargo.lock` hash. |
| **S3** | `s3-bucket` is set | Uses `kache sync --pull` / `--push`. Supports AWS S3, MinIO, R2, etc. |

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
| `github-cache` | `true` | Use GitHub Actions cache when S3 is not configured |
| `cache-key-prefix` | `kache` | Prefix for the GitHub Actions cache key |
| `sync` | `true` | Pull remote cache on setup |
| `token` | `${{ github.token }}` | GitHub token for fetching releases and posting PR comments |

## How it works

**Setup step** (runs before your build):
1. Downloads the kache binary from [GitHub Releases](https://github.com/zondax/kache/releases) and verifies its SHA256 checksum
2. Sets `RUSTC_WRAPPER=kache` and exports S3 env vars if configured
3. Restores the cache — either `kache sync --pull` (S3) or `@actions/cache` restore (GitHub)

**Post step** (runs after your build, even on failure):
1. Saves the cache — either `kache sync --push` (S3) or `@actions/cache` save (GitHub)
2. Posts a sticky PR comment with hit rate and cache miss breakdown (updated in-place on re-runs)
3. Writes a job summary with cache stats, duration, and a collapsible `kache list` of all cache entries

On self-hosted runners, the kache binary is cached via `@actions/tool-cache` so it's only downloaded once per version.

## PR comments

On pull requests, the post step posts (or updates) a comment showing:

- Hit rate, local/remote hit counts, and miss count at a glance
- A collapsible table of cache misses sorted by compile time, so you can see which crates are the most expensive to rebuild

The comment is updated in-place on re-runs — no spam. Requires `pull-requests: write` permission on the token (the default `GITHUB_TOKEN` has this in most setups).

## License

Apache-2.0
