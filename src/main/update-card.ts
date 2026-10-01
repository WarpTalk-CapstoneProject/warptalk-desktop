/**
 * The update card in the main window's bottom-right corner.
 *
 * A WebContentsView of its own, laid over the web app, not something the web app draws: it has to
 * work with whichever web build the window loaded, and when that build failed to load at all. The
 * page is update-card-page.ts; what it says is update-policy.ts updateCardModel.
 */

import { WebContentsView, type BrowserWindow } from "electron";

import { parseCardAction, type UpdateCardAction, type UpdateCardModel } from "./update-policy";
import { UPDATE_CARD_HTML, UPDATE_CARD_MARGIN, UPDATE_CARD_WIDTH } from "./update-card-page";

/** Gap between the card and the window's edges. */
const INSET = 16 - UPDATE_CARD_MARGIN;
const VIEW_WIDTH = UPDATE_CARD_WIDTH + UPDATE_CARD_MARGIN * 2;

export class UpdateCard {
  private view: WebContentsView | null = null;
  private host: BrowserWindow | null = null;
  private loaded: Promise<void> | null = null;
  private height = 0;
  private model: UpdateCardModel | null = null;
  private readonly relayout = (): void => this.layout();

  constructor(private readonly onAction: (action: UpdateCardAction) => void) {}

  /** Shows `model`, or hides the card for null. Safe to call before the window exists. */
  show(win: BrowserWindow | null, model: UpdateCardModel | null): void {
    this.model = model;
    if (!win || win.isDestroyed()) return;
    if (model === null) {
      this.view?.setVisible(false);
      return;
    }
    const view = this.attach(win);
    void this.paint(view, model);
  }

  /** Re-applies the last model, e.g. after the main window was recreated. */
  refresh(win: BrowserWindow | null): void {
    this.show(win, this.model);
  }

  private attach(win: BrowserWindow): WebContentsView {
    if (this.view && this.host === win && !this.view.webContents.isDestroyed()) return this.view;
    this.detach();

    const view = new WebContentsView({
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true },
    });
    view.setBackgroundColor("#00000000");
    view.setVisible(false);

    // Every navigation the page starts is a button press; none of them may actually leave the page.
    view.webContents.on("will-navigate", (event, url) => {
      event.preventDefault();
      const action = parseCardAction(url);
      if (action) this.onAction(action);
    });
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

    // Added last, so it sits above the web app's own contents.
    win.contentView.addChildView(view);
    win.on("resize", this.relayout);
    win.once("closed", () => {
      if (this.host === win) {
        this.view = null;
        this.host = null;
        this.loaded = null;
      }
    });

    this.view = view;
    this.host = win;
    this.loaded = view.webContents
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(UPDATE_CARD_HTML)}`)
      .catch((error) => console.error("[updater] update card failed to load:", error));
    return view;
  }

  private detach(): void {
    if (this.host && !this.host.isDestroyed()) {
      this.host.off("resize", this.relayout);
      if (this.view) this.host.contentView.removeChildView(this.view);
    }
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.close();
    this.view = null;
    this.host = null;
    this.loaded = null;
  }

  private async paint(view: WebContentsView, model: UpdateCardModel): Promise<void> {
    await this.loaded;
    if (view !== this.view || view.webContents.isDestroyed() || this.model !== model) return;
    try {
      const height = await view.webContents.executeJavaScript(`window.render(${JSON.stringify(model)})`);
      if (view !== this.view || this.model !== model) return;
      this.height = typeof height === "number" && height > 0 ? height : 140;
      this.layout();
      view.setVisible(true);
    } catch (error) {
      console.error("[updater] update card failed to render:", error);
    }
  }

  private layout(): void {
    const { view, host } = this;
    if (!view || !host || host.isDestroyed()) return;
    const [width, height] = host.getContentSize();
    view.setBounds({
      x: Math.max(0, width - VIEW_WIDTH - INSET),
      y: Math.max(0, height - this.height - INSET),
      width: VIEW_WIDTH,
      height: this.height,
    });
  }
}
