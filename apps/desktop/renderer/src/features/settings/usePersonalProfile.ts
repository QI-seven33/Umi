import { useState } from "react";

const AVATAR_KEY = "umi.profile.avatar";
const USERNAME_KEY = "umi.profile.username";
export const MAX_USERNAME_LENGTH = 32;
const DEFAULT_USERNAME = "本地用户";

function normalizedUsername(value: string): string {
  const name = value.trim();
  if (!name) throw new Error("请输入用户名。");
  if (name.length > MAX_USERNAME_LENGTH) throw new Error("用户名最多 32 个字符。");
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error("用户名不能包含换行或控制字符。");
  return name;
}

function savedUsername(): string {
  try { return normalizedUsername(localStorage.getItem(USERNAME_KEY) ?? DEFAULT_USERNAME); }
  catch { return DEFAULT_USERNAME; }
}
const MAX_AVATAR_LENGTH = 400_000;
function savedAvatar(): string | null {
  try {
    const value = localStorage.getItem(AVATAR_KEY);
    return value && value.length <= MAX_AVATAR_LENGTH
      && /^data:image\/(png|jpeg|webp);base64,/.test(value) ? value : null;
  } catch { return null; }
}

/** 本地显示资料，仅保存头像和用户名。 */
export function usePersonalProfile() {
  const [avatar, setAvatarState] = useState(savedAvatar);
  const [username, setUsernameState] = useState(savedUsername);
  const setUsername = (value: string) => {
    const name = normalizedUsername(value);
    try { localStorage.setItem(USERNAME_KEY, name); }
    catch { throw new Error("用户名无法保存，浏览器存储不可用或空间不足。"); }
    setUsernameState(name);
  };
  const setAvatar = (value: string | null) => {
    try {
      if (value) localStorage.setItem(AVATAR_KEY, value);
      else localStorage.removeItem(AVATAR_KEY);
    } catch { throw new Error("头像无法保存，浏览器存储不可用或空间不足。"); }
    setAvatarState(value);
  };
  return { avatar, setAvatar, username, setUsername };
}

/** 读取用户主动选择的图片，裁成小头像后保存，避免原图撑满浏览器存储。 */
export async function prepareAvatar(file: File): Promise<string> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
    throw new Error("请选择 PNG、JPEG 或 WebP 图片。");
  if (file.size > 5 * 1024 * 1024) throw new Error("头像图片不能超过 5 MB。");
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error("图片无法读取，请换一张图片。"); });
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 40_000_000)
      throw new Error("图片尺寸过大，请先缩小后再上传。");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器暂不支持头像处理。");
    const size = Math.min(bitmap.width, bitmap.height);
    context.drawImage(bitmap, (bitmap.width - size) / 2, (bitmap.height - size) / 2,
      size, size, 0, 0, 256, 256);
    const value = canvas.toDataURL("image/webp", .86);
    if (value.length > MAX_AVATAR_LENGTH) throw new Error("头像处理后仍过大，请换一张图片。");
    return value;
  } finally { bitmap.close(); }
}
