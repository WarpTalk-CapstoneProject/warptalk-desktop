import React, { useState } from "react";
import { Sparkles, Send, Bot, FileText, Download } from "lucide-react";

export const AIChatView: React.FC = () => {
  const [messages, setMessages] = useState([
    {
      id: "1",
      sender: "ai",
      text: "Xin chào! Tôi là Trợ lý AI Warptalk Desktop. Tôi có thể hỗ trợ tóm tắt các cuộc họp gần nhất, dịch tài liệu hoặc trích xuất hành động (action items) giúp bạn.",
      time: "10:00",
    },
  ]);
  const [inputMsg, setInputMsg] = useState("");

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputMsg.trim()) return;

    const userMsg = {
      id: Date.now().toString(),
      sender: "user",
      text: inputMsg.trim(),
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInputMsg("");

    setTimeout(() => {
      const aiReply = {
        id: (Date.now() + 1).toString(),
        sender: "ai",
        text: `Đã nhận câu hỏi của bạn: "${userMsg.text}". Đang xử lý tóm tắt với mô hình LLM Warptalk...`,
        time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      };
      setMessages((prev) => [...prev, aiReply]);
    }, 800);
  };

  return (
    <div className="ai-chat-view">
      <div className="chat-header">
        <div className="chat-header-info">
          <Sparkles className="sparkle-icon" size={20} />
          <div>
            <h2>Warptalk AI Assistant</h2>
            <p>Tóm tắt thông minh & Hỏi đáp nội dung cuộc họp</p>
          </div>
        </div>
        <button
          type="button"
          className="secondary-btn"
          onClick={() => alert("Xuất báo cáo tóm tắt dưới dạng file PDF/Markdown")}
        >
          <Download size={14} /> Xuất Báo Cáo
        </button>
      </div>

      <div className="chat-messages">
        {messages.map((m) => (
          <div key={m.id} className={`chat-bubble ${m.sender}`}>
            <div className="bubble-header">
              {m.sender === "ai" ? <Bot size={14} /> : null}
              <span>{m.sender === "ai" ? "Warptalk AI" : "Bạn"}</span>
              <span className="msg-time">{m.time}</span>
            </div>
            <p className="bubble-text">{m.text}</p>
          </div>
        ))}
      </div>

      <form onSubmit={handleSend} className="chat-input-area">
        <input
          type="text"
          placeholder="Hỏi AI về cuộc họp vừa qua hoặc yêu cầu tóm tắt..."
          value={inputMsg}
          onChange={(e) => setInputMsg(e.target.value)}
          className="chat-input"
        />
        <button type="submit" className="primary-btn">
          <Send size={16} />
        </button>
      </form>
    </div>
  );
};
