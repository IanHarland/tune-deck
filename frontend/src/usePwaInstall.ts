// PWA install state. Android/desktop Chrome fire `beforeinstallprompt`, which we
// stash so a button can trigger the native install. iOS Safari exposes NO such
// API (Apple blocks programmatic Add-to-Home-Screen), so there we just detect
// the platform and the UI shows manual Share → Add to Home Screen instructions.
//
// Web-only (uses window) — stays out of the portable core/.
import { useEffect, useState } from "react";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

// Module-level so we catch the event even if it fires before the hook mounts
// (it self-registers at app startup when this module is first imported).
let deferred: BeforeInstallPromptEvent | null = null;
const subscribers = new Set<() => void>();
const notify = () => subscribers.forEach((fn) => fn());

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // suppress the default mini-infobar; we drive it ourselves
    deferred = e as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    notify();
  });
}

function detectStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    // iOS Safari's non-standard flag for home-screen apps
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function detectIOS(): boolean {
  if (typeof window === "undefined") return false;
  const ua = window.navigator.userAgent;
  const isIDevice = /iphone|ipad|ipod/i.test(ua);
  // iPadOS 13+ reports as desktop Mac — sniff a touch-capable "Mac"
  const isIPadOS =
    window.navigator.platform === "MacIntel" && window.navigator.maxTouchPoints > 1;
  return isIDevice || isIPadOS;
}

export interface PwaInstall {
  canPrompt: boolean; // native install prompt is available (Android/desktop Chrome)
  ios: boolean; // iOS — needs manual Share → Add to Home Screen
  standalone: boolean; // already installed / launched as an app
  promptInstall: () => Promise<void>;
}

export function usePwaInstall(): PwaInstall {
  const [, force] = useState(0);
  const [standalone] = useState(detectStandalone);

  useEffect(() => {
    const rerender = () => force((n) => n + 1);
    subscribers.add(rerender);
    return () => {
      subscribers.delete(rerender);
    };
  }, []);

  return {
    canPrompt: deferred !== null,
    ios: detectIOS(),
    standalone,
    async promptInstall() {
      if (!deferred) return;
      await deferred.prompt();
      try {
        await deferred.userChoice;
      } catch {
        /* user dismissed — nothing to do */
      }
      deferred = null; // a prompt can only be used once
      notify();
    },
  };
}
