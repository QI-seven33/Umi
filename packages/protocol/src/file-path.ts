import { z } from 'zod';

// 对模型开放的是逻辑位置；Windows 设备名、流路径和穿越在协议入口即拒绝。
export const filePath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (p) =>
      !p.startsWith('/') &&
      !p.includes('\\') &&
      !p.includes(':') &&
      !p
        .split('/')
        .some((x) =>
          ['.git', 'node_modules', '.venv', '__pycache__'].includes(x.toLowerCase()),
        ) &&
      p
        .split('/')
        .every(
          (x) =>
            x &&
            x !== '.' &&
            x !== '..' &&
            !/[<>"|?*\x00-\x1f]/.test(x) &&
            !/[. ]$/.test(x) &&
            !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(x),
        ),
    '必须使用普通相对路径，禁止穿越、设备名及特殊流',
  );
