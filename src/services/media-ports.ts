import type { Metadata, MediaTime } from "../domain/media-time.js";
import type { MediaAction, MediaFile } from "../domain/media.js";
export interface MetadataBackend {
  read(
    file: string,
    tags: readonly string[],
    signal: AbortSignal,
  ): Promise<Metadata>;
  write(
    file: string,
    tags: Metadata,
    overwrite: boolean,
    signal: AbortSignal,
  ): Promise<void>;
  shift(
    file: string,
    tags: readonly string[],
    seconds: number,
    overwrite: boolean,
    signal: AbortSignal,
  ): Promise<void>;
}
export interface MediaFiles {
  discover(input: string | string[]): Promise<MediaFile[]>;
  join(...parts: string[]): string;
  directory(file: string): string;
  preflight(
    plans: MediaAction[][],
    skipExisting?: boolean,
  ): Promise<MediaAction[][]>;
  apply(action: MediaAction, signal: AbortSignal): Promise<void>;
  moveFolder(file: string, folder: string, plan: boolean): Promise<boolean>;
  isDirectory(file: string): Promise<boolean>;
  exists(file: string): Promise<boolean>;
  mkdir(file: string): Promise<void>;
  renameDirectory(source: string, target: string): Promise<void>;
}
export interface Location {
  country: string;
  state: string;
  city: string;
  country_code_iso: string;
}
export interface GeocodePort {
  get(
    point: [number, number],
    key: string,
    language: string,
    signal: AbortSignal,
  ): Promise<Location>;
}
export interface TrackMatch {
  latitude: number;
  longitude: number;
  altitude: number;
  seconds: number;
  inside: boolean;
  name: string;
  time: bigint;
}
export interface MediaTracks {
  nearest(
    database: string,
    time: MediaTime,
    multiday: boolean,
    tolerance: number,
    signal: AbortSignal,
  ): Promise<TrackMatch | undefined>;
}
