import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { GOOGLE_CLIENT_ID } from "./api";

interface GsiIdConfig {
  client_id: string;
  callback: (response: { credential?: string }) => void;
  auto_select?: boolean;
  cancel_on_tap_outside?: boolean;
  itp_support?: boolean;
}

interface GsiButtonConfig {
  type?: "standard" | "icon";
  theme?: "outline" | "filled_blue" | "filled_black";
  size?: "small" | "medium" | "large";
  text?: "signin_with" | "signup_with" | "continue_with" | "signin";
  shape?: "rectangular" | "pill" | "circle" | "square";
  width?: number;
  logo_alignment?: "left" | "center";
}

type GsiWindow = Window & {
  google?: {
    accounts?: {
      id?: {
        initialize: (config: GsiIdConfig) => void;
        renderButton: (parent: HTMLElement, options: GsiButtonConfig) => void;
      };
    };
  };
};

const GSI_SRC = "https://accounts.google.com/gsi/client";
let gsiPromise: Promise<void> | null = null;

/** Load Google Identity Services once, on demand. */
function loadGsi(): Promise<void> {
  if (gsiPromise) return gsiPromise;
  gsiPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GSI_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Google sign-in did not load.")));
      if ((window as GsiWindow).google?.accounts?.id) resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = GSI_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Google sign-in did not load."));
    document.head.appendChild(script);
  });
  return gsiPromise;
}

export interface GoogleButtonProps {
  /** Receives the Google ID token (a JWT) to hand to the Parse google adapter. */
  onCredential: (credential: string) => void;
  onError: (message: string) => void;
  disabled?: boolean;
}

/**
 * "Continue with Google", rendered by Google Identity Services because the
 * Parse `google` auth adapter needs a real, Google-issued ID token and GIS only
 * hands one to its own button. Renders nothing when VITE_GOOGLE_CLIENT_ID is
 * unset, or when the GIS script cannot be reached.
 */
export function GoogleButton({ onCredential, onError, disabled }: GoogleButtonProps) {
  const { t } = useTranslation();
  const host = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const credentialRef = useRef(onCredential);
  const errorRef = useRef(onError);

  // Keep the callbacks fresh without re-initialising GIS on every render.
  useEffect(() => {
    credentialRef.current = onCredential;
    errorRef.current = onError;
  });

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return;
    let cancelled = false;
    loadGsi()
      .then(() => {
        if (cancelled || !host.current) return;
        const id = (window as GsiWindow).google?.accounts?.id;
        if (!id) {
          setFailed(true);
          return;
        }
        id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          itp_support: true,
          cancel_on_tap_outside: true,
          callback: (response) => {
            if (response.credential) credentialRef.current(response.credential);
            else errorRef.current(t("auth.errors.googleNoToken"));
          }
        });
        host.current.replaceChildren();
        id.renderButton(host.current, {
          type: "standard",
          theme: "outline",
          size: "large",
          text: "continue_with",
          shape: "rectangular",
          logo_alignment: "left",
          width: 400
        });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!GOOGLE_CLIENT_ID || failed) return null;

  return (
    <div
      ref={host}
      // GIS renders its own button; the wrapper only owns layout and the
      // disabled affordance while a sign-in is already in flight.
      className={disabled ? "min-h-10 pointer-events-none opacity-50" : "min-h-10"}
    />
  );
}
