import React, { useState } from "react";
import {
  Plus,
  LogIn,
  Video,
  Users,
  Globe,
  Clock,
  Sparkles,
  Search,
  Copy,
  Check,
} from "lucide-react";

interface Room {
  id: string;
  code: string;
  name: string;
  host: string;
  participants: number;
  sourceLang: string;
  targetLangs: string[];
  isLive: boolean;
  createdAt: string;
}

export const RoomsView: React.FC = () => {
  const [searchQuery, setSearchQuery] = useState("");
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [joinCodeInput, setJoinCodeInput] = useState("");
  const [newRoomName, setNewRoomName] = useState("");
  const [targetLang, setTargetLang] = useState("vi");

  const [rooms, setRooms] = useState<Room[]>([
    {
      id: "1",
      code: "WT-8821",
      name: "Họp Kỹ Thuật & Kiến Trúc Core Dịch",
      host: "Tran Manh Tuan",
      participants: 6,
      sourceLang: "Tiếng Anh (US)",
      targetLangs: ["Tiếng Việt", "Tiếng Nhật"],
      isLive: true,
      createdAt: "10 phút trước",
    },
    {
      id: "2",
      code: "WT-4190",
      name: "Demo Sản Phẩm Warptalk-V1 Desktop Client",
      host: "WarpTalk Team",
      participants: 12,
      sourceLang: "Tiếng Việt",
      targetLangs: ["Tiếng Anh", "Tiếng Trung"],
      isLive: true,
      createdAt: "35 phút trước",
    },
    {
      id: "3",
      code: "WT-1092",
      name: "Thảo Luận Chiến Lược Phát Triển Q3/2026",
      host: "PM Lead",
      participants: 3,
      sourceLang: "Tiếng Hàn",
      targetLangs: ["Tiếng Việt"],
      isLive: false,
      createdAt: "2 giờ trước",
    },
  ]);

  const handleCopyCode = (code: string) => {
    void navigator.clipboard.writeText(code);
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 2000);
  };

  const handleCreateRoom = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRoomName.trim()) return;

    const created: Room = {
      id: Date.now().toString(),
      code: `WT-${Math.floor(1000 + Math.random() * 9000)}`,
      name: newRoomName.trim(),
      host: "Bạn (Desktop)",
      participants: 1,
      sourceLang: "Tiếng Việt",
      targetLangs: [targetLang === "vi" ? "Tiếng Việt" : "Tiếng Anh"],
      isLive: true,
      createdAt: "Vừa xong",
    };

    setRooms([created, ...rooms]);
    setNewRoomName("");
    setShowCreateModal(false);
  };

  const handleJoinRoom = (e: React.FormEvent) => {
    e.preventDefault();
    if (!joinCodeInput.trim()) return;
    alert(`Đang kết nối tới phòng họp mã [${joinCodeInput.trim().toUpperCase()}]...`);
    setJoinCodeInput("");
    setShowJoinModal(false);
  };

  const filteredRooms = rooms.filter((r) =>
    r.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    r.code.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="rooms-view">
      {/* Top Banner / Actions */}
      <div className="rooms-header">
        <div>
          <h1 className="view-title">Phòng Họp Trực Tuyến</h1>
          <p className="view-subtitle">
            Tham gia hoặc tạo phòng dịch tự động thời gian thực bằng công nghệ AI.
          </p>
        </div>
        <div className="action-buttons">
          <button
            type="button"
            className="secondary-btn"
            onClick={() => setShowJoinModal(true)}
          >
            <LogIn size={16} />
            Tham Gia Phòng
          </button>
          <button
            type="button"
            className="primary-btn glow"
            onClick={() => setShowCreateModal(true)}
          >
            <Plus size={16} />
            Tạo Phòng Mới
          </button>
        </div>
      </div>

      {/* Search Bar */}
      <div className="search-bar-container">
        <Search size={16} className="search-icon" />
        <input
          type="text"
          placeholder="Tìm kiếm tên phòng hoặc mã phòng (VD: WT-8821)..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="search-input"
        />
      </div>

      {/* Rooms Grid */}
      <div className="rooms-grid">
        {filteredRooms.map((room) => (
          <div key={room.id} className="room-card">
            <div className="room-card-header">
              <span className={`live-badge ${room.isLive ? "active" : "offline"}`}>
                <span className="live-dot" />
                {room.isLive ? "Đang Diễn Ra" : "Đã Kết Thúc"}
              </span>
              <button
                type="button"
                className="code-chip"
                onClick={() => handleCopyCode(room.code)}
                title="Sao chép mã phòng"
              >
                {room.code}
                {copiedCode === room.code ? (
                  <Check size={12} className="copy-icon text-success" />
                ) : (
                  <Copy size={12} className="copy-icon" />
                )}
              </button>
            </div>

            <h3 className="room-title">{room.name}</h3>

            <div className="room-meta">
              <div className="meta-item">
                <Users size={14} />
                <span>{room.participants} người tham gia</span>
              </div>
              <div className="meta-item">
                <Globe size={14} />
                <span>{room.sourceLang} → {room.targetLangs.join(", ")}</span>
              </div>
              <div className="meta-item">
                <Clock size={14} />
                <span>{room.createdAt}</span>
              </div>
            </div>

            <div className="room-card-footer">
              <span className="host-info">Chủ phòng: {room.host}</span>
              <button
                type="button"
                className="join-room-btn"
                onClick={() => alert(`Vào phòng ${room.name} (${room.code})`)}
              >
                <Video size={14} />
                Vào Phòng
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Modal Join Room */}
      {showJoinModal && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3>Tham Gia Phòng Họp</h3>
            <p>Nhập mã phòng được chia sẻ từ đồng nghiệp hoặc máy chủ.</p>
            <form onSubmit={handleJoinRoom}>
              <input
                type="text"
                placeholder="VD: WT-8821"
                value={joinCodeInput}
                onChange={(e) => setJoinCodeInput(e.target.value)}
                autoFocus
                className="modal-input"
                required
              />
              <div className="modal-actions">
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={() => setShowJoinModal(false)}
                >
                  Hủy
                </button>
                <button type="submit" className="primary-btn">
                  Vào Cuộc Họp
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal Create Room */}
      {showCreateModal && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3>Tạo Phòng Họp Mới</h3>
            <p>Thiết lập cuộc họp đa ngôn ngữ tức thì trên Desktop Client.</p>
            <form onSubmit={handleCreateRoom}>
              <div className="form-group">
                <label>Tên Cuộc Họp</label>
                <input
                  type="text"
                  placeholder="VD: Thảo luận sprint phát triển Warptalk"
                  value={newRoomName}
                  onChange={(e) => setNewRoomName(e.target.value)}
                  autoFocus
                  className="modal-input"
                  required
                />
              </div>

              <div className="form-group">
                <label>Ngôn Ngữ Đích Dịch</label>
                <select
                  value={targetLang}
                  onChange={(e) => setTargetLang(e.target.value)}
                  className="modal-select"
                >
                  <option value="vi">Tiếng Việt (Vietnamese)</option>
                  <option value="en">Tiếng Anh (English)</option>
                  <option value="ja">Tiếng Nhật (Japanese)</option>
                  <option value="ko">Tiếng Hàn (Korean)</option>
                </select>
              </div>

              <div className="modal-actions">
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={() => setShowCreateModal(false)}
                >
                  Hủy
                </button>
                <button type="submit" className="primary-btn glow">
                  <Sparkles size={14} /> Tạo Phòng Ngay
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
