import { randomUUID } from 'node:crypto';
import { mkdir, open, realpath, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export const name = 'tool-openai-image';
export const inject = ['tools', 'credentials'];
export const API_URL = 'https://api.openai.com/v1/images/generations';
export const MODELS_URL = 'https://api.openai.com/v1/models';
const SIZES = ['1024x1024', '1536x1024', '1024x1536', 'auto'];
const QUALITIES = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'];
const FORMATS = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 180 * 1024 * 1024;

function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function checkChoice(value, allowed, field) {
  if (!allowed.includes(value)) throw fail(`${field} 必须为 ${allowed.join(' / ')}。`, 'INVALID_IMAGE_ARGUMENT');
  return value;
}

function isImageModel(value) {
  return typeof value === 'string' && (/^gpt-image-[\w.-]+$/.test(value) || value === 'chatgpt-image-latest');
}

function checkModelQuality(model, quality) {
  // Reject advanced quality on known older models. Future model capabilities
  // are validated by OpenAI, so new IDs do not require a plugin release.
  if (/^gpt-image-(?:1(?:[.-]|$)|2(?:$|-))/.test(model) && ['xhigh', 'max'].includes(quality)) {
    throw fail(`${model} 不支持 ${quality}；请选择 low、medium、high 或 auto。`, 'INVALID_IMAGE_ARGUMENT');
  }
}

export function normalizeConfig(raw = {}) {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  const config = {
    model: raw.model ?? 'gpt-image-2',
    apiKeyRef: raw.apiKeyRef ?? 'OPENAI_API_KEY',
    quality: raw.quality ?? 'medium',
    size: raw.size ?? '1024x1024',
    timeoutMs: raw.timeoutMs ?? 600000,
    outputDirectory: raw.outputDirectory ?? join(resolve(home), 'generated-images'),
  };
  if (!isImageModel(config.model)) throw new Error('model 必须是 gpt-image-* 模型名称或 chatgpt-image-latest。');
  if (typeof config.apiKeyRef !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.apiKeyRef)) throw new Error('apiKeyRef 必须是凭据引用名称，不能填写 API Key。');
  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 1800000) throw new Error('timeoutMs 必须介于 1000 和 1800000。');
  if (typeof config.outputDirectory !== 'string' || !isAbsolute(config.outputDirectory)) throw new Error('outputDirectory 必须是插件专用目录的绝对路径。');
  config.outputDirectory = resolve(config.outputDirectory);
  checkChoice(config.quality, QUALITIES, 'quality');
  checkModelQuality(config.model, config.quality);
  checkChoice(config.size, SIZES, 'size');
  return Object.freeze(config);
}

// Never put a credential or an unbounded upstream error into a tool result.
function safeMessage(value, key) {
  return String(value ?? '').split(key).join('[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]').slice(0, 600);
}

async function readResponse(response, signal, byteLimit = MAX_RESPONSE_BYTES) {
  if (!response.body) throw fail('绘图接口返回空响应。', 'EMPTY_IMAGE_RESPONSE');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > byteLimit) throw fail('绘图响应超出大小限制。', 'IMAGE_RESPONSE_TOO_LARGE');
      chunks.push(Buffer.from(next.value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fail(`绘图接口没有返回有效 JSON（HTTP ${response.status}）。`, 'INVALID_IMAGE_RESPONSE'); }
}

async function resolveApiKey(ctx, config) {
  const credential = await ctx.credentials.resolve(config.apiKeyRef);
  const key = credential?.value;
  if (typeof key !== 'string' || !key.trim()) throw fail(`未找到 ${config.apiKeyRef}。请在 DSH 模型设置保存 OpenAI API Key 后重试；无需把 Key 发到聊天中。`, 'MISSING_CREDENTIAL');
  return key;
}

async function requestOpenAi(url, key, signal, payload) {
  const options = {
    method: payload === undefined ? 'GET' : 'POST', redirect: 'error', signal,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  };
  if (payload !== undefined) options.body = JSON.stringify(payload);
  let response;
  try {
    // Native fetch inherits DSH's global HTTP proxy dispatcher.
    response = await globalThis.fetch(url, options);
  } catch (error) {
    signal.throwIfAborted();
    throw fail(`无法连接 OpenAI 接口：${safeMessage(error.cause?.message ?? error.message, key)}。检查 DSH HTTP 代理。未自动重试，以避免重复计费。`, 'IMAGE_TRANSPORT');
  }
  const body = await readResponse(response, signal, response.ok ? MAX_RESPONSE_BYTES : 65536);
  if (!response.ok) {
    const hint = response.status === 401 ? '请检查 DSH 保存的 OpenAI API Key。' : response.status === 403 ? '请检查账号的模型访问权限和组织验证状态。' : response.status === 429 ? '请检查余额或限流，稍后再试。' : '';
    throw fail(`OpenAI 请求失败（HTTP ${response.status}）：${safeMessage(body.error?.message ?? '请求未成功', key)} ${hint}`, `IMAGE_HTTP_${response.status}`);
  }
  return body;
}

export function createImageModelListTool(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig);
  const timeoutMs = Math.min(config.timeoutMs, 30000);
  return {
    name: 'list_image_models',
    description: '实时查询当前 OpenAI Key 可见的绘图模型名称，包括新发布的 gpt-image-* 模型和 chatgpt-image-latest。用户询问可用模型、最新模型或指定不确定的模型时先调用，再将准确 ID 填入 generate_image.model。每次查询刷新列表；仅查询模型目录，不生成图片。列表可见性不保证某项生成请求一定可用，具体参数和权限由 OpenAI 验证。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object', additionalProperties: false, required: ['default_model', 'models'],
        properties: {
          default_model: { type: 'string' },
          models: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) + '\n用户指定模型时，generate_image 的 model 填准确 ID；省略 model 时使用 default_model。不要悄悄替换用户指定的模型。' }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(timeoutMs)]);
      signal.throwIfAborted();
      const key = await resolveApiKey(ctx, config);
      const body = await requestOpenAi(MODELS_URL, key, signal);
      if (!Array.isArray(body.data)) throw fail('模型目录响应缺少模型列表。', 'INVALID_MODEL_RESPONSE');
      const models = [...new Set(body.data.map(item => item?.id).filter(isImageModel))].sort();
      return { default_model: config.model, models };
    },
  };
}

function decodeImage(item, format) {
  const encoded = item?.b64_json;
  if (typeof encoded !== 'string' || encoded.length === 0 || encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw fail('绘图接口未返回有效的 base64 图片，或图片超过 32 MiB。', 'INVALID_IMAGE_RESPONSE');
  }
  const bytes = Buffer.from(encoded, 'base64');
  const valid = format === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : format === 'jpeg' ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!valid || bytes.length > MAX_IMAGE_BYTES) throw fail('绘图接口返回的图片格式与请求不符。', 'INVALID_IMAGE_RESPONSE');
  return bytes;
}

export function createImageTool(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig);
  return {
    name: 'generate_image',
    description: '使用 OpenAI AI 绘图模型根据文字生成图片。用户指定绘图模型时务必填写 model；需要查询当前或最新模型时先调用 list_image_models。省略 model 使用插件默认模型。默认复用 DSH 已保存的 OPENAI_API_KEY，与聊天模型独立。图片保存到本机并返回路径，QQ 会话随后调用 qqbot_send_file 或 present 二选一交付。只在用户要求生成图片时调用，会使用 OpenAI 图像 API 额度。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: '完整的图片描述，支持中文；包括主体、风格、构图、颜色，以及需要原样出现在图中的文字。' },
        model: { type: 'string', description: '本次绘图使用的准确模型 ID，例如 gpt-image-2.6-flare、gpt-image-2.6-sunburst 或 chatgpt-image-latest。可用名称通过 list_image_models 实时查询；省略时沿用插件默认模型。用户指定时必须传入，不自动降级。' },
        size: { type: 'string', enum: SIZES, description: '默认 1024x1024；横图 1536x1024，竖图 1024x1536。' },
        quality: { type: 'string', enum: QUALITIES, description: '默认 medium；low 用于草稿，high 用于成品。xhigh/max 供支持这些档位的新模型使用，gpt-image-2 和 1.x 不支持。' },
        n: { type: 'integer', minimum: 1, maximum: 4, description: '同一提示词的图片数量，默认 1，最多 4。' },
        output_format: { type: 'string', enum: Object.keys(FORMATS), description: '默认 png；可选 jpeg/webp。' },
        background: { type: 'string', enum: ['auto', 'opaque', 'transparent'], description: '默认 auto；透明背景必须使用 png 或 webp。' },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false, required: ['model', 'images'],
        properties: {
          model: { type: 'string' },
          images: { type: 'array', items: {
            type: 'object', additionalProperties: false, required: ['file_path', 'mime_type', 'bytes'],
            properties: { file_path: { type: 'string' }, mime_type: { type: 'string' }, bytes: { type: 'integer' } },
          } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) + '\n图片已生成并保存。QQ 会话请调用 qqbot_send_file（file_path 使用上述绝对路径，省略 target）；也可调用 present，二选一，避免重复发送。网页会话可用 present 或 Markdown 图片展示。不要把本地路径当成 QQ 可直接访问的图片链接。' }],
    },
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 32000) throw fail('prompt 必须为 1–32000 字符的图片描述。', 'INVALID_IMAGE_ARGUMENT');
      const model = args.model ?? config.model;
      if (!isImageModel(model)) throw fail('model 必须是准确的 gpt-image-* ID 或 chatgpt-image-latest；可先调用 list_image_models 查询。', 'INVALID_IMAGE_ARGUMENT');
      const size = checkChoice(args.size ?? config.size, SIZES, 'size');
      const quality = checkChoice(args.quality ?? config.quality, QUALITIES, 'quality');
      checkModelQuality(model, quality);
      const format = checkChoice(args.output_format ?? 'png', Object.keys(FORMATS), 'output_format');
      const background = checkChoice(args.background ?? 'auto', ['auto', 'opaque', 'transparent'], 'background');
      const n = args.n ?? 1;
      if (!Number.isInteger(n) || n < 1 || n > 4) throw fail('n 必须为 1–4。', 'INVALID_IMAGE_ARGUMENT');
      if (background === 'transparent' && format === 'jpeg') throw fail('透明背景请使用 png 或 webp。', 'INVALID_IMAGE_ARGUMENT');
      const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(config.timeoutMs)]);
      signal.throwIfAborted();
      const key = await resolveApiKey(ctx, config);
      // App-owned output storage, never a model-selected write path. Reject symlinked roots.
      await mkdir(config.outputDirectory, { recursive: true, mode: 0o700 });
      const root = await realpath(config.outputDirectory);
      if (root !== config.outputDirectory) throw fail('图片输出目录含符号链接；请把 outputDirectory 配置为实际目录的绝对路径。', 'UNSAFE_IMAGE_DIRECTORY');
      signal.throwIfAborted();
      const body = await requestOpenAi(API_URL, key, signal, { model, prompt: args.prompt, n, size, quality, output_format: format, background });
      if (!Array.isArray(body.data) || body.data.length !== n) throw fail('绘图响应中的图片数量与请求不符。', 'INVALID_IMAGE_RESPONSE');
      const decoded = body.data.map(item => decodeImage(item, format));
      signal.throwIfAborted();
      const images = [];
      const created = [];
      try {
        for (const bytes of decoded) {
          signal.throwIfAborted();
          const path = join(root, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.${format === 'jpeg' ? 'jpg' : format}`);
          // Only clean up files whose exclusive creation succeeded in this call.
          const handle = await open(path, 'wx', 0o600);
          created.push(path);
          try { await handle.writeFile(bytes, { signal }); }
          finally { await handle.close(); }
          images.push({ file_path: path, mime_type: FORMATS[format], bytes: bytes.length });
        }
        signal.throwIfAborted();
      } catch (error) {
        await Promise.allSettled(created.map(path => unlink(path)));
        throw error;
      }
      return { model, images };
    },
  };
}

export function apply(ctx, config) {
  ctx.tools.register(createImageTool(ctx, config));
  ctx.tools.register(createImageModelListTool(ctx, config));
  ctx.logger.info('generate_image and list_image_models registered (OpenAI credentials + DSH network policy)');
}
