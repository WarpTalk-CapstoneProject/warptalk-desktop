import React, { useState } from "react";
import { SidebarNavigation, type DashboardTab } from "./SidebarNavigation";
import { RoomsView } from "./RoomsView";
import { AIChatView } from "./AIChatView";
import { HistoryView } from "./HistoryView";
import { SettingsView } from "./SettingsView";

interface DashboardLayoutProps {
  userEmail?: string;
  onLogout: () => void;
}

export const DashboardLayout: React.FC<DashboardLayoutProps> = ({
  userEmail,
  onLogout,
}) => {
  const [activeTab, setActiveTab] = useState<DashboardTab>("rooms");

  const renderTabContent = () => {
    switch (activeTab) {
      case "rooms":
        return <RoomsView />;
      case "ai-chat":
        return <AIChatView />;
      case "history":
        return <HistoryView />;
      case "settings":
        return <SettingsView />;
      default:
        return <RoomsView />;
    }
  };

  return (
    <div className="dashboard-shell">
      <SidebarNavigation
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        onLogout={onLogout}
        userEmail={userEmail}
      />
      <main className="dashboard-main-content">
        {renderTabContent()}
      </main>
    </div>
  );
};
