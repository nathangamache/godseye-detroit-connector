/**
 * Generates GATEWAY_PASSWORD_HASH (scrypt) and, with --totp, a new GATEWAY_TOTP_SECRET.
 * Reads the password from stdin (no echo when run in a terminal) so it never lands in shell history.
 *
 *   npm run build && npm run hash-password -- --totp
 */
import { createInterface } from 'node:readline';
import { hashPassword } from '../src/auth/password.js';
import { generateTotpSecret, otpauthUri } from '../src/auth/totp.js';

async function readPassword(prompt: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY,
  });
  const out = rl as unknown as {
    _writeToOutput?: (s: string) => void;
    output: NodeJS.WritableStream;
  };
  if (process.stdin.isTTY) {
    out._writeToOutput = (s: string) => {
      if (s.includes(prompt)) out.output.write(prompt);
    };
  }
  return new Promise((resolve) =>
    rl.question(prompt, (a) => {
      rl.close();
      if (process.stdin.isTTY) process.stdout.write('\n');
      resolve(a);
    }),
  );
}

const pw = await readPassword('New gateway password: ');
if (pw.length < 12) {
  console.error('Use at least 12 characters.');
  process.exit(1);
}
const hash = await hashPassword(pw);
console.log('\nAdd to the gateway .env (mode 600):\n');
console.log(`GATEWAY_PASSWORD_HASH=${hash}`);
if (process.argv.includes('--totp')) {
  const secret = generateTotpSecret();
  console.log(`GATEWAY_TOTP_SECRET=${secret}`);
  console.log(
    `\nAdd it to an authenticator app (manual entry) or via this URI:\n${otpauthUri(secret)}`,
  );
}
