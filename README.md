# DSH OpenAI Image · AI 绘图插件

让 **DeepSeek Harness（DSH）** 拥有 `generate_image` 工具。在 DSH 网页或 QQ 对话中用自然语言描述图片，插件调用 OpenAI 图像 API，保存真实图片，再由 DSH 展示或通过 QQ 发送。

**聊天用 DeepSeek，画图用 OpenAI。** 绘图与聊天模型独立，默认复用 DSH 已保存的 `OPENAI_API_KEY`，不需要再配置一份 Key。

## 能做什么

- 文字生成照片、插画、海报、封面等图片；提示词支持中文。
- `list_image_models` 实时发现账号可见的绘图模型，`generate_image.model` 支持每次指定模型，新模型 ID 无需发布插件升级。
- 默认 `gpt-image-2`、`1024x1024`、`medium` 质量、PNG，每次一张。
- 支持横图、竖图、质量、透明背景、PNG/JPEG/WebP 和一次 1–4 张。
- 返回图片文件路径，适配 DSH 网页展示与 QQ 发图。
- 沿用 DSH 网络代理；每次调用通过凭据服务读取 Key，支持密钥更新。
- 零运行时 npm 依赖，ES Module，无需编译。

当前实现是**文字生图**。参考图编辑、局部重绘、图片理解不在此插件范围内。图像生成使用 OpenAI API 额度，与聊天模型的额度分别计算。

## 安装到 DSH

需要：已安装并能运行 `dsh web`，Node.js 22.19 或以上，以及可调用图像模型的 OpenAI API Key。

已实测环境：macOS、Node.js 24.14.0、DSH `0.2.1-rc.5`；DSH 仍在快速迭代，其他版本请先验证工具注册是否成功。

### 1. 克隆并安装

```bash
git clone https://github.com/flytangyu/dsh-openai-image.git
cd dsh-openai-image
dsh plugin --profile web add "$PWD"
```

这是从源码安装，**不需要 `npm install`，也不需要构建**。安装命令会将本地包加入 web profile 的 bundles。请保留克隆目录，因为本地安装可能通过链接引用它。

本仓库尚未发布 npm 包，请使用上面的 GitHub 源码安装方式。

### 2. 配置 OpenAI Key

在 DSH 网页的模型设置中保存 `OPENAI_API_KEY`。已经保存过的用户可以跳过这一步。

插件通过 `ctx.credentials.resolve('OPENAI_API_KEY')` 复用 DSH 凭据；也可以使用 DSH 支持的环境变量配置方式。配置文件里只写凭据名称，不写密钥。不要将真实 Key 提交到 GitHub 或发送到聊天中。

### 3. 启动并使用

```bash
dsh web
```

如果 DSH 正在运行，安装后检查是否已热加载；没有看到工具时重启 DSH。

直接在聊天中说：

> 帮我画一只在海边看日落的小鲸鱼，水彩风格，横图。

或者：

> 用 generate_image 生成一张透明背景的可爱机器人贴纸，PNG 格式。

支持工具调用的 DeepSeek、OpenAI 等聊天模型都可以调用 `generate_image`。输出默认保存在 `$DSH_HOME/generated-images`，没有设置 `DSH_HOME` 时为 `~/.dsh/generated-images`。

## 动态模型与单次指定（v1.1.0）

在 DSH 网页或 QQ 中可以直接说：

> 列出我现在可以使用的 OpenAI 绘图模型。

模型会调用 `list_image_models`，使用当前 DSH 保存的 Key 实时查询 OpenAI `/v1/models`，返回 `gpt-image-*` 和 `chatgpt-image-latest`。每次查询重新读取目录和凭据，不缓存旧列表。这个查询不会生成图片。

接着可以说：

> 用 gpt-image-2.6-flare 画一只水彩鲸鱼，横图。

> 用 gpt-image-2.6-sunburst，high 质量，生成一张森林插画。

> 用 chatgpt-image-latest 画一个机器人头像。

调用参数示例：

```json
{
  "prompt": "一只在海边看日落的小鲸鱼，水彩插画",
  "model": "gpt-image-2.6-flare",
  "size": "1536x1024",
  "quality": "high"
}
```

优先级为**本次调用的 `model` > 插件配置的 `model` > 内置默认 `gpt-image-2`**。本次选择不改变后续调用的默认模型。API 返回错误时不自动换模型，用户可以根据错误决定是否重试。

希望由 OpenAI 的 latest 别名选择模型时，可将插件配置中的 `model` 设为 `chatgpt-image-latest`；该别名实际指向由 OpenAI 控制。插件不把未来模型名称写成固定枚举。

新模型可以直接使用已有 PNG/JPEG/WebP 生成流程。模型目录仅提供账号可见的 ID，不包含完整的参数能力，具体生成权限和未来模型参数由 OpenAI 校验。`xhigh`、`max` 在工具参数中可选，已知旧模型（1.x、2）会在请求前拒绝这些档位。动态模型发现不等于自动接入新输出协议，SVG、GIF、参考图编辑仍需单独实现。

## 在 QQ 中使用

本插件负责出图。通过 QQ 使用，还需要另外安装并配置 [`@tencent-connect/dsh-qqbot`](https://github.com/tencent-connect/dsh-qqbot)。

在 `~/.dsh/profiles/web/cordis.patch.yml` 已有的 `im-qqbot` 配置项中，合并以下设置：

```yaml
- id: im-qqbot
  config:
    sendFile:
      extraRoots:
        - /absolute/path/to/.dsh/generated-images
```

把示例路径换成你自己的图片输出目录，使用**绝对路径**。可以用以下命令查看默认目录：

```bash
node -e 'console.log(require("node:path").resolve(process.env.DSH_HOME || require("node:path").join(require("node:os").homedir(), ".dsh"), "generated-images"))'
```

保留现有 appId、appSecret 等配置及原有 extraRoots，仅追加图片目录；不需要关闭 `restrictPaths`。如果修改过 `outputDirectory`，这里也应使用相同目录。

生成后，模型应调用现有 QQ 工具：

```json
{
  "file_path": "/absolute/path/to/.dsh/generated-images/generated-image.png"
}
```

工具名是 `qqbot_send_file`，省略 `target` 会发送给当前 QQ 对话。也可调用 `present` 在轮末交付，二选一以避免重复发送。单独回复本机 Markdown 图片路径不会被 QQ 自动上传。

## 工具参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `model` | 插件默认模型 | 本次调用的准确模型 ID，可先调用 `list_image_models` 查询 |
| `prompt` | 必填 | 1–32000 字符；描述主体、风格、构图和需要出现在图中的文字 |
| `size` | `1024x1024` | `1024x1024`、`1536x1024`、`1024x1536`、`auto` |
| `quality` | `medium` | `low`、`medium`、`high`、`xhigh`、`max`、`auto`；支持情况取决于模型 |
| `n` | `1` | 1–4 张，同一个提示词的多个结果 |
| `output_format` | `png` | `png`、`jpeg`、`webp` |
| `background` | `auto` | `auto`、`opaque`、`transparent`；透明背景不能使用 JPEG |

调用示例：

```json
{
  "prompt": "一只在海边看日落的小鲸鱼，水彩插画，暖色夕阳，无文字",
  "size": "1536x1024",
  "quality": "medium",
  "n": 1,
  "output_format": "png"
}
```

成功结果只包含模型名称和文件元数据：

```json
{
  "model": "gpt-image-2",
  "images": [
    {
      "file_path": "/absolute/path/to/.dsh/generated-images/unique-name.png",
      "mime_type": "image/png",
      "bytes": 123456
    }
  ]
}
```

## 插件配置

默认配置见 [`cordis.patch.yml`](cordis.patch.yml)。需要覆盖时，在 web profile 的 `cordis.patch.yml` 中加入：

```yaml
- id: tool-openai-image
  name: dsh-openai-image
  config:
    model: gpt-image-2
    apiKeyRef: OPENAI_API_KEY
    quality: medium
    size: 1024x1024
    timeoutMs: 600000
    # outputDirectory: /absolute/path/to/generated-images
```

`apiKeyRef` 是凭据引用名称；每次调用重新读取，Key 更新后无需重启插件。`model` 支持配置其他 `gpt-image-*` 模型，实际可用性和参数支持取决于 OpenAI 账号和模型。也支持 `chatgpt-image-latest`。`timeoutMs` 范围为 1000–1800000 毫秒。

输出目录必须是专用目录的绝对真实路径，不能通过符号链接指向其他目录。

## 网络与代理

插件使用原生 `fetch`，继承 DSH 的全局代理策略；不会自行启动代理软件。

需要代理时，在启动 DSH 前设置，或写入 `~/.dsh/.env`：

```dotenv
HTTP_PROXY=http://127.0.0.1:7890
HTTPS_PROXY=http://127.0.0.1:7890
ALL_PROXY=http://127.0.0.1:7890
NO_PROXY=localhost,127.0.0.1,::1,deepseek.com,deepseek.cn,qq.com
```

`7890` 是示例，请换成代理软件的 **HTTP 端口**。以上规则让 OpenAI 走代理，DeepSeek 和 QQ 直连。已有小写代理变量时也要同步检查，因为 DSH 优先读取小写变量。修改后重启 DSH。

## 开发与验证

```bash
npm test                     # 本地模拟测试，不请求外网，不消耗 API 额度
npm run smoke                # 通过 list_image_models 实时查询模型，不生成图片
npm run smoke -- --generate  # 使用默认模型真实生成一张 low 质量测试图，会使用 API 额度
npm run smoke -- --generate --model gpt-image-2.6-flare  # 指定模型验证
```

Smoke 脚本从 PATH 中的 `dsh` 查找运行库。特殊安装可以设置 `DSH_INSTALL_DIR` 为 DSH npm 包目录；该目录下应有 package.json，且能解析 DSH 的运行时依赖。脚本不会自动向 QQ 发送图片。

目前 36 项本地测试覆盖请求参数、模型实时刷新、单次模型选择、凭据更新、错误脱敏、取消、无效图片响应、文件权限、写盘失败清理和原图不被覆盖。已完成真实 API 出图及 DSH/QQ 接入验证；仓库测试不要求提供 API Key。

v1.1.0 验证补充（2026-11-05）：已通过 DSH 工具注册及真实账号模型目录查询，目录包含 2.6 Flare/Sunburst。通过插件显式指定 gpt-image-2.6-flare，实际生成一张 low 质量、1024×1024 的 PNG，耗时约 9 秒，文件约 1.42 MB，并已打开检查图片。单次模型覆盖、请求参数及后续默认模型保持正确也已通过模拟测试。

## 常见问题

| 现象 | 处理方式 |
| --- | --- |
| 模型说绘图服务未配置 | 检查插件是否加入当前 profile 的 bundles、Key 是否保存、是否需要重启 DSH |
| HTTP 401 | 检查 OpenAI Key |
| HTTP 403 | 检查图像模型权限及组织验证状态 |
| HTTP 429 | 检查额度或限流 |
| 连接失败 | 检查网络、代理端口和 DSH 启动时的环境变量 |
| 出图成功但 QQ 无法发送 | 检查 `sendFile.extraRoots` 是否包含实际图片目录 |
| 图像请求超时 | 检查网络及超时设置；确认上次请求状态后再重试 |

插件不自动重试收费的生成请求。超时不代表服务端未执行，重新调用可能再次计费。每次使用唯一文件名及独占创建；批量写盘失败或取消会清理本次已创建文件，保留已有图片。工具结果与日志不输出 Key 或图片 base64。

## 许可证

[MIT](LICENSE)。可使用、修改和分发，请保留许可证声明。

接口参考：[OpenAI Images API](https://developers.openai.com/api/reference/resources/images/methods/generate) · [图像生成指南](https://developers.openai.com/api/docs/guides/image-generation)
