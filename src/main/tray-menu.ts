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
    { type: "separator" },
    {
      label: "Start Translation",
      click: () => {
        // TODO: Start audio capture & translation pipeline
      },
    },
    {
      label: "Stop Translation",
      click: () => {
        // TODO: Stop audio capture
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => actions.quit(),
    },
  ];
}
