import type { RefObject } from "react";
import { FolderOpen, Maximize2, MessageSquarePlus, Search, SquareTerminal } from "lucide-react";

import { PanelIcon } from "../../components/ui/PanelIcon";

export function DeliveryPanel({
  panelRef, onCreateWorkspace, onClose,
}: { panelRef: RefObject<HTMLElement | null>; onCreateWorkspace: () => void; onClose: () => void }) {
  return (
    <aside ref={panelRef} className="delivery-panel" aria-label="交付状态">
      <div className="delivery-layers" aria-hidden="true"><span /><span /><span /></div>
      <div className="work-panel-controls">
        <button type="button" className="sidebar-toggle" aria-label="展开工作面板"><Maximize2 size={16} /></button>
        <button type="button" className="sidebar-toggle" onClick={onClose} aria-label="收起工作面板">
          <PanelIcon side="right" />
        </button>
      </div>
      <div className="work-panel-body">
        <button type="button" className="work-search"><Search size={19} /><span>搜索或输入网址</span></button>
        <button type="button" className="work-action" onClick={onCreateWorkspace}>
          <FolderOpen size={19} /><span>新建工作区</span>
        </button>
        <button type="button" className="work-action"><MessageSquarePlus size={19} /><span>新聊天窗口</span></button>
        <button type="button" className="work-action"><SquareTerminal size={19} /><span>打开终端</span></button>
      </div>
    </aside>
  );
}
