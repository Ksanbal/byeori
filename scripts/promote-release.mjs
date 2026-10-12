import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const repository = 'Ksanbal/byeori';
const shaPattern = /^[a-f0-9]{40}$/;
const tagPattern = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const check = (condition, message) => { if (!condition) throw new Error(message); };

export function githubApi(path, method = 'GET', body) {
  const args = ['api', '--hostname', 'github.com', `repos/${repository}/${path}`, '--method', method];
  if (body) args.push('--input', '-');
  return JSON.parse(execFileSync('gh', args, {
    encoding: 'utf8', input: body ? JSON.stringify(body) : undefined,
    stdio: ['pipe', 'pipe', 'pipe'],
  }));
}

async function tagCommit(api, tag) {
  let object = (await api(`git/ref/tags/${tag}`)).object;
  for (let depth = 0; object?.type === 'tag' && depth < 5; depth++) {
    check(shaPattern.test(object.sha), 'Invalid tag object');
    object = (await api(`git/tags/${object.sha}`)).object;
  }
  check(object?.type === 'commit' && shaPattern.test(object.sha), 'Tag must resolve to a commit');
  return object.sha;
}

async function verifiedCandidate(api, tag) {
  const sha = await tagCommit(api, tag);
  const release = await api(`releases/tags/${tag}`);
  check(release.tag_name === tag && release.draft === false && release.published_at,
    'A published release is required (prereleases are allowed)');
  const version = tag.slice(1);
  for (const name of [`byeori-${version}-plugins.zip`, `byeori-${version}.tgz`, 'SHA256SUMS', 'VERIFICATION.md']) {
    check(release.assets?.some(asset => asset.name === name && asset.state === 'uploaded' && asset.size > 0),
      `Missing uploaded release asset: ${name}`);
  }
  const main = (await api('git/ref/heads/main')).object?.sha;
  check(shaPattern.test(main), 'Invalid main commit');
  const ancestry = await api(`compare/${sha}...${main}`);
  check(['ahead', 'identical'].includes(ancestry.status) && ancestry.behind_by === 0,
    'Release commit must belong to main history');
  // Do not filter for success: a newer failed/pending run must supersede an older success.
  const runs = await api(`actions/workflows/ci.yml/runs?branch=${tag}&event=push&head_sha=${sha}&per_page=1`);
  const run = runs.workflow_runs?.[0];
  check(run?.head_sha === sha && run.head_branch === tag && run.event === 'push'
    && run.path === '.github/workflows/ci.yml' && run.status === 'completed' && run.conclusion === 'success',
  'Latest tag Verify run must have completed successfully for this exact commit');
  const jobs = await api(`actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
  check(jobs.jobs?.some(job => job.name === 'verify' && job.status === 'completed' && job.conclusion === 'success'),
    'The verify job must actually pass, not be skipped');
  return { sha, runId: run.id, runAttempt: run.run_attempt, releaseUrl: release.html_url };
}

export async function promoteRelease(tag, { api = githubApi, apply = false } = {}) {
  check(tagPattern.test(tag), 'Expected an explicit version tag such as v0.1.0-rc.2');
  const candidate = await verifiedCandidate(api, tag);
  // Matching refs distinguishes an absent branch from network/authentication failures.
  const refs = await api('git/matching-refs/heads/release');
  const current = refs.find(ref => ref.ref === 'refs/heads/release')?.object?.sha;
  if (current) {
    check(shaPattern.test(current), 'Invalid release branch commit');
    const ancestry = await api(`compare/${current}...${candidate.sha}`);
    check(['ahead', 'identical'].includes(ancestry.status) && ancestry.behind_by === 0,
      'Refusing stale, backward or divergent promotion');
  }
  const result = { repository, tag, ...candidate, previous: current ?? null, applied: false };
  if (!apply || current === candidate.sha) return result;
  // Recheck mutable release, tag and CI observations immediately before the write.
  const fresh = await verifiedCandidate(api, tag);
  check(fresh.sha === candidate.sha && fresh.runId === candidate.runId && fresh.runAttempt === candidate.runAttempt,
    'Tag or CI changed during verification; retry after reviewing the new state');
  if (current) {
    // GitHub atomically rejects non-fast-forward updates, including a stale concurrent publisher.
    await api('git/refs/heads/release', 'PATCH', { sha: candidate.sha, force: false });
  } else {
    // Concurrent creation fails instead of overwriting the winner. Re-read before retrying.
    await api('git/refs', 'POST', { ref: 'refs/heads/release', sha: candidate.sha });
  }
  const observed = (await api('git/ref/heads/release')).object?.sha;
  check(observed === candidate.sha, 'Release branch changed after publication; inspect remote before retrying');
  return { ...result, applied: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [tag, flag, ...extra] = process.argv.slice(2);
    check(tag && (!flag || flag === '--apply') && extra.length === 0,
      'Usage: node scripts/promote-release.mjs <version-tag> [--apply] (default: read-only)');
    console.log(JSON.stringify(await promoteRelease(tag, { apply: flag === '--apply' }), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
