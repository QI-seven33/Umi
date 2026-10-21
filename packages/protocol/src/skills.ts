import {z} from 'zod';
export const skillName=z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const skillVersion=z.string().regex(/^[a-f0-9]{64}$/);
export const skillListSchema=z.object({offset:z.number().int().min(0).max(256).default(0),limit:z.number().int().min(1).max(20).default(12)}).strict();
export const skillReadSchema=z.object({name:skillName,version:skillVersion,path:z.string().min(1).max(240).default('SKILL.md'),startByte:z.number().int().min(0).max(262144).default(0),byteLength:z.number().int().min(64).max(4096).default(4096),expectedHash:skillVersion.optional()}).strict();
export type SkillRead=z.infer<typeof skillReadSchema>;
export type SkillSummary={name:string;description:string;version:string;source:'builtin'|'user';enabled:boolean;compatibility?:string;origin?:{repository:string;commit:string;path:string;packageHash:string;importId:string;mainModified:boolean}};
export type SkillLibrary={directory:string;skills:SkillSummary[];issues:{name:string;message:string}[];limitReached:boolean};
export type SkillPage={name:string;version:string;path:string;sourceHash:string;startByte:number;endByte:number;nextStartByte:number|null;totalBytes:number;text:string;notice:string;origin?:{repository:string;commit:string;path:string;packageHash:string;originalHash:string|null;modifiedFromImport:boolean}};