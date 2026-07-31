import React, { useState } from "react";
import { Mic, Volume2, Globe, Sliders, ShieldCheck, Monitor } from "lucide-react";

export const SettingsView: React.FC = () => {
  const [selectedMic, setSelectedMic] = useState("default-mic");
  const [selectedSpeaker, setSelectedSpeaker] = useState("default-speaker");
  const [targetLanguage, setTargetLanguage] = useState("vi");
  const [noiseReduction, setNoiseReduction] = useState(true);
  const [minimizeToTray, setMinimizeToTray] = useState(true);

  return (
    <div className="settings-view">
      <div className="settings-header">
        <h1 className="view-title">Cài Đặt & Cấu Hình Desktop</h1>
        <p className="view-subtitle">
          Tùy chỉnh thiết bị âm thanh, thuật toán xử lý giọng nói và các tùy chọn ứng dụng.
        </p>
      </div>

      <div className="settings-sections">
        {/* Audio Devices */}
        <section className="settings-section">
          <div className="section-title">
            <Mic size={18} />
            <h2>Thiết Bị Âm Thanh</h2>
          </div>
          
          <div className="setting-row">
            <div className="setting-label">
              <span>Microphone Đầu Vào</span>
              <small>Thiết bị ghi âm giọng nói của bạn để xử lý dịch.</small>
            </div>
            <select
              value={selectedMic}
              onChange={(e) => setSelectedMic(e.target.value)}
              className="setting-select"
            >
              <option value="default-mic">Microphone Mặc Định (Realtek High Definition Audio)</option>
              <option value="headset-mic">Headset Microphone (Wireless Audio Device)</option>
            </select>
          </div>

          <div className="setting-row">
            <div className="setting-label">
              <span>Loa Đầu Ra</span>
              <small>Thiết bị phát âm thanh cuộc họp và giọng dịch AI.</small>
            </div>
            <select
              value={selectedSpeaker}
              onChange={(e) => setSelectedSpeaker(e.target.value)}
              className="setting-select"
            >
              <option value="default-speaker">Loa Mặc Định (Realtek Audio Output)</option>
              <option value="headphones">Tai nghe Stereo (Bluetooth Audio)</option>
            </select>
          </div>
        </section>

        {/* AI & Translation Settings */}
        <section className="settings-section">
          <div className="section-title">
            <Globe size={18} />
            <h2>Dịch Thuật & AI Process</h2>
          </div>

          <div className="setting-row">
            <div className="setting-label">
              <span>Ngôn Ngữ Dịch Mặc Định</span>
              <small>Ngôn ngữ bạn ưu tiên nhận bản dịch khi tham gia phòng họp bất kỳ.</small>
            </div>
            <select
              value={targetLanguage}
              onChange={(e) => setTargetLanguage(e.target.value)}
              className="setting-select"
            >
              <option value="vi">Tiếng Việt (Vietnamese)</option>
              <option value="en">Tiếng Anh (English)</option>
              <option value="ja">Tiếng Nhật (Japanese)</option>
              <option value="ko">Tiếng Hàn (Korean)</option>
            </select>
          </div>

          <div className="setting-row">
            <div className="setting-label">
              <span>Lọc Nhiễu Âm Thanh (Noise Suppression)</span>
              <small>Sử dụng AI Krisp/LiveKit lọc tiếng ồn xung quanh khi capture micro.</small>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={noiseReduction}
                onChange={(e) => setNoiseReduction(e.target.checked)}
              />
              <span className="slider round"></span>
            </label>
          </div>
        </section>

        {/* Desktop Application Behavior */}
        <section className="settings-section">
          <div className="section-title">
            <Monitor size={18} />
            <h2>Hệ Thống & Khay Hệ Thống (System Tray)</h2>
          </div>

          <div className="setting-row">
            <div className="setting-label">
              <span>Thu Nhỏ Về Khay Hệ Thống Khi Đóng</span>
              <small>Giữ ứng dụng chạy ẩn dưới System Tray khi bạn bấm nút [X] đóng cửa sổ.</small>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={minimizeToTray}
                onChange={(e) => setMinimizeToTray(e.target.checked)}
              />
              <span className="slider round"></span>
            </label>
          </div>
        </section>
      </div>
    </div>
  );
};
