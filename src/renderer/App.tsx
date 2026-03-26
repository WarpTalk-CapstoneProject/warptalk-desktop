/**
 * WarpTalk Desktop — React App Entry Point
 */

import React from "react";

export default function App(): React.JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        background: "linear-gradient(135deg, #0f0c29, #302b63, #24243e)",
        color: "#ffffff",
        fontFamily: "'Inter', -apple-system, sans-serif",
      }}
    >
      <h1 style={{ fontSize: "2.5rem", marginBottom: "0.5rem" }}>
        🎙️ WarpTalk Desktop
      </h1>
      <p style={{ opacity: 0.7, fontSize: "1.1rem" }}>
        Real-time translation — desktop client
      </p>
      <div
        style={{
          marginTop: "2rem",
          padding: "1rem 2rem",
          borderRadius: "12px",
          background: "rgba(255,255,255,0.1)",
          backdropFilter: "blur(10px)",
        }}
      >
        <p>🚧 Under Construction — Workers & UI coming soon</p>
      </div>
    </div>
  );
}
