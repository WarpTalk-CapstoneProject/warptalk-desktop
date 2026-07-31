import { useState, type FormEvent, type JSX } from "react";

import { LineWaves } from "./LineWaves";
import { SplitText } from "./SplitText";
import { DashboardLayout } from "./components/dashboard/DashboardLayout";
import "./styles.css";

const CONTACT_URL = "https://warptalk.vn/#contact";
const WELCOME_TITLE = "Chào mừng bạn quay lại Warptalk";
const CONTACT_LABEL = "Liên hệ với chúng tôi";
const LOGIN_TITLE = "Đăng nhập";

type ViewMode = "welcome" | "login" | "dashboard";

function openContactPage(): void {
  void window.warptalk?.openExternal(CONTACT_URL);
}

export default function App(): JSX.Element {
  const [mode, setMode] = useState<ViewMode>("welcome");
  const [email, setEmail] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [emailSubmitted, setEmailSubmitted] = useState(false);

  const submitLogin = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!emailSubmitted) {
      setEmailSubmitted(true);
    } else {
      // User entered password and clicked Log In -> Transition to Dashboard
      setMode("dashboard");
    }
  };

  const handleGoogleLogin = () => {
    if (!email) setEmail("google.user@warptalk.vn");
    setMode("dashboard");
  };

  if (mode === "dashboard") {
    return (
      <DashboardLayout
        userEmail={email || "user@warptalk.vn"}
        onLogout={() => {
          setMode("welcome");
          setEmailSubmitted(false);
        }}
      />
    );
  }

  return (
    <main className="desktop-shell">
      <LineWaves
        brightness={0.32}
        color1="#ffffff"
        color2="#ffb88a"
        color3="#ffffff"
        innerLineCount={46}
        outerLineCount={54}
        mouseInfluence={2.1}
        offsetX={-0.1}
        offsetY={0.05}
        scale={1.42}
      />
      <div className="shell-vignette" />
      <div className="shell-gradient" />

      {mode === "welcome" ? (
        <section className="welcome-screen" aria-label="Warptalk welcome">
          <div className="hero">
            <SplitText text={WELCOME_TITLE} className="hero-title" />

            <div className="hero-actions">
              <button
                type="button"
                className="primary-button"
                onClick={() => setMode("login")}
              >
                Login
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={openContactPage}
              >
                {CONTACT_LABEL}
              </button>
            </div>
          </div>
        </section>
      ) : (
        <section className="login-panel" aria-label="Warptalk desktop login">
          <button
            type="button"
            className="back-button"
            onClick={() => {
              setMode("welcome");
              setEmailSubmitted(false);
            }}
          >
            Back
          </button>

          <div className="login-heading">
            <span>Warptalk-V1</span>
            <h2>{LOGIN_TITLE}</h2>
          </div>

          <form onSubmit={submitLogin} className="login-form">
            {!emailSubmitted ? (
              <>
                <button
                  type="button"
                  className="google-button"
                  onClick={handleGoogleLogin}
                >
                  <span>G</span>
                  Continue with Google
                </button>
                <div className="divider">
                  <span />
                  <strong>OR</strong>
                  <span />
                </div>
                <input
                  type="email"
                  placeholder="Email address"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoFocus
                  required
                />
                <button type="submit" className="primary-button full">
                  Continue
                </button>
              </>
            ) : (
              <>
                <div className="email-review">
                  <span>{email}</span>
                  <button
                    type="button"
                    onClick={() => setEmailSubmitted(false)}
                  >
                    Edit
                  </button>
                </div>
                <div className="password-field">
                  <input
                    type={passwordVisible ? "text" : "password"}
                    placeholder="Password"
                    autoFocus
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setPasswordVisible((value) => !value)}
                  >
                    {passwordVisible ? "Hide" : "Show"}
                  </button>
                </div>
                <button type="submit" className="primary-button full">
                  Log In
                </button>
              </>
            )}
          </form>
        </section>
      )}
    </main>
  );
}
