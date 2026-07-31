import React from "react";
import {
  Video,
  Sparkles,
  History,
  Settings,
  LogOut,
  ChevronDown,
  User,
  Radio,
} from "lucide-react";

export type DashboardTab = "rooms" | "ai-chat" | "history" | "settings";

interface SidebarNavigationProps {
  activeTab: DashboardTab;
  onSelectTab: (tab: DashboardTab) => void;
  onLogout: () => void;
  userEmail?: string;
}

export const SidebarNavigation: React.FC<SidebarNavigationProps> = ({
  activeTab,
  onSelectTab,
  onLogout,
  userEmail = "user@warptalk.vn",
}) => {
  const navItems = [
    {
      id: "rooms" as DashboardTab,
      label: "Phòng họp & Dịch",
      icon: Video,
      badge: "Live",
    },
    {
      id: "ai-chat" as DashboardTab,
      label: "Trợ lý AI & Tóm tắt",
      icon: Sparkles,
    },
    {
      id: "history" as DashboardTab,
      label: "Lịch sử cuộc họp",
      icon: History,
    },
    {
      id: "settings" as DashboardTab,
      label: "Cài đặt & Thiết bị",
      icon: Settings,
    },
  ];

  return (
    <aside className="dashboard-sidebar">
      {/* Workspace Header */}
      <div className="sidebar-workspace">
        <div className="workspace-avatar">W</div>
        <div className="workspace-info">
          <span className="workspace-name">Warptalk-V1 Workspace</span>
          <span className="workspace-status">
            <span className="status-dot online" /> Trực tuyến
          </span>
        </div>
        <ChevronDown size={16} className="workspace-arrow" />
      </div>

      {/* Main Nav items */}
      <nav className="sidebar-menu">
        <div className="menu-group-label">Menu Chính</div>
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              className={`nav-item ${isActive ? "active" : ""}`}
              onClick={() => onSelectTab(item.id)}
            >
              <Icon size={18} className="nav-icon" />
              <span className="nav-label">{item.label}</span>
              {item.badge && <span className="nav-badge">{item.badge}</span>}
            </button>
          );
        })}
      </nav>

      {/* Real-time status banner */}
      <div className="sidebar-status-card">
        <div className="status-card-header">
          <Radio size={16} className="pulse-icon" />
          <span>Real-time Audio Processor</span>
        </div>
        <p className="status-card-desc">Sẵn sàng capture & dịch đa ngôn ngữ cho Desktop.</p>
      </div>

      {/* User profile & Logout */}
      <div className="sidebar-footer">
        <div className="user-profile">
          <div className="user-avatar">
            <User size={16} />
          </div>
          <div className="user-details">
            <span className="user-email" title={userEmail}>
              {userEmail}
            </span>
            <span className="user-role">Desktop Pro</span>
          </div>
        </div>
        <button
          type="button"
          className="logout-btn"
          onClick={onLogout}
          title="Đăng xuất"
        >
          <LogOut size={16} />
        </button>
      </div>
    </aside>
  );
};
