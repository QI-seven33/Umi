import { z } from 'zod';

// Device UI preferences never enter Settings, Agent prompts or conversation events.
export const desktopPreferencesSchema = z.object({
  language: z.enum(['zh-CN', 'en']).default('zh-CN'),
  closeAction: z.enum(['background', 'quit']).default('background'),
  reducedMotion: z.boolean().default(false),
  exportDirectory: z.string().max(32768).nullable().default(null),
}).strict();
// Patch validation must not apply persisted defaults to omitted fields.
export const desktopPreferencePatchSchema = z.object({
  language: z.enum(['zh-CN', 'en']).optional(),
  closeAction: z.enum(['background', 'quit']).optional(),
  reducedMotion: z.boolean().optional(),
}).strict();
export type DesktopPreferences = z.infer<typeof desktopPreferencesSchema>;
export type DesktopPreferencePatch = z.infer<typeof desktopPreferencePatchSchema>;
export const dataLocationSchema = z.enum(['data', 'agent', 'exports', 'application']);
export type DataLocation = z.infer<typeof dataLocationSchema>;
export type DesktopInformation = { version: string; development: boolean; paths: Record<DataLocation, string> };
