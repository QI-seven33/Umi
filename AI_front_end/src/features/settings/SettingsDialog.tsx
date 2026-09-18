import { useState } from "react";
import {
  FileText, FlaskConical, ListChecks, Maximize2, Moon, Settings, Sun, User, X,
} from "lucide-react";

import type { Language, ThemeMode } from "../../types";
import { Dropdown } from "../../components/ui/Dropdown";

export function SettingsDialog({
  open, onClose, themeMode, onSelectTheme, language, onSelectLanguage,
}: {
  open: boolean;
  onClose: () => void;
  themeMode: ThemeMode;
  onSelectTheme: (m: ThemeMode) => void;
  language: Language;
  onSelectLanguage: (l: Language) => void;
}) {
  const [activeTab, setActiveTab] = useState("general");
  if (!open) return null;

  const tabs = [
    { id: "general", label: "通用设置", icon: <Settings size={16} /> },
    { id: "account", label: "账号管理", icon: <User size={16} /> },
    { id: "data", label: "数据管理", icon: <ListChecks size={16} /> },
    { id: "terms", label: "服务协议", icon: <FileText size={16} /> },
    { id: "lab", label: "Umi实验室", icon: <FlaskConical size={16} /> },
  ];

  const languageOptions = [
    { value: "system", label: "跟随系统" },
    { value: "zh", label: "简体中文" },
    { value: "en", label: "English" },
  ];

  return (
    <div className="settings-overlay" onMouseDown={onClose}>
      <div className="settings-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>系统设置</h2>
          <button type="button" className="settings-close" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="settings-body">
          <aside className="settings-nav">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`settings-nav-item ${activeTab === tab.id ? "active" : ""}`}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.icon}
                <span>{tab.label}</span>
              </button>
            ))}
          </aside>

          <main className="settings-content">
            {activeTab === "general" && (
              <>
                <div className="settings-section">
                  <label className="settings-label">主题</label>
                  <div className="settings-theme-cards">
                    {[
                      { id: "light", label: "浅色", icon: <Sun size={18} /> },
                      { id: "dark", label: "深色", icon: <Moon size={18} /> },
                      { id: "system", label: "跟随系统", icon: <Maximize2 size={18} /> },
                    ].map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        className={`settings-theme-card ${themeMode === t.id ? "active" : ""}`}
                        onClick={() => onSelectTheme(t.id as ThemeMode)}
                      >
                        <div className="theme-card-icon">{t.icon}</div>
                        <span>{t.label}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="settings-section">
                  <label className="settings-label">语言</label>
                  <div className="settings-row">
                    <Dropdown
                      value={language}
                      options={languageOptions}
                      onChange={(v) => onSelectLanguage(v as Language)}
                    />
                  </div>
                </div>
              </>
            )}

            {activeTab === "lab" && (
              <div className="settings-lab">
                <div className="settings-lab-icon">
                  <FlaskConical size={32} />
                </div>
                <h3 className="settings-lab-title">Umi 实验室</h3>
                <p className="settings-lab-desc">
                  这里是未来专属皮肤和实验功能的孵化地。<br />
                  敬请期待。
                </p>
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
