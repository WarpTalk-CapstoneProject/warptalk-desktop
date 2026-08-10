import type { JSX } from "react";

import "./styles.css";

export default function App(): JSX.Element {
  return (
    <main className="desktop-fallback">
      <div className="desktop-fallback-panel">
        <span className="desktop-fallback-mark">W</span>
        <h1>Warptalk-V1</h1>
        <p>Dang mo giao dien Warptalk Web trong ung dung desktop...</p>
      </div>
    </main>
  );
}
