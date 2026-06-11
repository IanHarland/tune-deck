import { useState } from "react";
import { usePwaInstall } from "../usePwaInstall";

// iOS Safari's Share glyph (box with an up-arrow), so the instructions point at
// the right toolbar button.
function ShareGlyph() {
  return (
    <svg className="share-glyph" viewBox="0 0 24 24" width="15" height="15" aria-hidden>
      <path
        d="M12 3.2l3.2 3.2-1.1 1.1L12.8 6.3V14.5h-1.6V6.3L9.9 7.5 8.8 6.4 12 3.2z"
        fill="currentColor"
      />
      <path
        d="M6.5 10.5H8v1.6H6.6v6.8h10.8v-6.8H16v-1.6h1.6c.7 0 1.3.6 1.3 1.3v7.6c0 .7-.6 1.3-1.3 1.3H6.4c-.7 0-1.3-.6-1.3-1.3v-7.6c0-.7.6-1.3 1.3-1.3z"
        fill="currentColor"
      />
    </svg>
  );
}

// "Add to Home Screen" — a one-tap native install on Android/desktop Chrome, or
// manual Share-sheet instructions on iOS (where the OS blocks programmatic A2HS).
// Renders nothing when already installed or when the platform can't install.
export default function InstallButton() {
  const { canPrompt, ios, standalone, promptInstall } = usePwaInstall();
  const [showTip, setShowTip] = useState(false);

  if (standalone) return null; // already running as an app
  if (!canPrompt && !ios) return null; // not installable here (e.g. desktop Safari/FF)

  return (
    <div className="install">
      <button
        className="install-btn"
        onClick={() => (canPrompt ? promptInstall() : setShowTip((v) => !v))}
      >
        ⬇ Add to Home Screen
      </button>

      {showTip && ios && (
        <div className="install-tip" role="dialog" aria-label="Add to Home Screen">
          <p className="install-tip-text">
            In Safari, tap <ShareGlyph /> <b>Share</b> at the bottom, then scroll to{" "}
            <b>Add to Home Screen</b>.
          </p>
          <button className="install-tip-close" onClick={() => setShowTip(false)}>
            Got it
          </button>
        </div>
      )}
    </div>
  );
}
