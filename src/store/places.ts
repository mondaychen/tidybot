import path from "node:path";
import { z } from "zod";
import { TidyError } from "../errors.js";
import { pinPath, resolvePath, settingsDir } from "../paths.js";
import { readYaml, writeYaml } from "./io.js";

export const PlaceSchema = z.object({
  name: z.string().trim().min(1, "name is required"),
  path: z.string().trim().min(1, "path is required").transform(pinPath),
  rule: z.string().trim().default(""),
});
export type Place = z.infer<typeof PlaceSchema>;

const PlacesFileSchema = z.object({ places: z.array(PlaceSchema).default([]) });

const HEADER = `# tidybot places. Edit freely; names and paths must be unique.
# rule: natural-language description of what belongs here (read by the AI agent).`;

/** In a project, the project's places.yaml fully replaces the global set. */
export const placesFile = () => path.join(settingsDir(), "places.yaml");

export function loadPlaces(file = placesFile()): Place[] {
  const parsed = PlacesFileSchema.safeParse(readYaml(file) ?? {});
  if (!parsed.success) throw new TidyError(`Invalid ${file}: ${parsed.error.message}`);
  return parsed.data.places;
}

export function validatePlaces(places: Place[]): void {
  const names = new Map<string, string>();
  const paths = new Map<string, string>();
  for (const f of places) {
    const nameKey = f.name.toLowerCase();
    if (names.has(nameKey)) throw new TidyError(`Duplicate place name "${f.name}"`, "duplicate");
    names.set(nameKey, f.name);
    const abs = resolvePath(f.path);
    const other = paths.get(abs);
    if (other) throw new TidyError(`Places "${other}" and "${f.name}" share the path ${f.path}`, "duplicate");
    paths.set(abs, f.name);
  }
}

export function savePlaces(places: Place[], file = placesFile()): void {
  validatePlaces(places);
  writeYaml(file, { places }, HEADER);
}

/** Look up by name (case-insensitive). */
export function findPlace(places: Place[], name: string): Place | undefined {
  const key = name.trim().toLowerCase();
  return places.find((f) => f.name.toLowerCase() === key);
}

function requirePlace(places: Place[], name: string): Place {
  const found = findPlace(places, name);
  if (!found) throw new TidyError(`No place named "${name}"`, "not_found");
  return found;
}

export function addPlace(input: unknown): Place {
  const place = PlaceSchema.parse(input);
  savePlaces([...loadPlaces(), place]);
  return place;
}

export function updatePlace(name: string, patch: Partial<Place>): Place {
  const places = loadPlaces();
  const current = requirePlace(places, name);
  const next = PlaceSchema.parse({ ...current, ...patch });
  savePlaces(places.map((f) => (f === current ? next : f)));
  return next;
}

export function removePlace(name: string): Place {
  const places = loadPlaces();
  const current = requirePlace(places, name);
  savePlaces(places.filter((f) => f !== current));
  return current;
}

export interface ImportResult {
  added: Place[];
  updated: Place[];
  places: Place[];
}

/**
 * Merge a batch of places (e.g. proposed by an agent during onboarding).
 * Existing places with the same name are updated; `replace` discards everything else.
 */
export function importPlaces(input: unknown, opts: { replace?: boolean; dryRun?: boolean } = {}): ImportResult {
  const list = Array.isArray(input) ? input : (input as { places?: unknown })?.places;
  const incoming = z.array(PlaceSchema).parse(list);
  const base = opts.replace ? [] : loadPlaces();
  const existingNames = new Set(loadPlaces().map((f) => f.name.toLowerCase()));
  const result: ImportResult = { added: [], updated: [], places: [...base] };
  for (const place of incoming) {
    const idx = result.places.findIndex((f) => f.name.toLowerCase() === place.name.toLowerCase());
    if (idx >= 0) result.places[idx] = place;
    else result.places.push(place);
    (existingNames.has(place.name.toLowerCase()) ? result.updated : result.added).push(place);
  }
  validatePlaces(result.places);
  if (!opts.dryRun) savePlaces(result.places);
  return result;
}
