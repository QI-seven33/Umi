import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronRight, Monitor, Moon, Palette, Settings, Sun } from "lucide-react";
import { UserAvatar } from "../../components/ui/UserAvatar.js";
import type { ThemeMode } from "../../types/index.js";

export function ProfileMenu({ avatar, username, themeMode, onSelectTheme, onOpenSettings }: {
  avatar: string | null; username: string; themeMode: ThemeMode;
  onSelectTheme: (theme: ThemeMode) => void; onOpenSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const appearanceId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false); setAppearanceOpen(false);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false); setAppearanceOpen(false); triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", dismiss);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", dismiss); document.removeEventListener("keydown", escape); };
  }, [open]);

  const themes = [{ id: "light", label: "浅色", icon: Sun }, { id: "dark", label: "深色", icon: Moon },
    { id: "system", label: "跟随系统", icon: Monitor }] as const;
  return <div ref={rootRef} className="profile-menu-wrap">
    <button ref={triggerRef} type="button" className="profile-trigger" aria-label="个人菜单"
      aria-haspopup="menu" aria-expanded={open} onClick={() => { setAppearanceOpen(false); setOpen((value) => !value); }}>
      <UserAvatar avatar={avatar} /><span title={username}>{username}</span>
    </button>
    {open && <div className="profile-menu" role="menu" aria-label="个人菜单">
      <button type="button" role="menuitem" className="profile-appearance-toggle"
        aria-expanded={appearanceOpen} aria-controls={appearanceId}
        onClick={() => setAppearanceOpen((value) => !value)}>
        <Palette size={16} /><span>外观</span>
        <small>{themes.find((theme) => theme.id === themeMode)?.label}</small>
        <ChevronRight size={14} className={appearanceOpen ? "expanded" : ""} />
      </button>
      {appearanceOpen && <div id={appearanceId} className="profile-appearance-options" role="group" aria-label="外观">
        {themes.map(({ id, label, icon: Icon }) => <button key={id} type="button"
          role="menuitemradio" aria-checked={themeMode === id} onClick={() => onSelectTheme(id)}>
          <Icon size={16} /><span>{label}</span>
          {themeMode === id && <Check size={14} />}
        </button>)}
      </div>}
      <div className="profile-menu-divider" />
      <button type="button" role="menuitem" onClick={() => { setOpen(false); setAppearanceOpen(false); onOpenSettings(); }}>
        <Settings size={16} /><span>设置</span><ChevronRight size={14} />
      </button>
    </div>}
  </div>;
}
