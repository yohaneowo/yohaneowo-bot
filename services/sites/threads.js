const fs = require('node:fs/promises');
const path = require('node:path');
const { fitVideoToLimit } = require('./video');
const { downloadToFile, imageExtension } = require('./download');

// Threads has no yt-dlp extractor and its pages are a login shell, but the web app's own
// endpoints answer logged-out requests (the approach vxThreads uses):
//   1. /ajax/bulk-route-definitions/ turns a post path into its numeric post id;
//   2. /api/graphql runs BarcelonaPostPageTargetQuery for the post data.
// The query's doc id and its ~40 "provided variables" change whenever Threads ships, so they're
// read from Threads' own JS bundles, cached, and re-read when a query fails.
const ORIGIN = 'https://www.threads.com';
const QUERY_NAME = 'BarcelonaPostPageTargetQuery';
const IG_APP_ID = '238260118697367';
const BROWSER_USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36';
// Share links only answer crawlers with a real HTTP redirect; browsers get a JS-redirect page.
const CRAWLER_USER_AGENT = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)';
const REQUEST_TIMEOUT_MS = 15 * 1000;
const CONFIG_TTL_MS = 12 * 60 * 60 * 1000;
const BUNDLE_FETCH_CONCURRENCY = 8;
const MAX_FILES = 10;
const MAX_REDIRECTS = 5;
const THREADS_HOST_PATTERN = /^(?:www\.)?threads\.(?:com|net)$/i;
const POST_PATH_PATTERN = /^\/@[\w.]+\/post\/[\w-]+/;
const MEDIA_URL_PATTERN = /^https:\/\/[\w.-]+\.(?:cdninstagram\.com|fbcdn\.net)\//i;

let cachedConfig = null;

function request(url, options = {}) {
	return fetch(url, {
		...options,
		headers: { 'User-Agent': BROWSER_USER_AGENT, ...options.headers },
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
}

function formBody(fields) {
	return new URLSearchParams(fields).toString();
}

// Share links (/share/<code>) redirect to /@user/post/<code>; follow them by hand so every hop
// stays on Threads.
async function resolvePostPath(url) {
	let current = new URL(url);
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		if (!THREADS_HOST_PATTERN.test(current.hostname)) {
			throw new Error(`Threads link redirected off-site to ${current.hostname}`);
		}
		const postPath = current.pathname.match(POST_PATH_PATTERN)?.[0];
		if (postPath) return postPath;

		const response = await request(current.href, {
			redirect: 'manual',
			headers: { 'User-Agent': CRAWLER_USER_AGENT },
		});
		const location = response.headers.get('location');
		if (!location) {
			throw new Error(`Threads link did not lead to a post (HTTP ${response.status})`);
		}
		current = new URL(location, current);
	}
	throw new Error('Too many redirects resolving the Threads link');
}

// Reads the current doc id, provided-variable names and LSD token from a post page's bundles.
async function discoverQueryConfig(postPath) {
	const html = await (await request(`${ORIGIN}${postPath}`)).text();
	const lsd = html.match(/"LSD",\[\],\{"token":"([^"]+)"/)?.[1];
	const bundleUrls = [
		...new Set(
			(html.match(/https:\\?\/\\?\/static\.cdninstagram\.com\\?\/rsrc\.php\\?\/[^"\s]+?\.js\b[^"\s]*/g) ?? []).map(
				(bundleUrl) => bundleUrl.replace(/\\\//g, '/'),
			),
		),
	];

	let found = null;
	const queue = [...bundleUrls];
	await Promise.all(
		Array.from({ length: BUNDLE_FETCH_CONCURRENCY }, async () => {
			while (queue.length && !found) {
				const js = await request(queue.shift())
					.then((response) => response.text())
					.catch(() => '');
				const start = js.indexOf(`name:"${QUERY_NAME}"`);
				if (start < 0) continue;

				const docId = js.match(
					new RegExp(`__d\\("${QUERY_NAME}_threadsRelayOperation",\\[\\],\\(function\\([^)]*\\)\\{a\\.exports="(\\d+)"`),
				)?.[1];
				const providers = [...new Set(js.slice(start, js.indexOf('}}', start)).match(/__relay_internal__pv__\w+/g))];
				if (docId) found = { docId, providers };
			}
		}),
	);

	if (!found || !lsd) {
		throw new Error(`Could not find ${QUERY_NAME} in the Threads web bundles`);
	}
	return { ...found, lsd, expiresAt: Date.now() + CONFIG_TTL_MS };
}

async function getQueryConfig(postPath, refresh) {
	if (refresh || !cachedConfig || cachedConfig.expiresAt < Date.now()) {
		cachedConfig = await discoverQueryConfig(postPath);
	}
	return cachedConfig;
}

function apiHeaders(lsd) {
	return {
		Accept: '*/*',
		'Content-Type': 'application/x-www-form-urlencoded',
		'X-FB-LSD': lsd,
		'X-IG-App-ID': IG_APP_ID,
		'Sec-Fetch-Site': 'same-origin',
	};
}

async function fetchPostId(postPath, lsd) {
	const response = await request(`${ORIGIN}/ajax/bulk-route-definitions/`, {
		method: 'POST',
		headers: apiHeaders(lsd),
		body: formBody({ 'route_urls[0]': postPath, __a: '1', __comet_req: '29', lsd }),
	});
	// The body is prefixed with "for (;;);" to stop JSON hijacking.
	const payload = JSON.parse((await response.text()).replace(/^for \(;;\);/, ''));
	const route = Object.values(payload?.payload?.payloads ?? {})[0];
	const postId = route?.result?.exports?.rootView?.props?.post_id;
	if (!postId) {
		throw new Error('Threads post not found (deleted or private?)');
	}
	return postId;
}

async function queryPost(postId, config) {
	const variables = { postID: postId, sort_order: 'TOP' };
	for (const name of config.providers) variables[name] = false;

	const response = await request(`${ORIGIN}/api/graphql`, {
		method: 'POST',
		headers: { ...apiHeaders(config.lsd), 'X-FB-Friendly-Name': QUERY_NAME },
		body: formBody({ lsd: config.lsd, variables: JSON.stringify(variables), doc_id: config.docId }),
	});
	const payload = await response.json();
	const post = payload?.data?.media;
	if (!post) {
		throw new Error(`Threads query failed: ${payload?.errors?.[0]?.message ?? 'no post data'}`);
	}
	return post;
}

async function fetchPost(url) {
	const postPath = await resolvePostPath(url);
	const config = await getQueryConfig(postPath, false);
	const postId = await fetchPostId(postPath, config.lsd);
	try {
		return await queryPost(postId, config);
	}
	catch (error) {
		// Most likely Threads shipped a new doc id or variables: re-read the bundles and retry once.
		console.warn(`${error.message}; refreshing the Threads query config.`);
		return queryPost(postId, await getQueryConfig(postPath, true));
	}
}

function hasMedia(post) {
	return Boolean(post?.carousel_media?.length || post?.video_versions?.length || post?.image_versions2?.candidates?.length);
}

function formatAuthor(user) {
	if (!user?.username) return '';
	return user.full_name && user.full_name !== user.username ? `${user.full_name} @${user.username}` : `@${user.username}`;
}

async function downloadItem(item, dir, index) {
	const videoUrl = item.video_versions?.[0]?.url;
	if (videoUrl) {
		const filePath = path.join(dir, `video-${index}.mp4`);
		await downloadToFile(videoUrl, filePath, MEDIA_URL_PATTERN);
		return { path: filePath, name: `video-${index}.mp4`, isVideo: true };
	}

	const candidates = item.image_versions2?.candidates ?? [];
	const imageUrl = candidates.reduce((best, candidate) => ((candidate.width ?? 0) > (best?.width ?? 0) ? candidate : best), null)?.url;
	if (!imageUrl) return null;
	const tempPath = path.join(dir, `image-${index}`);
	const extension = imageExtension(await downloadToFile(imageUrl, tempPath, MEDIA_URL_PATTERN)) ?? 'jpg';
	const filePath = `${tempPath}.${extension}`;
	await fs.rename(tempPath, filePath);
	return { path: filePath, name: `image-${index}.${extension}`, isVideo: false };
}

// Posts, quote posts and carousels: a post with no media of its own (e.g. a quote of a video)
// shows the quoted post's media, with its author and text appended.
async function fetchThreadsPost(url, dir, maxBytes, onStage) {
	const post = await fetchPost(url);
	const quoted =
		post.text_post_app_info?.share_info?.quoted_attachment_post ??
		post.text_post_app_info?.share_info?.quoted_post ??
		post.text_post_app_info?.share_info?.reposted_post;
	const source = hasMedia(post) ? post : hasMedia(quoted) ? quoted : null;

	const textParts = [post.caption?.text];
	if (quoted && source === quoted) {
		textParts.push(`↪ ${formatAuthor(quoted.user)}：${quoted.caption?.text ?? ''}`.trim());
	}
	const result = {
		files: [],
		author: formatAuthor(post.user),
		text: textParts.filter(Boolean).join('\n\n'),
		compressed: false,
	};
	if (!source) return result;

	onStage?.('downloading');
	const items = (source.carousel_media?.length ? source.carousel_media : [source]).slice(0, MAX_FILES);

	// A single video may be compressed to fit; with several items, keep whatever fits as-is.
	if (items.length === 1) {
		const file = await downloadItem(items[0], dir, 1);
		if (file?.isVideo) {
			const { filePath, compressed } = await fitVideoToLimit(file.path, dir, maxBytes, onStage);
			result.files.push({ path: filePath, name: 'video.mp4' });
			result.compressed = compressed;
		}
		else if (file) {
			result.files.push(file);
		}
		return result;
	}

	let totalBytes = 0;
	for (const [index, item] of items.entries()) {
		const file = await downloadItem(item, dir, index + 1);
		if (!file) continue;
		const { size } = await fs.stat(file.path);
		if (totalBytes + size > maxBytes) continue;
		totalBytes += size;
		result.files.push(file);
	}
	if (result.files.length < items.length) {
		result.note = `共 ${items.length} 个媒体，受上传上限只附上 ${result.files.length} 个`;
	}
	return result;
}

module.exports = {
	fetchThreadsPost,
};
