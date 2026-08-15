import type { JSX } from "react";

import "./styles.css";

export default function App(): JSX.Element {
  return (
    <main className="desktop-fallback">
      <div className="desktop-fallback-panel">
        <span className="desktop-fallback-mark">W</span>
        <h1>WarpTalk</h1>
        <p>
          Không kết nối được tới giao diện Warptalk Web. Kiểm tra kết nối mạng
          rồi mở lại ứng dụng.
        </p>
      </div>
    </main>
  );
}
