import type { JSX } from "solid-js";

type Kind = "pdf" | "image" | "video" | "audio" | "archive" | "sheet" | "doc" | "code" | "other";

const KINDS: Record<Exclude<Kind, "other">, string[]> = {
  pdf: ["pdf"],
  image: ["jpg", "jpeg", "png", "gif", "heic", "webp", "svg", "tif", "tiff", "bmp", "raw", "psd"],
  video: ["mp4", "mov", "mkv", "avi", "webm", "m4v"],
  audio: ["mp3", "wav", "m4a", "flac", "aac", "ogg"],
  archive: ["zip", "tar", "gz", "tgz", "rar", "7z", "dmg", "pkg", "iso"],
  sheet: ["xls", "xlsx", "csv", "tsv", "numbers"],
  doc: ["doc", "docx", "pages", "txt", "md", "rtf", "odt", "ppt", "pptx", "key", "epub"],
  code: ["html", "htm", "js", "ts", "json", "py", "sh", "css", "xml", "yaml", "yml"],
};
const BY_EXTENSION = new Map(Object.entries(KINDS).flatMap(([kind, list]) => list.map((ext) => [ext, kind as Kind])));

const GLYPHS: Record<Kind, () => JSX.Element> = {
  pdf: () => (
    <text x="10" y="17.6" font-size="5.6" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none">
      PDF
    </text>
  ),
  image: () => (
    <>
      <circle cx="7.6" cy="11.6" r="1.1" fill="currentColor" stroke="none" />
      <path d="m6 18 2.8-3.6 1.9 2.2 1.5-1.9L14 18z" fill="currentColor" />
    </>
  ),
  video: () => <path d="M8 11.4v6.2l5.2-3.1z" fill="currentColor" />,
  audio: () => (
    <>
      <path d="M8.9 17.4v-5.9l4.2-1v5.6" />
      <circle cx="7.9" cy="17.4" r="1.1" fill="currentColor" />
      <circle cx="12.1" cy="16.1" r="1.1" fill="currentColor" />
    </>
  ),
  archive: () => <path d="M10 9.5v9" stroke-dasharray="1.6 1.9" stroke-width="1.8" />,
  sheet: () => <path d="M6.5 11h7v7h-7zM6.5 14.5h7M10 11v7" />,
  doc: () => <path d="M6.5 11.5h7M6.5 14.5h7M6.5 17.5h4.5" />,
  code: () => <path d="M8.5 12 6 14.5 8.5 17M11.5 12l2.5 2.5-2.5 2.5" />,
  other: () => <></>,
};

/** A small page icon for a file, with a color and a sign for its kind (from the extension). */
export function FileIcon(props: { name: string }) {
  const kind = (): Kind => BY_EXTENSION.get(/\.([^.]+)$/.exec(props.name)?.[1]?.toLowerCase() ?? "") ?? "other";
  return (
    <svg class={`file-icon ${kind()}`} viewBox="0 0 20 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path class="page" d="M5.5 1.5H12l5 5V20a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 3 20V4a2.5 2.5 0 0 1 2.5-2.5z" />
      <path class="fold" d="M12 1.5V5a1.5 1.5 0 0 0 1.5 1.5H17" />
      {GLYPHS[kind()]()}
    </svg>
  );
}
