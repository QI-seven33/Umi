import { UserRound } from "lucide-react";

export function UserAvatar({ avatar, className = "" }: { avatar: string | null; className?: string }) {
  return <span className={`user-avatar ${className}`}>
    {avatar ? <img src={avatar} alt="个人头像" /> : <UserRound size={20} strokeWidth={1.6} aria-hidden="true" />}
  </span>;
}
