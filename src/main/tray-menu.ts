/**
 * The tray's context menu, as data.
 *
 * Kept out of index.ts so it can be tested without Electron. It is rebuilt whenever what it can
 * offer changes - today, only whether there is a meeting panel to bring back.
 */

import type { MenuItemConstructorOptions } from "electron";

export interface TrayMenuActions {
  showApp: () => void;
  /** Brings the bridge popup back. See TranscriptPanelLedger.reopenTarget. */
  showMeetingPanel: () => void;
  quit: () => void;
}

export interface TrayMenuState {
  /**
   * Whether the web app still wants the bridge popup shown.
   *
   * Before this item the tray had no way back to the popup at all: close it, and a user in the
   * middle of a translated Meet call had to find the main window and hunt for a control there.
   * Disabled rather than hidden when there is nothing to show, so the entry is where the user
   * learned it was.
   */
  meetingPanelAvailable: boolean;
}

export function trayMenuTemplate(
  appName: string,
  state: TrayMenuState,
  actions: TrayMenuActions,
): MenuItemConstructorOptions[] {
  return [
    {
      label: `Show ${appName}`,
      click: () => actions.showApp(),
    },
    {
      label: "Show meeting panel",
      enabled: state.meetingPanelAvailable,
      click: () => actions.showMeetingPanel(),
    },
    // No Start/Stop Translation here. There were two such items, and neither did anything: their
    // handlers were TODOs from the first scaffold. Translation starts and stops in the meeting - the
    // popup over Meet, or the main window - where the session that carries it lives, and a tray
    // entry that looks like a control and silently isn't one is worse than no entry.
    { type: "separator" },
    {
      label: "Quit",
      click: () => actions.quit(),
    },
  ];
}
