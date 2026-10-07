// LINE bot: parses supported links posted in groups / 1:1 chats with the bot and replies
// with the video or post. Runs as its own process, sharing services/media.js with Discord.
const express = require('express');
const { middleware, messagingApi, HTTPFetchError } = require('@line/bot-sdk');
const { extractMediaUrls, downloadMedia } = require('./services/media');
const { PUBLIC_MEDIA_DIR, publishFiles, startMediaCleanup } = require('./services/publicMedia');

const channelSecret = process.env.LINE_CHANNEL_SECRET;
const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
// Public HTTPS origin LINE uses to fetch media, e.g. https://line.yohaneowo.com
const publicUrl = (process.env.LINE_PUBLIC_URL ?? '').replace(/\/+$/, '');
const port = Number(process.env.LINE_PORT) || 8787;
// Reply tokens expire quickly; when a slow download misses it, push instead (uses message quota).
const pushFallbackEnabled = process.env.LINE_PUSH_FALLBACK !== 'false';

if (!channelSecret || !channelAccessToken || !publicUrl) {
	console.error('LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN and LINE_PUBLIC_URL must be set.');
	process.exit(1);
}

// LINE limits: videos are mp4 up to 200 MB, images JPEG/PNG up to 10 MB. 50 MB keeps NAS uploads sane.
const MAX_MEDIA_BYTES = 50 * 1000 * 1000;
const MAX_URLS_PER_MESSAGE = 2;
const MAX_CONCURRENT_JOBS = 2;
const MAX_TEXT_LENGTH = 1500;

const client = new messagingApi.MessagingApiClient({ channelAccessToken });
let activeJobs = 0;

function mediaUrl(urlPath) {
	return `${publicUrl}/media/${urlPath}`;
}

// No link in the reply: the original message stays in the chat (LINE bots can't delete it),
// and a link here would only add another preview.
function formatText(media) {
	const text = media.text.length > MAX_TEXT_LENGTH ? `${media.text.slice(0, MAX_TEXT_LENGTH)}…` : media.text;
	const body = [media.author, text].filter(Boolean).join('\n') || media.site;
	return media.note ? `${body}\n（${media.note}）` : body;
}

// Downloads one link and turns it into LINE messages (author/text plus video/image).
async function buildMessagesForUrl(url) {
	const media = await downloadMedia(url, MAX_MEDIA_BYTES);
	try {
		const messages = [{ type: 'text', text: formatText(media) }];
		const published = await publishFiles(media.files);
		for (const file of published) {
			if (file.previewUrlPath) {
				messages.push({
					type: 'video',
					originalContentUrl: mediaUrl(file.urlPath),
					previewImageUrl: mediaUrl(file.previewUrlPath),
				});
			}
			else if (/\.(?:jpe?g|png)$/i.test(file.name)) {
				messages.push({
					type: 'image',
					originalContentUrl: mediaUrl(file.urlPath),
					previewImageUrl: mediaUrl(file.urlPath),
				});
			}
		}
		return messages;
	}
	finally {
		await media.cleanup();
	}
}

function getChatId(source) {
	return source.groupId ?? source.roomId ?? source.userId;
}

async function sendMessages(event, messages) {
	try {
		await client.replyMessage({ replyToken: event.replyToken, messages });
	}
	catch (error) {
		const expired = error instanceof HTTPFetchError && error.status === 400;
		if (!expired || !pushFallbackEnabled) throw error;
		console.warn('LINE reply token expired, falling back to push.');
		await client.pushMessage({ to: getChatId(event.source), messages });
	}
}

async function handleEvent(event) {
	if (event.type !== 'message' || event.message.type !== 'text') return;

	const urls = extractMediaUrls(event.message.text).slice(0, MAX_URLS_PER_MESSAGE);
	if (!urls.length) return;

	if (activeJobs >= MAX_CONCURRENT_JOBS) {
		await client.replyMessage({
			replyToken: event.replyToken,
			messages: [{ type: 'text', text: '⏳ 目前处理中的链接太多，请稍后再试' }],
		});
		return;
	}

	// LINE can't edit messages, so the only progress hint is the loading animation (1:1 chats only).
	if (event.source.type === 'user') {
		await client
			.showLoadingAnimation({ chatId: event.source.userId, loadingSeconds: 60 })
			.catch((error) => console.warn('LINE loading animation failed:', error.message));
	}

	activeJobs += 1;
	try {
		const messages = [];
		for (const url of urls) {
			try {
				messages.push(...(await buildMessagesForUrl(url)));
			}
			catch (error) {
				console.warn(`LINE media fetch failed for ${url}:`, error.message);
				messages.push({ type: 'text', text: error.userMessage ? `⚠️ ${error.userMessage}` : '❌ 解析失败了 😢' });
			}
		}
		// A single reply carries at most 5 messages.
		await sendMessages(event, messages.slice(0, 5));
	}
	finally {
		activeJobs -= 1;
	}
}

const app = express();

app.get('/', (req, res) => res.send('ok'));

// Signature-checked webhook. Respond right away and work in the background, since LINE
// expects a fast 200 and downloads can take a while.
app.post('/webhook', middleware({ channelSecret }), (req, res) => {
	res.sendStatus(200);
	for (const event of req.body.events ?? []) {
		handleEvent(event).catch((error) => console.error('LINE event handling failed:', error.message));
	}
});

app.use('/media', express.static(PUBLIC_MEDIA_DIR, { index: false, dotfiles: 'deny', fallthrough: false }));

// Signature failures and bad requests from the middleware land here.
app.use((error, req, res, next) => {
	if (res.headersSent) return next(error);
	console.warn(`Rejected ${req.method} ${req.path}:`, error.message);
	res.status(error.status ?? 400).send('bad request');
});

startMediaCleanup();
// Express 5 hands listen errors (e.g. EADDRINUSE, or EACCES on Windows-reserved ports) to the callback.
app.listen(port, (error) => {
	if (error) {
		console.error(`LINE bot could not listen on :${port}:`, error.code ?? error.message);
		process.exit(1);
	}
	console.log(`LINE bot listening on :${port} (public URL ${publicUrl}, push fallback ${pushFallbackEnabled ? 'on' : 'off'})`);
});
