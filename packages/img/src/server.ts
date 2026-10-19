import {
  DtstError,
  type ImageInput,
  Server,
  type ToolContext,
  VERSION,
  extensionFor,
  fileLink,
  image,
  imageSize,
  loadImages,
  mimeForExtension,
  planOutput,
  slug,
  text,
  writeOutput,
} from "@dtst/internal";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { type ImageRequest, createImages, listImageModels } from "./providers";

export const NAME = "dtst-img";

const INSTRUCTIONS = `Generate and edit images; every result is saved to a file.
- generate_image: text → image(s). edit_image: image(s) + instruction → new image(s).
- Pass \`output\` when the user names a file or folder; otherwise files land in the workspace root.
- To iterate, pass a previous result's path to edit_image \`images\`.
- Unsure about a model id or its sizes/aspect ratios? Call list_image_models.`;

const MAX_INLINE_BYTES = 2 * 1024 * 1024;
const MAX_INLINE_IMAGES = 4;

const options = {
  n: z.number().int().min(1).max(10).optional().describe("Number of images (default 1)."),
  size: z.string().optional().describe('Pixel size "1024x1536", a tier "1K" | "2K" | "4K", or "auto".'),
  aspect_ratio: z.string().optional().describe('e.g. "1:1", "16:9", "9:16".'),
  quality: z.string().optional().describe('"low" | "medium" | "high" | "auto" (provider-specific).'),
  format: z
    .enum(["png", "jpeg", "webp"])
    .optional()
    .describe("File encoding. Default: from `output`'s extension, else the provider's default."),
  background: z.enum(["auto", "transparent", "opaque"]).optional().describe('"transparent" needs png or webp.'),
  seed: z.number().int().optional().describe("Seed for reproducible results, where supported."),
  output: z
    .string()
    .optional()
    .describe(
      'File ("art/hero.png") or folder ("art/") to save to, relative to the workspace. With n > 1 files are numbered: hero-1.png, hero-2.png. Default: workspace root, named after the prompt.',
    ),
  overwrite: z.boolean().optional().describe("Replace existing files (default false: pick a free name)."),
  inline: z.boolean().optional().describe("Include the images in the reply so you can see them (default true)."),
};

const outputSchema = {
  model: z.string(),
  images: z.array(
    z.object({
      path: z.string(),
      mime_type: z.string(),
      bytes: z.number(),
      width: z.number().optional(),
      height: z.number().optional(),
    }),
  ),
  cost_usd: z.number().optional(),
  notes: z.array(z.string()).optional(),
};

const writes = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

export function createServer(env: NodeJS.ProcessEnv = process.env): Server {
  const defaultModel = env["OPENAI_IMAGE_MODEL"]?.trim() || env["OPENAI_MODEL"]?.trim();
  const server = new Server(
    { name: NAME, version: VERSION },
    `${INSTRUCTIONS}\n- Configured model: ${defaultModel ?? "none (pass `model`)"}.`,
  );
  const model = z
    .string()
    .min(1)
    .optional()
    .describe(
      defaultModel
        ? `Omit to use the configured model (${defaultModel}). Set only if the user asks for a different model.`
        : "Image model id (no default is configured; see list_image_models).",
    );

  server.tool(
    "generate_image",
    {
      title: "Generate image",
      description: "Create images from a text prompt and save them to disk.",
      input: {
        prompt: z.string().min(1).max(30_000).describe("What to draw: subject, composition, style, lighting."),
        model,
        ...options,
      },
      output: outputSchema,
      annotations: writes,
    },
    (args, context) => render(args, context),
  );

  server.tool(
    "edit_image",
    {
      title: "Edit image",
      description: "Change existing image(s) with a text instruction and save the result to disk.",
      input: {
        prompt: z.string().min(1).max(30_000).describe('The change, e.g. "replace the sky with a sunset".'),
        images: z
          .array(z.string())
          .min(1)
          .max(16)
          .describe("Input images: file paths, globs, http(s) URLs, data URLs or base64."),
        mask: z
          .string()
          .optional()
          .describe("PNG whose transparent pixels mark the area to change (OpenAI images API only)."),
        model,
        ...options,
      },
      output: outputSchema,
      annotations: writes,
    },
    async (args, context) => {
      const load = { root: context.root, signal: context.signal };
      const images = await loadImages(args.images, load);
      const mask = args.mask ? (await loadImages([args.mask], load))[0] : undefined;
      return render(args, context, images, mask);
    },
  );

  server.tool(
    "list_image_models",
    {
      title: "List image models",
      description: "List the image models this endpoint offers, with the parameters each accepts when known.",
      input: {
        query: z.string().optional().describe("Case-insensitive filter on id and name."),
        limit: z.number().int().min(1).max(500).optional().describe("Maximum results (default 50)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, { config, signal }) => {
      const query = args.query?.toLowerCase();
      const all = await listImageModels(config, signal);
      const models = all
        .filter((model) => !query || `${model.id} ${model.name ?? ""}`.toLowerCase().includes(query))
        .slice(0, args.limit ?? 50);
      const lines = models.map(
        (model) =>
          `- ${model.id}${model.name ? ` (${model.name})` : ""} [${model.route}]${model.params ? `\n  ${model.params}` : ""}`,
      );
      const current = config.imageModel ?? config.textModel ?? "none — set OPENAI_IMAGE_MODEL";
      return {
        content: [
          text([`Default model: ${current}`, `${models.length} of ${all.length} models:`, ...lines].join("\n")),
        ],
      };
    },
  );

  return server;
}

type RenderArgs = Omit<ImageRequest, "model" | "n" | "aspectRatio" | "images" | "mask"> & {
  model?: string | undefined;
  n?: number | undefined;
  aspect_ratio?: string | undefined;
  output?: string | undefined;
  overwrite?: boolean | undefined;
  inline?: boolean | undefined;
};

async function render(
  args: RenderArgs,
  context: ToolContext,
  images?: ImageInput[],
  mask?: ImageInput,
): Promise<{ content: ContentBlock[]; structuredContent: Record<string, unknown> }> {
  const model = args.model ?? context.config.imageModel ?? context.config.textModel;
  if (!model) {
    throw new DtstError(
      "CONFIG",
      "No image model configured.",
      "Set OPENAI_IMAGE_MODEL (e.g. openai/gpt-image-1) or pass `model`.",
    );
  }
  const plan = await planOutput(args.output, context.root, slug(args.prompt, "image"));
  const requested = plan.extension ? mimeForExtension(plan.extension) : undefined;
  const format = args.format ?? FORMATS[requested ?? ""];

  const result = await createImages(
    {
      model,
      prompt: args.prompt,
      n: args.n ?? 1,
      size: args.size,
      aspectRatio: args.aspect_ratio,
      quality: args.quality,
      format,
      background: args.background,
      seed: args.seed,
      ...(images ? { images } : {}),
      mask,
    },
    context,
  );

  const notes = [...result.notes];
  const content: ContentBlock[] = [];
  const saved: { path: string; mime_type: string; bytes: number; width?: number; height?: number }[] = [];
  const multiple = result.images.length > 1;
  let inlined = 0;

  for (const [index, generated] of result.images.entries()) {
    const keepExtension = plan.extension && requested === generated.mimeType;
    if (plan.extension && !keepExtension && index === 0) {
      notes.push(`The provider returned ${generated.mimeType}, so the file extension was adjusted.`);
    }
    const extension = keepExtension ? plan.extension! : extensionFor(generated.mimeType);
    const file = await writeOutput(plan, extension, generated.data, {
      overwrite: args.overwrite,
      index: multiple ? index + 1 : undefined,
    });
    const bytes = generated.data.byteLength;
    saved.push({ path: file, mime_type: generated.mimeType, bytes, ...imageSize(generated.data, generated.mimeType) });

    if (args.inline !== false && inlined < MAX_INLINE_IMAGES && bytes <= MAX_INLINE_BYTES) {
      content.push(image(generated.data, generated.mimeType));
      inlined += 1;
    }
    content.push(fileLink(file, generated.mimeType, bytes));
  }
  if (args.inline !== false && inlined < saved.length)
    notes.push("Some images were too large to preview inline; open the files.");

  const lines = [
    `Saved ${saved.length} image${saved.length === 1 ? "" : "s"} (${model}):`,
    ...saved.map(
      (entry) =>
        `- ${entry.path} · ${entry.width ? `${entry.width}×${entry.height} · ` : ""}${formatBytes(entry.bytes)}`,
    ),
    ...(result.costUsd === undefined ? [] : [`Cost: $${result.costUsd.toFixed(4)}`]),
    ...notes.map((note) => `Note: ${note}`),
  ];
  content.push(text(lines.join("\n")));

  return {
    content,
    structuredContent: {
      model,
      images: saved,
      ...(result.costUsd === undefined ? {} : { cost_usd: result.costUsd }),
      ...(notes.length > 0 ? { notes } : {}),
    },
  };
}

const FORMATS: Record<string, "png" | "jpeg" | "webp"> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/webp": "webp",
};

function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
