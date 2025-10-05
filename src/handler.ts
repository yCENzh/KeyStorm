import { DurableObject } from 'cloudflare:workers';
import { isAdminAuthenticated } from './auth';

class HttpError extends Error {
	status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = this.constructor.name;
		this.status = status;
	}
}

const fixCors = ({ headers, status, statusText }: { headers?: HeadersInit; status?: number; statusText?: string }) => {
	const newHeaders = new Headers(headers);
	newHeaders.set('Access-Control-Allow-Origin', '*');
	newHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
	newHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-goog-api-key');
	return { headers: newHeaders, status, statusText };
};

const BASE_URL = 'https://generativelanguage.googleapis.com';
const API_VERSION = 'v1beta';
const API_CLIENT = 'genai-js/0.21.0';

const makeHeaders = (apiKey: string, more?: Record<string, string>) => ({
	'x-goog-api-client': API_CLIENT,
	...(apiKey && { 'x-goog-api-key': apiKey }),
	...more,
});

/** A Durable Object's behavior is defined in an exported Javascript class */
export class LoadBalancer extends DurableObject {
	env: Env;
	/**
	 * The constructor is invoked once upon creation of the Durable Object, i.e. the first call to
	 * 	`DurableObjectStub::get` for a given identifier (no-op constructors can be omitted)
	 *
	 * @param ctx - The interface for interacting with Durable Object state
	 * @param env - The interface to reference bindings declared in wrangler.jsonc
	 */
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.env = env;
		// Initialize the database schema upon first creation.
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS api_keys (
				api_key TEXT PRIMARY KEY,
				endpoint_path TEXT DEFAULT '/'
			);
			CREATE TABLE IF NOT EXISTS api_key_statuses (
				api_key TEXT PRIMARY KEY,
				status TEXT CHECK(status IN ('normal', 'abnormal')) NOT NULL DEFAULT 'normal',
				last_checked_at INTEGER,
				failed_count INTEGER NOT NULL DEFAULT 0,
				key_group TEXT CHECK(key_group IN ('normal', 'abnormal')) NOT NULL DEFAULT 'normal',
				endpoint_path TEXT DEFAULT '/',
				FOREIGN KEY(api_key) REFERENCES api_keys(api_key) ON DELETE CASCADE
			);
		`);
		this.ctx.storage.setAlarm(Date.now() + 5 * 60 * 1000); // Set an alarm to run in 5 minutes
	}

	async alarm() {
		// 1. Handle abnormal keys
		const abnormalKeys = await this.ctx.storage.sql
			.exec("SELECT api_key, failed_count FROM api_key_statuses WHERE key_group = 'abnormal'")
			.raw<any>();

		for (const row of Array.from(abnormalKeys)) {
			const apiKey = row[0] as string;
			const failedCount = row[1] as number;

			try {
				const response = await fetch(`${BASE_URL}/${API_VERSION}/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						contents: [{ parts: [{ text: 'hi' }] }],
					}),
				});
				if (response.ok) {
					// Key is working again, move it back to the normal group
					await this.ctx.storage.sql.exec(
						"UPDATE api_key_statuses SET key_group = 'normal', failed_count = 0, last_checked_at = ? WHERE api_key = ?",
						Date.now(),
						apiKey
					);
				} else if (response.status === 429) {
					// Still getting 429, increment failed_count
					const newFailedCount = failedCount + 1;
					await this.ctx.storage.sql.exec(
						'UPDATE api_key_statuses SET failed_count = ?, last_checked_at = ? WHERE api_key = ?',
						newFailedCount,
						Date.now(),
						apiKey
					);
				}
			} catch (e) {
				console.error(`Error checking abnormal key ${apiKey}:`, e);
			}
		}

		// 2. Handle normal keys
		const twelveHoursAgo = Date.now() - 12 * 60 * 60 * 1000;
		const normalKeys = await this.ctx.storage.sql
			.exec(
				"SELECT api_key FROM api_key_statuses WHERE key_group = 'normal' AND (last_checked_at IS NULL OR last_checked_at < ?)",
				twelveHoursAgo
			)
			.raw<any>();

		for (const row of Array.from(normalKeys)) {
			const apiKey = row[0] as string;
			try {
				const response = await fetch(`${BASE_URL}/${API_VERSION}/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						contents: [{ parts: [{ text: 'hi' }] }],
					}),
				});
				if (response.status === 429) {
					// Move to abnormal group
					await this.ctx.storage.sql.exec(
						"UPDATE api_key_statuses SET key_group = 'abnormal', failed_count = 1, last_checked_at = ? WHERE api_key = ?",
						Date.now(),
						apiKey
					);
				} else {
					// Update last_checked_at
					await this.ctx.storage.sql.exec('UPDATE api_key_statuses SET last_checked_at = ? WHERE api_key = ?', Date.now(), apiKey);
				}
			} catch (e) {
				// 即使检查失败，也不删除密钥，只更新失败计数
				await this.ctx.storage.sql.exec(
					"UPDATE api_key_statuses SET key_group = 'abnormal', failed_count = failed_count + 1, last_checked_at = ? WHERE api_key = ?",
					Date.now(),
					apiKey
				);
				console.error(`Error checking normal key ${apiKey}:`, e);
			}
		}

		// Reschedule the alarm
		this.ctx.storage.setAlarm(Date.now() + 5 * 60 * 1000);
	}

	async fetch(request: Request): Promise<Response> {
		if (request.method === 'OPTIONS') {
			return new Response(null, {
				status: 204,
				headers: fixCors({}).headers,
			});
		}
		const url = new URL(request.url);
		const pathname = url.pathname;

		// 静态资源直接放行
		if (pathname === '/favicon.ico' || pathname === '/robots.txt') {
			return new Response('', { status: 204 });
		}

		// 管理 API 权限校验（使用 HOME_ACCESS_KEY）
		if (pathname === '/api/keys' || pathname === '/api/keys/check' || pathname === '/api/endpoints') {
			if (!isAdminAuthenticated(request, this.env.HOME_ACCESS_KEY)) {
				return new Response(JSON.stringify({ error: 'Unauthorized' }) as any, {
					status: 401,
					headers: fixCors({ headers: { 'Content-Type': 'application/json' } }).headers,
				});
			}
			if (pathname === '/api/keys' && request.method === 'POST') {
				return this.handleApiKeys(request);
			}
			if (pathname === '/api/keys' && request.method === 'GET') {
				return this.getAllApiKeys(request);
			}
			if (pathname === '/api/keys' && request.method === 'DELETE') {
				return this.handleDeleteApiKeys(request);
			}
			if (pathname === '/api/keys/check' && request.method === 'POST') {
				return this.handleApiKeysCheck(request);
			}
			if (pathname === '/api/endpoints' && request.method === 'GET') {
				return this.getAllEndpoints(request);
			}
		}

		const search = url.search;

		// OpenAI compatible routes
		if (
			pathname.endsWith('/chat/completions') ||
			pathname.endsWith('/completions') ||
			pathname.endsWith('/embeddings') ||
			pathname.endsWith('/v1/models')
		) {
			// 提取端点路径（除了API路由部分）
			const endpointPath = this.extractEndpointPath(pathname);
			return this.handleOpenAI(request, endpointPath);
		}

		// Direct Gemini proxy
		const authKey = this.env.AUTH_KEY;

		let targetUrl = `${BASE_URL}${pathname}${search}`;

		if (this.env.FORWARD_CLIENT_KEY_ENABLED) {
			return this.forwardRequestWithLoadBalancing(targetUrl, request, pathname);
		}

		if (authKey) {
			let isAuthorized = false;
			// Check key in query parameters
			if (search.includes('key=')) {
				const urlObj = new URL(targetUrl);
				const requestKey = urlObj.searchParams.get('key');
				if (requestKey && requestKey === authKey) {
					isAuthorized = true;
				}
			} else {
				// Check x-goog-api-key in headers
				const requestKey = request.headers.get('x-goog-api-key');
				if (requestKey && requestKey === authKey) {
					isAuthorized = true;
				}
			}

			if (!isAuthorized) {
				return new Response('Unauthorized', { status: 401, headers: fixCors({}).headers });
			}
		}
		// If authKey is not set, or if it was authorized, proceed to forward with load balancing.
		return this.forwardRequestWithLoadBalancing(targetUrl, request, pathname);
	}

	async forwardRequest(targetUrl: string, request: Request, headers: Headers, apiKey: string): Promise<Response> {
		console.log(`Request Sending to Gemini: ${targetUrl}`);

		const response = await fetch(targetUrl, {
			method: request.method,
			headers: headers,
			body: request.method === 'GET' || request.method === 'HEAD' ? null : request.body,
		});

		if (response.status === 429) {
			console.log(`API key ${apiKey} received 429 status code.`);
			// 不再删除密钥，只更新状态
			await this.ctx.storage.sql.exec(
				"UPDATE api_key_statuses SET key_group = 'abnormal', failed_count = failed_count + 1, last_checked_at = ? WHERE api_key = ?",
				Date.now(),
				apiKey
			);
		}

		console.log('Call Gemini Success');

		const responseHeaders = new Headers(response.headers);
		responseHeaders.set('Access-Control-Allow-Origin', '*');
		responseHeaders.delete('transfer-encoding');
		responseHeaders.delete('connection');
		responseHeaders.delete('keep-alive');
		responseHeaders.delete('content-encoding');
		responseHeaders.set('Referrer-Policy', 'no-referrer');

		return new Response(response.body, {
			status: response.status,
			headers: responseHeaders,
		});
	}

	// 对请求进行负载均衡，随机分发key
	private async forwardRequestWithLoadBalancing(targetUrl: string, request: Request, pathname: string): Promise<Response> {
		try {
			let headers = new Headers();
			const url = new URL(targetUrl);

			// Forward content-type header
			if (request.headers.has('content-type')) {
				headers.set('content-type', request.headers.get('content-type')!);
			}

			if (this.env.FORWARD_CLIENT_KEY_ENABLED) {
				return this.forwardRequest(url.toString(), request, headers, ''); // No specific key for forwarded client key
			}
			
			// 提取端点路径
			const endpointPath = this.extractEndpointPath(pathname);
			const apiKey = await this.getRandomApiKey(endpointPath);
			if (!apiKey) {
				return new Response('No API keys configured in the load balancer for this endpoint.', { status: 500 });
			}

			url.searchParams.set('key', apiKey);
			headers.set('x-goog-api-key', apiKey);
			return this.forwardRequest(url.toString(), request, headers, apiKey);
		} catch (error) {
			console.error('Failed to fetch:', error);
			return new Response('Internal Server Error\n' + error, {
				status: 500,
				headers: { 'Content-Type': 'text/plain' },
			});
		}
	}

	async handleModels(apiKey: string) {
		const response = await fetch(`${BASE_URL}/${API_VERSION}/models`, {
			headers: makeHeaders(apiKey),
		});

		let responseBody: BodyInit | null = response.body;
		if (response.ok) {
			const { models } = JSON.parse(await response.text());
			responseBody = JSON.stringify(
				{
					object: 'list',
					data: models.map(({ name }: any) => ({
						id: name.replace('models/', ''),
						object: 'model',
						created: 0,
						owned_by: '',
					})),
				},
				null,
				'  '
			);
		}
		return new Response(responseBody, fixCors(response));
	}

	async handleEmbeddings(req: any, apiKey: string) {
		const DEFAULT_EMBEDDINGS_MODEL = 'text-embedding-004';

		if (typeof req.model !== 'string') {
			throw new HttpError('model is not specified', 400);
		}

		let model;
		if (req.model.startsWith('models/')) {
			model = req.model;
		} else {
			if (!req.model.startsWith('gemini-')) {
				req.model = DEFAULT_EMBEDDINGS_MODEL;
			}
			model = 'models/' + req.model;
		}

		if (!Array.isArray(req.input)) {
			req.input = [req.input];
		}

		const response = await fetch(`${BASE_URL}/${API_VERSION}/${model}:batchEmbedContents`, {
			method: 'POST',
			headers: makeHeaders(apiKey, { 'Content-Type': 'application/json' }),
			body: JSON.stringify({
				requests: req.input.map((text: string) => ({
					model,
					content: { parts: { text } },
					outputDimensionality: req.dimensions,
				})),
			}),
		});

		let responseBody: BodyInit | null = response.body;
		if (response.ok) {
			const { embeddings } = JSON.parse(await response.text());
			responseBody = JSON.stringify(
				{
					object: 'list',
					data: embeddings.map(({ values }: any, index: number) => ({
						object: 'embedding',
						index,
						embedding: values,
					})),
					model: req.model,
				},
				null,
				'  '
			);
		}
		return new Response(responseBody, fixCors(response));
	}

	async handleCompletions(req: any, apiKey: string) {
		const DEFAULT_MODEL = 'gemini-2.5-flash';
		let model = DEFAULT_MODEL;

		switch (true) {
			case typeof req.model !== 'string':
				break;
			case req.model.startsWith('models/'):
				model = req.model.substring(7);
				break;
			case req.model.startsWith('gemini-'):
			case req.model.startsWith('gemma-'):
			case req.model.startsWith('learnlm-'):
				model = req.model;
		}

		let body = await this.transformRequest(req);
		const extra = req.extra_body?.google;

		if (extra) {
			if (extra.safety_settings) {
				body.safetySettings = extra.safety_settings;
			}
			if (extra.cached_content) {
				body.cachedContent = extra.cached_content;
			}
			if (extra.thinking_config) {
				body.generationConfig.thinkingConfig = extra.thinking_config;
			}
		}

		switch (true) {
			case model.endsWith(':search'):
				model = model.substring(0, model.length - 7);
			case req.model.endsWith('-search-preview'):
			case req.tools?.some((tool: any) => tool.function?.name === 'googleSearch'):
				body.tools = body.tools || [];
				body.tools.push({ function_declarations: [{ name: 'googleSearch', parameters: {} }] });
		}

		const TASK = req.stream ? 'streamGenerateContent' : 'generateContent';
		let url = `${BASE_URL}/${API_VERSION}/models/${model}:${TASK}`;
		if (req.stream) {
			url += '?alt=sse';
		}

		const response = await fetch(url, {
			method: 'POST',
			headers: makeHeaders(apiKey, { 'Content-Type': 'application/json' }),
			body: JSON.stringify(body),
		});

		let responseBody: BodyInit | null = response.body;
		if (response.ok) {
			let id = 'chatcmpl-' + this.generateId();
			const shared = {};

			if (req.stream) {
				responseBody = response
					.body!.pipeThrough(new TextDecoderStream())
					.pipeThrough(
						new TransformStream({
							transform: this.parseStream,
							flush: this.parseStreamFlush,
							buffer: '',
							shared,
						} as any)
					)
					.pipeThrough(
						new TransformStream({
							transform: this.toOpenAiStream,
							flush: this.toOpenAiStreamFlush,
							streamIncludeUsage: req.stream_options?.include_usage,
							model,
							id,
							last: [],
							shared,
						} as any)
					)
					.pipeThrough(new TextEncoderStream());
			} else {
				let body: any = await response.text();
				try {
					body = JSON.parse(body);
					if (!body.candidates) {
						throw new Error('Invalid completion object');
					}
				} catch (err) {
					console.error('Error parsing response:', err);
					return new Response(JSON.stringify({ error: 'Failed to parse response' }), {
						...fixCors(response),
						status: 500,
					});
				}
				responseBody = this.processCompletionsResponse(body, model, id);
			}
		}
		return new Response(responseBody, fixCors(response));
	}

	// 辅助方法
	private generateId(): string {
		const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		const randomChar = () => characters[Math.floor(Math.random() * characters.length)];
		return Array.from({ length: 29 }, randomChar).join('');
	}

	private async transformRequest(req: any) {
		const harmCategory = [
			'HARM_CATEGORY_HATE_SPEECH',
			'HARM_CATEGORY_SEXUALLY_EXPLICIT',
			'HARM_CATEGORY_DANGEROUS_CONTENT',
			'HARM_CATEGORY_HARASSMENT',
			'HARM_CATEGORY_CIVIC_INTEGRITY',
		];

		const safetySettings = harmCategory.map((category) => ({
			category,
			threshold: 'BLOCK_NONE',
		}));

		return {
			...(await this.transformMessages(req.messages)),
			safetySettings,
			generationConfig: this.transformConfig(req),
			...this.transformTools(req),
			cachedContent: undefined as any,
		};
	}

	private transformConfig(req: any) {
		const fieldsMap: Record<string, string> = {
			frequency_penalty: 'frequencyPenalty',
			max_completion_tokens: 'maxOutputTokens',
			max_tokens: 'maxOutputTokens',
			n: 'candidateCount',
			presence_penalty: 'presencePenalty',
			seed: 'seed',
			stop: 'stopSequences',
			temperature: 'temperature',
			top_k: 'topK',
			top_p: 'topP',
		};

		const thinkingBudgetMap: Record<string, number> = {
			low: 1024,
			medium: 8192,
			high: 24576,
		};

		let cfg: any = {};
		for (let key in req) {
			const matchedKey = fieldsMap[key];
			if (matchedKey) {
				cfg[matchedKey] = req[key];
			}
		}

		if (req.response_format) {
			switch (req.response_format.type) {
				case 'json_schema':
					cfg.responseSchema = req.response_format.json_schema?.schema;
					if (cfg.responseSchema && 'enum' in cfg.responseSchema) {
						cfg.responseMimeType = 'text/x.enum';
						break;
					}
				case 'json_object':
					cfg.responseMimeType = 'application/json';
					break;
				case 'text':
					cfg.responseMimeType = 'text/plain';
					break;
				default:
					throw new HttpError('Unsupported response_format.type', 400);
			}
		}
		if (req.reasoning_effort) {
			cfg.thinkingConfig = { thinkingBudget: thinkingBudgetMap[req.reasoning_effort] };
		}

		return cfg;
	}

private async transformMessages(messages: any[]) {
	if (!messages) {
		return {};
	}

	const contents: any[] = [];
	let system_instruction;

	for (const item of messages) {
		switch (item.role) {
			case 'system':
				system_instruction = { parts: await this.transformMsg(item) };
				continue;
			case 'assistant':
				item.role = 'model';
				break;
			case 'user':
				break;
			default:
				throw new HttpError(`Unknown message role: "${item.role}"`, 400);
		}

		if (system_instruction) {
			// 修复：确保 parts 是数组后再调用 some 方法
			if (!contents[0]?.parts || 
				(Array.isArray(contents[0]?.parts) && !contents[0]?.parts.some((part: any) => part.text))) {
				contents.unshift({ role: 'user', parts: [{ text: ' ' }] });
			}
		}

		contents.push({
			role: item.role,
			parts: await this.transformMsg(item),
		});
	}

	return { system_instruction, contents };
}

	private async transformMsg({ content }: any) {
		const parts = [];
		if (!Array.isArray(content)) {
			parts.push({ text: content });
			return parts;
		}

		for (const item of content) {
			switch (item.type) {
				case 'text':
					parts.push({ text: item.text });
					break;
				case 'image_url':
					parts.push(await this.parseImg(item.image_url.url));
					break;
				case 'input_audio':
					parts.push({
						inlineData: {
							mimeType: 'audio/' + item.input_audio.format,
							data: item.input_audio.data,
						},
					});
					break;
				default:
					throw new HttpError(`Unknown "content" item type: "${item.type}"`, 400);
			}
		}

		if (content.every((item) => item.type === 'image_url')) {
			parts.push({ text: '' }); // to avoid "Unable to submit request because it must have a text parameter"
		}
		return parts;
	}
	private async parseImg(url: any) {
		let mimeType, data;
		if (url.startsWith('http://') || url.startsWith('https://')) {
			try {
				const response = await fetch(url);
				if (!response.ok) {
					throw new Error(`${response.status} ${response.statusText} (${url})`);
				}
				mimeType = response.headers.get('content-type');
				// 使用Cloudflare Workers兼容的API替换Buffer
				const arrayBuffer = await response.arrayBuffer();
				data = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
			} catch (err) {
				throw new Error('Error fetching image: ' + (err as Error).message);
			}
		} else {
			const match = url.match(/^data:(?<mimeType>.*?)(;base64)?,(?<data>.*)$/);
			if (!match) {
				throw new HttpError('Invalid image data: ' + url, 400);
			}
			({ mimeType, data } = match.groups);
		}
		return {
			inlineData: {
				mimeType,
				data,
			},
		};
	}

	private adjustSchema(schema: any) {
		const obj = schema[schema.type];
		delete obj.strict;
		return this.adjustProps(schema);
	}

	private adjustProps(schemaPart: any) {
		if (typeof schemaPart !== 'object' || schemaPart === null) {
			return;
		}
		if (Array.isArray(schemaPart)) {
			schemaPart.forEach(this.adjustProps);
		} else {
			if (schemaPart.type === 'object' && schemaPart.properties && schemaPart.additionalProperties === false) {
				delete schemaPart.additionalProperties;
			}
			Object.values(schemaPart).forEach(this.adjustProps);
		}
	}

	private transformTools(req: any) {
		let tools, tool_config;
		if (req.tools) {
			const funcs = req.tools.filter((tool: any) => tool.type === 'function' && tool.function?.name !== 'googleSearch');
			if (funcs.length > 0) {
				funcs.forEach(this.adjustSchema);
				tools = [{ function_declarations: funcs.map((schema: any) => schema.function) }];
			}
		}
		if (req.tool_choice) {
			const allowed_function_names = req.tool_choice?.type === 'function' ? [req.tool_choice?.function?.name] : undefined;
			if (allowed_function_names || typeof req.tool_choice === 'string') {
				tool_config = {
					function_calling_config: {
						mode: allowed_function_names ? 'ANY' : req.tool_choice.toUpperCase(),
						allowed_function_names,
					},
				};
			}
		}
		return { tools, tool_config };
	}

	private processCompletionsResponse(data: any, model: string, id: string) {
		const reasonsMap: Record<string, string> = {
			STOP: 'stop',
			MAX_TOKENS: 'length',
			SAFETY: 'content_filter',
			RECITATION: 'content_filter',
		};

		const transformCandidatesMessage = (cand: any) => {
			const message = { role: 'assistant', content: [] as string[] };
			for (const part of cand.content?.parts ?? []) {
				if (part.text) {
					message.content.push(part.text);
				}
			}

			return {
				index: cand.index || 0,
				message: {
					...message,
					content: message.content.join('') || null,
				},
				logprobs: null,
				finish_reason: reasonsMap[cand.finishReason] || cand.finishReason,
			};
		};

		const obj = {
			id,
			choices: data.candidates.map(transformCandidatesMessage),
			created: Math.floor(Date.now() / 1000),
			model: data.modelVersion ?? model,
			object: 'chat.completion',
			usage: data.usageMetadata && {
				completion_tokens: data.usageMetadata.candidatesTokenCount,
				prompt_tokens: data.usageMetadata.promptTokenCount,
				total_tokens: data.usageMetadata.totalTokenCount,
			},
		};

		return JSON.stringify(obj);
	}

	// 流处理方法
	private parseStream(this: any, chunk: string, controller: any) {
		this.buffer += chunk;
		const lines = this.buffer.split('\n');
		this.buffer = lines.pop()!;

		for (const line of lines) {
			if (line.startsWith('data: ')) {
				const data = line.substring(6);
				if (data.startsWith('{')) {
					controller.enqueue(JSON.parse(data));
				}
			}
		}
	}

	private parseStreamFlush(this: any, controller: any) {
		if (this.buffer) {
			try {
				controller.enqueue(JSON.parse(this.buffer));
				this.shared.is_buffers_rest = true;
			} catch (e) {
				console.error('Error parsing remaining buffer:', e);
			}
		}
	}

	private toOpenAiStream(this: any, line: any, controller: any) {
		const reasonsMap: Record<string, string> = {
			STOP: 'stop',
			MAX_TOKENS: 'length',
			SAFETY: 'content_filter',
			RECITATION: 'content_filter',
		};

		const { candidates, usageMetadata } = line;
		if (usageMetadata) {
			this.shared.usage = {
				completion_tokens: usageMetadata.candidatesTokenCount,
				prompt_tokens: usageMetadata.promptTokenCount,
				total_tokens: usageMetadata.totalTokenCount,
			};
		}

		if (candidates) {
			for (const cand of candidates) {
				const { index, content, finishReason } = cand;
				const { parts } = content;
				const text = parts.map((p: any) => p.text).join('');

				if (this.last[index] === undefined) {
					this.last[index] = '';
				}

				const lastText = this.last[index] || '';
				let delta = '';

				if (text.startsWith(lastText)) {
					delta = text.substring(lastText.length);
				} else {
					// Find the common prefix
					let i = 0;
					while (i < text.length && i < lastText.length && text[i] === lastText[i]) {
						i++;
					}
					// Send the rest of the new text as delta.
					// This might not be perfect for all clients, but it prevents data loss.
					delta = text.substring(i);
				}

				this.last[index] = text;

				const obj = {
					id: this.id,
					object: 'chat.completion.chunk',
					created: Math.floor(Date.now() / 1000),
					model: this.model,
					choices: [
						{
							index,
							delta: { content: delta },
							finish_reason: reasonsMap[finishReason] || finishReason,
						},
					],
				};
				controller.enqueue(`data: ${JSON.stringify(obj)}\n\n`);
			}
		}
	}

	private toOpenAiStreamFlush(this: any, controller: any) {
		if (this.streamIncludeUsage && this.shared.usage) {
			const obj = {
				id: this.id,
				object: 'chat.completion.chunk',
				created: Math.floor(Date.now() / 1000),
				model: this.model,
				choices: [
					{
						index: 0,
						delta: {},
						finish_reason: 'stop',
					},
				],
				usage: this.shared.usage,
			};
			controller.enqueue(`data: ${JSON.stringify(obj)}\n\n`);
		}
		controller.enqueue('data: [DONE]\n\n');
	}
	// =================================================================================================
	// Admin API Handlers
	// =================================================================================================

	async handleApiKeys(request: Request): Promise<Response> {
		try {
			const { keys, endpointPath = '/' } = (await request.json()) as { keys: string[]; endpointPath?: string };
			if (!Array.isArray(keys) || keys.length === 0) {
				return new Response(JSON.stringify({ error: '请求体无效，需要一个包含key的非空数组。' }), {
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			// 标准化端点路径
			const normalizedPath = endpointPath === '/' ? '/' : `/${endpointPath.replace(/^\/+|\/+$/g, '')}/`;

			for (const key of keys) {
				await this.ctx.storage.sql.exec('INSERT OR IGNORE INTO api_keys (api_key, endpoint_path) VALUES (?, ?)', key, normalizedPath);
				await this.ctx.storage.sql.exec('INSERT OR IGNORE INTO api_key_statuses (api_key, endpoint_path) VALUES (?, ?)', key, normalizedPath);
			}

			return new Response(JSON.stringify({ message: `API密钥添加成功，端点路径: ${normalizedPath}` }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		} catch (error: any) {
			console.error('处理API密钥失败:', error);
			return new Response(JSON.stringify({ error: error.message || '内部服务器错误' }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			});
		}
	}

	async handleDeleteApiKeys(request: Request): Promise<Response> {
		try {
			const { keys, endpointPath } = (await request.json()) as { keys: string[]; endpointPath?: string };
			if (!Array.isArray(keys) || keys.length === 0) {
				return new Response(JSON.stringify({ error: '请求体无效，需要一个包含key的非空数组。' }), {
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			if (endpointPath) {
				const normalizedPath = endpointPath === '/' ? '/' : `/${endpointPath.replace(/^\/+|\/+$/g, '')}/`;
				const batchSize = 500;
				for (let i = 0; i < keys.length; i += batchSize) {
					const batch = keys.slice(i, i + batchSize);
					const placeholders = batch.map(() => '?').join(',');
					await this.ctx.storage.sql.exec(`DELETE FROM api_keys WHERE api_key IN (${placeholders}) AND endpoint_path = ?`, ...batch, normalizedPath);
				}
			} else {
				const batchSize = 500;
				for (let i = 0; i < keys.length; i += batchSize) {
					const batch = keys.slice(i, i + batchSize);
					const placeholders = batch.map(() => '?').join(',');
					await this.ctx.storage.sql.exec(`DELETE FROM api_keys WHERE api_key IN (${placeholders})`, ...batch);
				}
			}

			return new Response(JSON.stringify({ message: 'API密钥删除成功。' }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		} catch (error: any) {
			console.error('删除API密钥失败:', error);
			return new Response(JSON.stringify({ error: error.message || '内部服务器错误' }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			});
		}
	}

	async handleApiKeysCheck(request: Request): Promise<Response> {
		try {
			const { keys, endpointPath } = (await request.json()) as { keys: string[]; endpointPath?: string };
			if (!Array.isArray(keys) || keys.length === 0) {
				return new Response(JSON.stringify({ error: '请求体无效，需要一个包含key的非空数组。' }), {
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			const checkResults = await Promise.all(
				keys.map(async (key) => {
					try {
						const response = await fetch(`${BASE_URL}/${API_VERSION}/models/gemini-2.5-flash:generateContent?key=${key}`, {
							method: 'POST',
							headers: {
								'Content-Type': 'application/json',
							},
							body: JSON.stringify({
								contents: [{ parts: [{ text: 'hi' }] }],
							}),
						});
						return { key, valid: response.ok, error: response.ok ? null : await response.text() };
					} catch (e: any) {
						return { key, valid: false, error: e.message };
					}
				})
			);

			for (const result of checkResults) {
				if (result.valid) {
					if (endpointPath) {
						const normalizedPath = endpointPath === '/' ? '/' : `/${endpointPath.replace(/^\/+|\/+$/g, '')}/`;
						await this.ctx.storage.sql.exec(
							"UPDATE api_key_statuses SET status = 'normal', key_group = 'normal', failed_count = 0, last_checked_at = ? WHERE api_key = ? AND endpoint_path = ?",
							Date.now(),
							result.key,
							normalizedPath
						);
					} else {
						await this.ctx.storage.sql.exec(
							"UPDATE api_key_statuses SET status = 'normal', key_group = 'normal', failed_count = 0, last_checked_at = ? WHERE api_key = ?",
							Date.now(),
							result.key
						);
					}
				} else {
					// 不直接删除无效密钥，而是将它们标记为异常状态
					if (endpointPath) {
						const normalizedPath = endpointPath === '/' ? '/' : `/${endpointPath.replace(/^\/+|\/+$/g, '')}/`;
						await this.ctx.storage.sql.exec(
							"UPDATE api_key_statuses SET status = 'abnormal', key_group = 'abnormal', failed_count = failed_count + 1, last_checked_at = ? WHERE api_key = ? AND endpoint_path = ?",
							Date.now(),
							result.key,
							normalizedPath
						);
					} else {
						await this.ctx.storage.sql.exec(
							"UPDATE api_key_statuses SET status = 'abnormal', key_group = 'abnormal', failed_count = failed_count + 1, last_checked_at = ? WHERE api_key = ?",
							Date.now(),
							result.key
						);
					}
				}
			}

			return new Response(JSON.stringify(checkResults), {
				headers: { 'Content-Type': 'application/json' },
			});
		} catch (error: any) {
			console.error('检查API密钥失败:', error);
			return new Response(JSON.stringify({ error: error.message || '内部服务器错误' }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			});
		}
	}

	async getAllApiKeys(request: Request): Promise<Response> {
		try {
			const url = new URL(request.url);
			const page = parseInt(url.searchParams.get('page') || '1', 10);
			const pageSize = parseInt(url.searchParams.get('pageSize') || '50', 10);
			const endpointPath = url.searchParams.get('endpointPath') || null;
			const offset = (page - 1) * pageSize;

			let totalResult, results;
			
			if (endpointPath) {
				const normalizedPath = endpointPath === '/' ? '/' : `/${endpointPath.replace(/^\/+|\/+$/g, '')}/`;
				totalResult = await this.ctx.storage.sql.exec('SELECT COUNT(*) as count FROM api_key_statuses WHERE endpoint_path = ?', normalizedPath).raw<any>();
				results = await this.ctx.storage.sql
					.exec('SELECT api_key, status, key_group, last_checked_at, failed_count, endpoint_path FROM api_key_statuses WHERE endpoint_path = ? LIMIT ? OFFSET ?', normalizedPath, pageSize, offset)
					.raw<any>();
			} else {
				totalResult = await this.ctx.storage.sql.exec('SELECT COUNT(*) as count FROM api_key_statuses').raw<any>();
				results = await this.ctx.storage.sql
					.exec('SELECT api_key, status, key_group, last_checked_at, failed_count, endpoint_path FROM api_key_statuses LIMIT ? OFFSET ?', pageSize, offset)
					.raw<any>();
			}

			const totalArray = Array.from(totalResult);
			const total = totalArray.length > 0 ? totalArray[0][0] : 0;

			const keys = results
				? Array.from(results).map((row: any) => ({
						api_key: row[0],
						status: row[1],
						key_group: row[2],
						last_checked_at: row[3],
						failed_count: row[4],
						endpoint_path: row[5]
				  }))
				: [];

			return new Response(JSON.stringify({ keys, total }), {
				headers: { 'Content-Type': 'application/json' },
			});
		} catch (error: any) {
			console.error('获取API密钥失败:', error);
			return new Response(JSON.stringify({ error: error.message || '内部服务器错误' }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			});
		}
	}

	async getAllEndpoints(request: Request): Promise<Response> {
		try {
			const results = await this.ctx.storage.sql
				.exec("SELECT DISTINCT endpoint_path FROM api_key_statuses")
				.raw<any>();
			
			const endpoints = Array.from(results).map((row: any) => row[0]);
			
			return new Response(JSON.stringify({ endpoints }), {
				headers: { 'Content-Type': 'application/json' },
			});
		} catch (error: any) {
			console.error('获取端点列表失败:', error);
			return new Response(JSON.stringify({ error: error.message || '内部服务器错误' }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			});
		}
	}

	// =================================================================================================
	// Helper Methods
	// =================================================================================================

	private async getRandomApiKey(endpointPath: string = '/'): Promise<string | null> {
		try {
			// 标准化端点路径
			const normalizedPath = endpointPath === '/' ? '/' : `/${endpointPath.replace(/^\/+|\/+$/g, '')}/`;
			
			// First, try to get a key from the normal group for the specific endpoint
			let results = await this.ctx.storage.sql
				.exec("SELECT api_key FROM api_key_statuses WHERE key_group = 'normal' AND endpoint_path = ? ORDER BY RANDOM() LIMIT 1", normalizedPath)
				.raw<any>();
			let keys = Array.from(results);
			if (keys && keys.length > 0) {
				const key = keys[0][0] as string;
				console.log(`Gemini Selected API Key from normal group for endpoint ${normalizedPath}: ${key}`);
				return key;
			}

			// If no keys in normal group, try the abnormal group for the specific endpoint
			results = await this.ctx.storage.sql
				.exec("SELECT api_key FROM api_key_statuses WHERE key_group = 'abnormal' AND endpoint_path = ? ORDER BY RANDOM() LIMIT 1", normalizedPath)
				.raw<any>();
			keys = Array.from(results);
			if (keys && keys.length > 0) {
				const key = keys[0][0] as string;
				console.log(`Gemini Selected API Key from abnormal group for endpoint ${normalizedPath}: ${key}`);
				return key;
			}

			// 如果指定端点没有密钥，回退到默认端点
			if (normalizedPath !== '/') {
				return this.getRandomApiKey('/');
			}

			return null;
		} catch (error) {
			console.error('获取随机API密钥失败:', error);
			return null;
		}
	}

	private async handleOpenAI(request: Request, endpointPath: string = '/'): Promise<Response> {
		const authKey = this.env.AUTH_KEY;
		let apiKey: string | null;

		const authHeader = request.headers.get('Authorization');
		apiKey = authHeader?.replace('Bearer ', '') ?? null;
		if (!apiKey) {
			return new Response('No API key found in the client headers,please check your request!', { status: 400 });
		}

		if (authKey && !this.env.FORWARD_CLIENT_KEY_ENABLED) {
			const authHeader = request.headers.get('Authorization');
			const token = authHeader?.replace('Bearer ', '');
			if (token !== authKey) {
				return new Response('Unauthorized', { status: 401, headers: fixCors({}).headers });
			}
			apiKey = await this.getRandomApiKey(endpointPath);
			if (!apiKey) {
				return new Response(`No API keys configured in the load balancer for endpoint: ${endpointPath}`, { status: 500 });
			}
		}

		const url = new URL(request.url);
		const pathname = url.pathname;

		const assert = (success: Boolean) => {
			if (!success) {
				throw new HttpError('The specified HTTP method is not allowed for the requested resource', 400);
			}
		};
		const errHandler = (err: Error) => {
			console.error(err);
			return new Response(err.message, fixCors({ statusText: err.message ?? 'Internal Server Error', status: 500 }));
		};

		switch (true) {
			case pathname.endsWith('/chat/completions'):
				assert(request.method === 'POST');
				return this.handleCompletions(await request.json(), apiKey).catch(errHandler);
			case pathname.endsWith('/embeddings'):
				assert(request.method === 'POST');
				return this.handleEmbeddings(await request.json(), apiKey).catch(errHandler);
			case pathname.endsWith('/models'):
				assert(request.method === 'GET');
				return this.handleModels(apiKey).catch(errHandler);
			default:
				throw new HttpError('404 Not Found', 404);
		}
	}

	private extractEndpointPath(pathname: string): string {
		// 移除 OpenAI API 路由部分
		const openaiRoutes = ['/v1/chat/completions', '/v1/completions', '/v1/embeddings', '/v1/models'];
		
		for (const route of openaiRoutes) {
			if (pathname.endsWith(route)) {
				const endpointPath = pathname.substring(0, pathname.length - route.length);
				return endpointPath === '' ? '/' : endpointPath;
			}
		}
		
		// 如果不是 OpenAI 路由，则尝试提取自定义端点路径
		// 例如: /yCENzh/v1/chat/completions -> /yCENzh/
		const parts = pathname.split('/').filter(part => part !== '');
		if (parts.length > 0 && !openaiRoutes.includes(pathname)) {
			return `/${parts[0]}/`;
		}
		
		return '/';
	}
}
