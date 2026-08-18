import { useEffect, useMemo, useRef, type JSX } from "react";
import { gsap } from "gsap";

type SplitTextProps = {
  text: string;
  className?: string;
  delay?: number;
  duration?: number;
  ease?: string;
  from?: gsap.TweenVars;
  to?: gsap.TweenVars;
  onAnimationComplete?: () => void;
};

export function SplitText({
  text,
  className = "",
  delay = 34,
  duration = 0.9,
  ease = "power3.out",
  from = { opacity: 0, y: 42, filter: "blur(10px)" },
  to = { opacity: 1, y: 0, filter: "blur(0px)" },
  onAnimationComplete,
}: SplitTextProps): JSX.Element {
  const rootRef = useRef<HTMLHeadingElement | null>(null);
  const parts = useMemo(() => text.split(/(\s+)/), [text]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const targets = root.querySelectorAll<HTMLElement>(".split-char");
    const tween = gsap.fromTo(targets, from, {
      ...to,
      duration,
      ease,
      stagger: delay / 1000,
      onComplete: onAnimationComplete,
      willChange: "transform, opacity, filter",
      force3D: true,
    });

    return () => {
      tween.kill();
    };
  }, [delay, duration, ease, from, onAnimationComplete, to, text]);

  return (
    <h1 ref={rootRef} className={`split-title ${className}`}>
      {parts.map((part, partIndex) =>
        /^\s+$/.test(part) ? (
          <span aria-hidden="true" className="split-space" key={partIndex}>
            {part}
          </span>
        ) : (
          <span aria-hidden="true" className="split-word" key={partIndex}>
            {Array.from(part).map((char, charIndex) => (
              <span className="split-char" key={`${char}-${charIndex}`}>
                {char}
              </span>
            ))}
          </span>
        ),
      )}
      <span className="sr-only">{text}</span>
    </h1>
  );
}
