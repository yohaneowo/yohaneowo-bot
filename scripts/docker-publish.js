// Builds the image with buildx and pushes it to Docker Hub: `node scripts/docker-publish.js <tag>...`
// (npm run docker:dev / docker:release). buildx publishes an OCI image index, the same format
// as most public images; Synology Container Manager's "update available" check didn't pick up
// the single-manifest images that plain `docker build` + `docker push` produced.
const { spawnSync } = require('node:child_process');

const IMAGE = 'yohane0w0/yohaneowo-bot';
// The default "docker" builder can't push an image index; a docker-container builder can.
const BUILDER = 'yohaneowo-builder';
const PLATFORM = 'linux/amd64';

const tags = process.argv.slice(2);
if (!tags.length) {
	console.error('Usage: node scripts/docker-publish.js <tag> [more tags...]');
	process.exit(1);
}

function docker(args, options = {}) {
	return spawnSync('docker', args, { stdio: 'inherit', ...options });
}

if (docker(['buildx', 'inspect', BUILDER], { stdio: 'ignore' }).status !== 0) {
	console.log(`Creating buildx builder ${BUILDER}…`);
	if (docker(['buildx', 'create', '--name', BUILDER, '--driver', 'docker-container']).status !== 0) process.exit(1);
}

const result = docker([
	'buildx', 'build',
	'--builder', BUILDER,
	'--platform', PLATFORM,
	...tags.flatMap((tag) => ['-t', `${IMAGE}:${tag}`]),
	'--push',
	'.',
]);
process.exit(result.status ?? 1);
