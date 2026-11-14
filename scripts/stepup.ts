/**
 * Step-up second factor (TOTP) for consent approval and /oauth/admin.
 *
 *   node dist/scripts/stepup.js keygen               prints a new STEPUP_KEY for gateway.env
 *   node dist/scripts/stepup.js enroll [--force]     new TOTP secret: prints the otpauth URI,
 *                                                    asks for a code, then stores it encrypted
 *   node dist/scripts/stepup.js status
 *   node dist/scripts/stepup.js reset                removes the secret (approvals then refuse)
 *
 * Docker (production): docker exec -it godseye-gateway node dist/scripts/stepup.js enroll
 * The secret is stored in the database encrypted with STEPUP_KEY (AES-256-GCM); the key lives
 * only in the env file, so a copy of the database or a backup does not reveal the secret.
 */
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Audit } from '../src/audit.js';
import { StepUp, deriveStepUpKey, parseStepUpKey } from '../src/auth/stepup.js';
import { generateTotpSecret, otpauthUri, verifyTotp } from '../src/auth/totp.js';
import { loadConfig, loadEnvFile } from '../src/config.js';
import { openDb } from '../src/db.js';
import { sessionSecretFor } from '../src/gateway.js';
import { createLogger } from '../src/log.js';

process.umask(0o077);
const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'keygen') {
  console.log(`STEPUP_KEY=${randomBytes(32).toString('base64url')}`);
  console.log('\nPut that line in deploy/secrets/gateway.env (docker) or .env (dev), mode 600.');
  process.exit(0);
}

if (process.env.GATEWAY_ENV_FILE !== 'none') loadEnvFile(process.env.GATEWAY_ENV_FILE || undefined);
const config = loadConfig();
const db = openDb(config.dbPath);
const key = config.STEPUP_KEY
  ? parseStepUpKey(config.STEPUP_KEY)
  : deriveStepUpKey(sessionSecretFor(config, db));
const stepup = new StepUp(db, {
  enabled: config.STEPUP_TOTP === 'on',
  windowS: config.STEPUP_WINDOW_S,
  key,
});
const audit = new Audit(db, createLogger({ level: 'warn' }));

function ask(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(q, (a) => {
      rl.close();
      resolve(a.trim());
    }),
  );
}

function usage(): never {
  console.error('usage: stepup keygen | enroll [--force] | status | reset');
  process.exit(2);
}

try {
  switch (cmd) {
    case 'enroll': {
      if (stepup.isEnrolled() && !rest.includes('--force')) {
        console.error('A step-up secret is already enrolled. Re-run with --force to replace it.');
        process.exit(1);
      }
      if (!config.STEPUP_KEY)
        console.warn(
          'Note: STEPUP_KEY is not set, so the secret is encrypted with a key derived from the session secret (dev only; production requires STEPUP_KEY).',
        );
      const secret = generateTotpSecret();
      console.log('Add this to your authenticator app (scan it as a QR code, or enter the key):\n');
      console.log(`  ${otpauthUri(secret, 'godseye-stepup')}\n`);
      console.log(`  key: ${secret.replace(/(.{4})/g, '$1 ').trim()}\n`);
      console.log(
        'To show it as a QR code in this terminal, pipe the URI to `qrencode -t ansiutf8` if you have it.\n',
      );
      if (!rest.includes('--no-confirm')) {
        const code = await ask('Enter the 6-digit code your app shows now to confirm: ');
        if (verifyTotp(secret, code.replace(/\s/g, '')) === null) {
          console.error('That code does not match. Nothing was stored; run enroll again.');
          process.exit(1);
        }
      }
      stepup.enroll(secret);
      audit.record('stepup_enrolled', { subject: 'cli' });
      console.log(
        `Enrolled. Approving a connection and opening /oauth/admin now need a code (step-up stays open ${Math.round(config.STEPUP_WINDOW_S / 60)} min).`,
      );
      if (config.STEPUP_TOTP !== 'on') console.log('Note: STEPUP_TOTP=off, so it is not enforced.');
      break;
    }
    case 'status': {
      const at = stepup.enrolledAt();
      console.log(
        `step-up: ${config.STEPUP_TOTP === 'on' ? 'on' : 'OFF'}; secret ${stepup.isEnrolled() ? `enrolled${at ? ` ${new Date(at).toISOString()}` : ''}` : 'NOT enrolled'}; key ${config.STEPUP_KEY ? 'STEPUP_KEY' : 'derived (dev only)'}; window ${config.STEPUP_WINDOW_S} s`,
      );
      break;
    }
    case 'reset': {
      stepup.reset();
      audit.record('stepup_reset', { subject: 'cli' });
      console.log('Step-up secret removed. Approvals and admin refuse until you enroll again.');
      break;
    }
    default:
      usage();
  }
} finally {
  db.close();
}
