# Release promotion

The `release` branch is the opt-in plugin update channel. It initially points to the verified `v0.1.0-rc.2` commit. It includes prereleases and does not imply stable or fully validated native-host support. Keep immutable version tags for reproducibility and user rollback. Never promote ordinary development commits from `main`.

## Publisher sequence

1. Increment the package/plugin version, regenerate both payloads, and run `pnpm check`, `pnpm pack:release` and `pnpm verify:release -- --archives`. Review the release-manifest hashes and both host payloads. Commit and push the release source to `main`.
2. Wait for the exact commit's Verify CI success. Create and push its immutable version tag. Publish the explicit GitHub release with the plugin ZIP, consumer tarball, `SHA256SUMS` and `VERIFICATION.md`; retain prerelease status where applicable. Verify public downloads and consumers as described in [Verification](verification.md).
3. Wait for the tag's latest Verify run to finish successfully. From a current maintainer checkout, inspect promotion without writing:

   ```sh
   node scripts/promote-release.mjs v0.1.0-rc.2
   ```

4. Promote that same explicit version only after the preceding release verification is complete:

   ```sh
   node scripts/promote-release.mjs v0.1.0-rc.2 --apply
   ```

   The command prints the exact commit, CI run and previous channel commit, then reads back the remote branch. Inspect the new `release` branch Verify run as a post-publication check. If any response is uncertain, read the remote before retrying; the command is idempotent for the same verified commit.

## Gates and concurrency

The command is fixed to `Ksanbal/byeori` and uses the publisher's existing authenticated `gh` access. It accepts only explicit version tags, resolves annotated tags, requires a published release with all four uploaded assets, checks that the target belongs to `main` history, and requires the latest exact-tag/exact-SHA push run of `.github/workflows/ci.yml` plus its `verify` job to succeed. A pending, failed or skipped latest run is rejected; an older success cannot substitute for it. Release, tag and CI are checked again immediately before publication.

Only forward movement is allowed. GitHub enforces `force: false` on branch updates, so a stale concurrent publisher cannot roll back a newer channel commit. Concurrent first creation fails instead of replacing another publisher. Failures stop the command; no fallback force push, branch deletion or automatic rollback is provided.

The command checks release asset presence; public download/hash and consumer verification remain explicit publisher steps. Codex's Git updater does not use Byeori's archive `SHA256SUMS` as its update selection mechanism. CI changes or remote state changes after promotion are not locked by this command. Existing maintainers can still manually write the branch; no new branch protection, IAM policy, token scope or Actions permission is introduced. The existing CI keeps `contents: read`; channel promotion is the final publisher command, not an unattended Actions job.

## Consumers

Users make a one-time choice between an immutable tag and `release`; see [Installation](installation.md). New tags alone cannot migrate existing pinned users. Codex 0.161.0 checks configured Git marketplaces during app-server startup and refreshes installed caches when the source changes. This does not promise a recurring timer, immediate download, seamless live-session replacement, or automatic hook trust. Users can explicitly refresh, start a fresh session and review changed hooks through the host.
