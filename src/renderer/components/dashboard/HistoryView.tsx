import React from "react";
import { History, FileText, Download, Play, Calendar } from "lucide-react";

export const HistoryView: React.FC = () => {
  const historyItems = [
    {
      id: "h1",
      title: "Họp Sprint Review Q2 & Demo AI Translate",
      date: "30/07/2026",
      duration: "45 phút",
      speakers: 8,
      transcriptSummary: "Thảo luận về tính năng dịch thời gian thực trên Desktop client...",
    },
    {
      id: "h2",
      title: "Đánh Giá Kiến Trúc Backend SignalR & LiveKit",
      date: "28/07/2026",
      duration: "60 phút",
      speakers: 4,
      transcriptSummary: "Tối ưu hóa độ trễ audio capture dưới 200ms...",
    },
  ];

  return (
    <div className="history-view">
      <div className="history-header">
        <h1 className="view-title">Lịch Sử Cuộc Họp & Bản Ghi Transcript</h1>
        <p className="view-subtitle">
          Xem lại bản ghi thoại, phụ đề đã dịch và tóm tắt cuộc họp từ các phiên trước.
        </p>
      </div>

      <div className="history-list">
        {historyItems.map((item) => (
          <div key={item.id} className="history-card">
            <div className="history-card-header">
              <div className="history-title-group">
                <FileText size={18} className="history-icon" />
                <h3>{item.title}</h3>
              </div>
              <span className="history-date">
                <Calendar size={12} /> {item.date} ({item.duration})
              </span>
            </div>

            <p className="history-summary">{item.transcriptSummary}</p>

            <div className="history-actions">
              <button
                type="button"
                className="secondary-btn small"
                onClick={() => alert(`Đang tải transcript cuộc họp ${item.title}...`)}
              >
                <Download size={14} /> Tải Transcript
              </button>
              <button
                type="button"
                className="primary-btn small"
                onClick={() => alert(`Phát lại audio cuộc họp ${item.title}...`)}
              >
                <Play size={14} /> Phát Lại Audio
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
