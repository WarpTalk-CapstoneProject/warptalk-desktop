import { useState, type FormEvent, type JSX } from "react";

import { LineWaves } from "./LineWaves";
import { SplitText } from "./SplitText";
import "./styles.css";

const CONTACT_URL = "https://warptalk.vn/#contact";
const WELCOME_TITLE = "Ch\u00e0o m\u1eebng b\u1ea1n quay tr\u1edf l\u1ea1i Warptalk";
const CONTACT_LABEL = "Li\u00ean h\u1ec7 v\u1edbi ch\u00fang t\u00f4i";
const LOGIN_TITLE = "\u0110\u0103ng nh\u1eadp";

type ViewMode = "welcome" | "login";

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
    }
  };

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
                <button type="button" className="google-button">
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
