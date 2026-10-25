import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { desktopPreferencesSchema, type DesktopPreferences } from '../../packages/protocol/src/desktop-preferences.js';

export class DesktopPreferenceStore {
  private value: DesktopPreferences;
  constructor(private readonly root: string) {
    const path = join(root, 'desktop-preferences.json');
    // Absent/invalid preference files fall back without rewriting the original.
    let raw: unknown = {};
    try { if (existsSync(path)) raw = JSON.parse(readFileSync(path, 'utf8')); } catch {}
    const parsed = desktopPreferencesSchema.safeParse(raw);
    this.value = parsed.success ? parsed.data : desktopPreferencesSchema.parse({});
  }
  read(): DesktopPreferences { return { ...this.value }; }
  save(patch: { [K in keyof DesktopPreferences]?: DesktopPreferences[K] | undefined }): DesktopPreferences {
    const next = desktopPreferencesSchema.parse({ ...this.value, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) });
    mkdirSync(this.root, { recursive: true });
    const path = join(this.root, 'desktop-preferences.json');
    writeFileSync(path + '.tmp', JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(path + '.tmp', path);
    this.value = next;
    return this.read();
  }
}
