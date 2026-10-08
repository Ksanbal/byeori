import type { ReviewSubmission } from '../../src/contracts';
import { submitReview } from '../../src/core/review';

const [root, encoded] = process.argv.slice(2);
const submission = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as ReviewSubmission;
try { const receipt = await submitReview(root, submission); process.send?.(receipt); process.disconnect?.(); }
catch (error) { process.stderr.write(String(error)); process.exitCode = 1; process.disconnect?.(); }
