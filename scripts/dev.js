// `npm run dev`: starts the Discord bot and, when .env.dev has LINE credentials, a Cloudflare
// tunnel plus the LINE bot, then points the LINE channel's webhook at the tunnel.
//
// Tunnel modes:
// - CLOUDFLARE_TUNNEL_TOKEN set: runs that named tunnel (fixed hostname from LINE_PUBLIC_URL,
//   e.g. https://line-dev.yohaneowo.com routed to http://host.docker.internal:8787).
// - Otherwise: a throwaway quick tunnel; its random https://*.trycloudflare.com URL becomes
//   LINE_PUBLIC_URL for this run.
//
// Ctrl+C stops everything. `npm run dev -- --line-only` skips the Discord bot.
const { spawn, execFileSync } = require('node:child_process');
const path = require('node:path');
const { messagingApi } = require('@line/bot-sdk');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = '.env.dev';
const LINE_PORT = 8787;
const TUNNEL_CONTAINER = 'yohaneowo-dev-tunnel';
const QUICK_TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const NAMED_TUNNEL_READY_PATTERN = /Registered tunnel connection/;

process.loadEnvFile(path.join(ROOT, ENV_FILE));
const lineEnabled = Boolean(process.env.LINE_CHANNEL_SECRET && process.env.LINE_CHANNEL_ACCESS_TOKEN);
const lineOnly = process.argv.includes('--line-only');
const tunnelToken = process.env.CLOUDFLARE_TUNNEL_TOKEN;

const children = [];
let shuttingDown = false;

function pipeWithPrefix(stream, prefix, onLine) {
	let buffer = '';
	stream.on('data', (chunk) => {
		buffer += chunk;
		const lines = buffer.split(/\r?\n/);
		buffer = lines.pop();
		for (const line of lines) {
			console.log(`${prefix} ${line}`);
			onLine?.(line);
		}
	});
}

function start(name, command, args, { env, onLine } = {}) {
	const child = spawn(command, args, { cwd: ROOT, env: { ...process.env, ...env }, windowsHide: true });
	pipeWithPrefix(child.stdout, `[${name}]`, onLine);
	pipeWithPrefix(child.stderr, `[${name}]`, onLine);
	child.on('exit', (code) => {
		console.log(`[${name}] exited with code ${code}`);
		if (!shuttingDown) shutdown(1);
	});
	children.push(child);
	return child;
}

function removeTunnelContainer() {
	try {
		execFileSync('docker', ['rm', '-f', TUNNEL_CONTAINER], { stdio: 'ignore' });
	}
	catch {
		// Container not running.
	}
}

function shutdown(code = 0) {
	if (shuttingDown) return;
	shuttingDown = true;
	for (const child of children) child.kill();
	if (lineEnabled) removeTunnelContainer();
	process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// Resolves with the public URL once the tunnel is up.
function startTunnel() {
	removeTunnelContainer();
	const tunnelArgs = tunnelToken
		? ['tunnel', '--no-autoupdate', 'run']
		: ['tunnel', '--no-autoupdate', '--url', `http://host.docker.internal:${LINE_PORT}`];
	// The token goes in through the environment so it never shows up in the process list.
	const dockerArgs = ['run', '--rm', '--name', TUNNEL_CONTAINER, ...(tunnelToken ? ['-e', 'TUNNEL_TOKEN'] : [])];

	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error('Timed out waiting for the tunnel (is Docker running?)')),
			90 * 1000,
		);
		start('tunnel', 'docker', [...dockerArgs, 'cloudflare/cloudflared:latest', ...tunnelArgs], {
			env: tunnelToken ? { TUNNEL_TOKEN: tunnelToken } : {},
			onLine: (line) => {
				const url = tunnelToken
					? NAMED_TUNNEL_READY_PATTERN.test(line) && process.env.LINE_PUBLIC_URL
					: line.match(QUICK_TUNNEL_URL_PATTERN)?.[0];
				if (url) {
					clearTimeout(timer);
					resolve(url.replace(/\/+$/, ''));
				}
			},
		});
	});
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// LINE rejects hostnames that don't resolve yet (fresh quick tunnels take a few seconds), so retry.
async function setLineWebhook(publicUrl) {
	const client = new messagingApi.MessagingApiClient({ channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN });
	const endpoint = `${publicUrl}/webhook`;

	for (let attempt = 1; attempt <= 12; attempt++) {
		await sleep(5000);
		try {
			await client.setWebhookEndpoint({ endpoint });
			const result = await client.testWebhookEndpoint({ endpoint });
			if (result.success) {
				console.log(`[dev] LINE webhook set and verified: ${endpoint}`);
				return;
			}
			console.log(`[dev] Webhook check ${attempt}/12: ${result.reason ?? result.detail ?? 'not ready'}`);
		}
		catch (error) {
			console.log(`[dev] Webhook check ${attempt}/12: ${error.body ?? error.message}`);
		}
	}
	console.warn(`[dev] Could not verify ${endpoint}; check the tunnel and the LINE console.`);
}

async function main() {
	if (!lineOnly) {
		start('dc', process.execPath, [`--env-file=${ENV_FILE}`, 'index.js']);
	}

	if (!lineEnabled) {
		console.log('[dev] LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN not set; starting Discord only.');
		return;
	}
	if (tunnelToken && !process.env.LINE_PUBLIC_URL) {
		throw new Error('CLOUDFLARE_TUNNEL_TOKEN is set, so LINE_PUBLIC_URL must be the tunnel hostname.');
	}

	const publicUrl = await startTunnel();
	console.log(`[dev] Tunnel ready: ${publicUrl}`);
	// Real environment variables win over --env-file, so this overrides LINE_PUBLIC_URL in .env.dev.
	start('line', process.execPath, [`--env-file=${ENV_FILE}`, 'line.js'], {
		env: { LINE_PUBLIC_URL: publicUrl, LINE_PORT: String(LINE_PORT) },
	});
	await setLineWebhook(publicUrl);
}

main().catch((error) => {
	console.error('[dev]', error.message);
	shutdown(1);
});
