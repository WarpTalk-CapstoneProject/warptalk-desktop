/**
 * The page inside the update card: static HTML, filled by `render(model)` from the main process.
 *
 * Shipped as a string rather than a renderer entry so the card has no build step, no preload and no
 * dependency on the web app, which may be the thing that failed to load. Text goes in through
 * `textContent` only, never as markup. Buttons navigate to `warptalk-update:<action>`, which the
 * main process cancels and handles (update-policy.ts parseCardAction).
 *
 * `render` returns the card's height so the view can be sized to it.
 */

/** The view is wider than the card by this margin on every side, so the shadow is not clipped. */
export const UPDATE_CARD_MARGIN = 12;
export const UPDATE_CARD_WIDTH = 336;

export const UPDATE_CARD_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
  :root {
    --bg: #ffffff; --fg: #16171b; --muted: #5d606b; --line: #dcdee5; --track: #e6e7ee;
    --accent: #5e6ad2; --accent-fg: #ffffff; --danger: #c2413b; --link: #4a55c4;
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #24252c; --fg: #e8e9ee; --muted: #a9acb8; --line: #3a3b44; --track: #3a3b44;
      --accent: #5e6ad2; --accent-fg: #ffffff; --danger: #c2413b; --link: #9ea6f0;
      color-scheme: dark;
    }
  }
  html, body { margin: 0; background: transparent; overflow: hidden; }
  body { padding: ${UPDATE_CARD_MARGIN}px; font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--fg); user-select: none; }
  .card { box-sizing: border-box; width: ${UPDATE_CARD_WIDTH}px; background: var(--bg); border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 6px 20px rgba(0,0,0,.28); padding: 14px; display: flex; flex-direction: column; gap: 10px; }
  .row { display: flex; gap: 10px; align-items: flex-start; }
  .text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .title { font-weight: 600; }
  .detail { color: var(--muted); font-size: 12px; }
  .x { flex: none; border: 0; background: none; color: var(--muted); font-size: 14px; line-height: 1; padding: 2px 4px; border-radius: 4px; cursor: pointer; }
  .bar { height: 4px; border-radius: 4px; background: var(--track); overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--accent); transition: width .3s ease; }
  .acts { display: flex; gap: 8px; align-items: center; justify-content: flex-end; }
  .notes { margin-right: auto; color: var(--link); font-size: 12px; background: none; border: 0; padding: 0; cursor: pointer; }
  .btn { font: 500 12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; border-radius: 6px; padding: 6px 12px; cursor: pointer; border: 1px solid var(--line); background: transparent; color: var(--fg); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
  .btn.danger { background: var(--danger); border-color: var(--danger); color: #fff; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  @media (prefers-reduced-motion: reduce) { .bar i { transition: none; } }
</style>
</head>
<body>
<div class="card" id="card" role="status" aria-live="polite"></div>
<script>
  function go(action) { location.href = "warptalk-update:" + action; }
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  window.render = function (model) {
    const card = document.getElementById("card");
    card.replaceChildren();
    const row = el("div", "row");
    const text = el("div", "text");
    text.append(el("div", "title", model.title), el("div", "detail", model.detail));
    row.append(text);
    if (model.dismissible) {
      const x = el("button", "x", "\\u2715");
      x.setAttribute("aria-label", "Dismiss");
      x.onclick = () => go("dismiss");
      row.append(x);
    }
    card.append(row);
    if (model.progress !== null) {
      const bar = el("div", "bar");
      const fill = el("i");
      fill.style.width = model.progress + "%";
      bar.append(fill);
      card.append(bar);
    }
    if (model.notes || model.buttons.length > 0) {
      const acts = el("div", "acts");
      if (model.notes) {
        const notes = el("button", "notes", "What's new");
        notes.onclick = () => go("notes");
        acts.append(notes);
      }
      for (const b of model.buttons) {
        const button = el("button", "btn " + b.style, b.label);
        button.onclick = () => go(b.action);
        acts.append(button);
      }
      card.append(acts);
    }
    return Math.ceil(document.body.getBoundingClientRect().height);
  };
</script>
</body>
</html>`;
