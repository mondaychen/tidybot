import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { TidyError } from "./errors.js";
import { inspect, isImage } from "./scan.js";

const run = promisify(execFile);

/** Longest side of a preview, in pixels: enough to read a document page, small enough to send to a model. */
export const PREVIEW_MAX_PX = 1024;

export const defaultPreviewDir = () => path.join(os.tmpdir(), "tidybot-previews");

export interface PreviewResult {
  /** Relative to the base directory, as given. */
  file: string;
  /** The JPEG written, or undefined when `error` is set. */
  preview?: string;
  error?: string;
}

type Converter = (input: string, output: string, pdf: boolean) => Promise<void>;

/** macOS: sips reads HEIC, WebP and most camera formats, and renders a PDF's first page. */
const sips: Converter = async (input, output, pdf) => {
  // -Z also enlarges small images, so only shrink. A PDF page is measured in points (72 dpi), so
  // it is always rendered at the full preview size to keep its text readable.
  let resize = pdf;
  if (!pdf) {
    const { stdout } = await run("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", input]);
    const sizes = [...stdout.matchAll(/pixel(?:Width|Height): (\d+)/g)].map((m) => Number(m[1]));
    resize = sizes.some((n) => n > PREVIEW_MAX_PX);
  }
  await run("/usr/bin/sips", ["-s", "format", "jpeg", "-s", "formatOptions", "80", ...(resize ? ["-Z", String(PREVIEW_MAX_PX)] : []), input, "--out", output]);
};

/** ImageMagick 7 (`magick`) or 6 (`convert`). PDFs need Ghostscript; HEIC needs libheif. */
const imagemagick =
  (bin: string): Converter =>
  async (input, output, pdf) => {
    const density = pdf ? ["-density", "150"] : [];
    await run(bin, [...density, `${input}[0]`, "-auto-orient", "-resize", `${PREVIEW_MAX_PX}x${PREVIEW_MAX_PX}>`, "-quality", "80", `jpeg:${output}`]);
  };

async function converter(): Promise<Converter> {
  if (process.platform === "darwin" && fs.existsSync("/usr/bin/sips")) return sips;
  // On Windows, `convert` is the system's disk conversion tool, not ImageMagick 6.
  for (const bin of process.platform === "win32" ? ["magick"] : ["magick", "convert"]) {
    try {
      const { stdout } = await run(bin, ["-version"]);
      if (stdout.includes("ImageMagick")) return imagemagick(bin);
    } catch {
      /* not installed */
    }
  }
  throw new TidyError("`tidybot preview` needs sips (macOS) or ImageMagick (`magick` or `convert`) on the PATH.", "unsupported");
}

/**
 * Write a small JPEG of each image, or of a PDF's first page, for agents whose image tools can't
 * read HEIC, WebP or PDF. Files flagged sensitive are refused, like everywhere else.
 */
export async function preview(files: string[], opts: { base: string; out: string; excerptChars: number; allowRules?: string[] }): Promise<PreviewResult[]> {
  const convert = await converter();
  fs.mkdirSync(opts.out, { recursive: true });
  const used = new Set<string>();
  const results: PreviewResult[] = [];
  for (const file of files) {
    try {
      const [entry] = await inspect([file], opts.base, { excerptChars: opts.excerptChars, allowRules: opts.allowRules });
      if (!entry) throw new TidyError(`File not found: ${file}`, "not_found");
      if (entry.sensitive) throw new TidyError(`flagged sensitive (${entry.sensitive}); not previewed`, "sensitive");
      const pdf = entry.mime === "application/pdf";
      if (!pdf && !isImage(entry.mime)) throw new TidyError(`not an image or PDF (${entry.mime ?? entry.ext})`, "unsupported");
      // Same-named files from different folders get their own preview.
      let name = `${entry.name}.jpg`;
      for (let n = 2; used.has(name.toLowerCase()); n++) name = `${entry.name} (${n}).jpg`;
      used.add(name.toLowerCase());
      const output = path.join(opts.out, name);
      fs.rmSync(output, { force: true });
      await convert(entry.path, output, pdf);
      if (!fs.existsSync(output) || fs.statSync(output).size === 0) throw new Error("the converter wrote no image");
      results.push({ file, preview: output });
    } catch (err) {
      const message = (err as { stderr?: string }).stderr?.trim() || (err instanceof Error ? err.message : String(err));
      results.push({ file, error: message });
    }
  }
  return results;
}
