// Uses the installed DSH credential provider and proxy policy; never prints API keys.
// Without --generate this only checks configuration and the model catalog.
import { execFileSync } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { createImageTool, createImageModelListTool } from '../index.js';

let dshRoot = process.env.DSH_INSTALL_DIR;
if (!dshRoot) {
  const executable = await realpath(execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim());
  dshRoot = dirname(dirname(executable));
}
const requireDsh = createRequire(join(dshRoot, 'package.json'));
const load = name => import(pathToFileURL(requireDsh.resolve(name)).href);
const { Context } = await load('@deepseek-ai/cordis');
const { LocalCredentialProvider } = await load('@deepseek-ai/dsh-credentials-local');
const { createLaunchEnvironmentSnapshot } = await load('@deepseek-ai/dsh-launch-environment');
const { installProxyFromEnvironment, proxyRouteFor } = await load('@deepseek-ai/dsh-http-proxy');
const home = resolve(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'));
const envPath = join(home, '.env');
const savedEnv = await readFile(envPath, 'utf8').then(parseEnv).catch(error => {
  if (error.code === 'ENOENT') return {};
  throw error;
});
// Match DSH's precedence: a launch environment variable overrides its .env fallback.
const environment = createLaunchEnvironmentSnapshot([
  { source: 'process', values: process.env },
  { source: 'user-env', path: envPath, values: savedEnv },
]);
const restore = await installProxyFromEnvironment(environment, message => console.error(message));
const ctx = new Context();
ctx.provide('launchEnvironment', environment);
try {
  await ctx.plugin(LocalCredentialProvider, { dshHome: home, watch: false });
  const info = await ctx.credentials.describe('OPENAI_API_KEY');
  console.log(JSON.stringify({ credentialConfigured: info.configured, credentialSource: info.source, openaiUsesProxy: proxyRouteFor(new URL('https://api.openai.com')).proxied }));
  if (!info.configured) throw new Error('DSH OPENAI_API_KEY is not configured');
  const modelOption = process.argv.indexOf('--model');
  const model = modelOption < 0 ? undefined : process.argv[modelOption + 1];
  if (modelOption >= 0 && (!model || model.startsWith('--'))) throw new Error('--model requires an image model ID');
  if (process.argv.includes('--generate')) {
    const tool = createImageTool(ctx);
    const started = Date.now();
    const result = await tool.execute({
      prompt: 'A friendly tiny blue whale robot painting a colorful picture at an easel, warm clean storybook illustration, white background, no text, square composition.',
      quality: 'low', n: 1,
      ...(model === undefined ? {} : { model }),
    }, { signal: AbortSignal.timeout(tool.timeoutMs) });
    console.log(JSON.stringify({ elapsedSeconds: Math.round((Date.now() - started) / 1000), ...result }, null, 2));
  } else {
    const tool = createImageModelListTool(ctx);
    console.log(JSON.stringify(await tool.execute({}, { signal: AbortSignal.timeout(tool.timeoutMs) }), null, 2));
  }
} finally {
  await ctx.fiber.dispose();
  await restore();
}
