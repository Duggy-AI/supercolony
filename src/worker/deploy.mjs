import { installRelease } from './install.mjs';
import { updateTargetState } from './context.mjs';
import { WORKER_ASSET } from './release.mjs';

export function buildDeployPlan({ ctx, release }) {
  return {
    target: { kind: ctx.kind, host: ctx.host ?? null, port: ctx.port ?? null },
    release: {
      tag: release.tag,
      version: release.version,
      htmlUrl: release.htmlUrl,
      tgzUrl: release.tgzUrl,
      sumsUrl: release.sumsUrl,
      assetDigest: release.assetDigest,
    },
    install: {
      prefix: ctx.prefix,
      imdPath: ctx.imdPath,
      workerHome: ctx.workerHome,
      steps: [
        'check node>=22, npm, git, forge, and a Claude/Codex runtime (report missing prerequisites; never install system packages)',
        `download ${release.tgzUrl} from the fixed tag ${release.tag}`,
        `download ${release.sumsUrl} and verify the SHA-256 of ${WORKER_ASSET}`,
        `npm install --global --prefix ${ctx.prefix} <verified ${WORKER_ASSET}>`,
        `verify ${ctx.imdPath} exists`,
        'record the install prefix/tag in colony worker state',
      ],
      doesNot: ['pair the device', 'register the ERC-8004 agent', 'install or start a service'],
    },
  };
}

export function recordInstall(ctx, release, result) {
  return updateTargetState(ctx.home, ctx.key, {
    prefix: ctx.prefix,
    workerHome: ctx.workerHome,
    ...(ctx.kind === 'ssh' ? { remoteHome: ctx.remoteHome, identity: ctx.identity } : {}),
    imdPath: result.imdPath,
    tag: release.tag,
    version: release.version,
    installedAt: new Date().toISOString(),
  });
}

export async function deployTarget({ ctx, release, fetchImpl, runNpm, log = () => {} }) {
  const result = await installRelease({
    ctx,
    release,
    prefix: ctx.prefix,
    fetchImpl,
    runNpm,
    log,
  });
  const state = recordInstall(ctx, release, result);
  log(`installed ${release.tag} at ${result.prefix}`);
  log('deploy does not pair, register, or start the worker');
  return { ...result, state };
}
