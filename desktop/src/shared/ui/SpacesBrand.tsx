// Symmitri modification: optional Alpha skin over Buzz's unchanged UI contracts.
import type { CSSProperties } from "react";

export function SpacesMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={className}
      style={{
        display: "block",
        aspectRatio: "1 / 1",
        backgroundColor: "currentColor",
        mask: "url('/symmitri-logomark.svg') center / contain no-repeat",
        WebkitMask: "url('/symmitri-logomark.svg') center / contain no-repeat",
      }}
    />
  );
}

export function SpacesLogo({
  className,
  ariaLabel = "symmitri",
  fullScreen = true,
  showBackground = true,
  style,
}: {
  className?: string;
  ariaLabel?: string;
  fullScreen?: boolean;
  showBackground?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div
      className={[
        "buzz-logo",
        fullScreen ? "buzz-logo--screen" : "buzz-logo--compact",
        showBackground && "buzz-logo--background",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      role="img"
      aria-label={ariaLabel}
      style={style}
    >
      <SpacesMark className="buzz-logo__mark" />
    </div>
  );
}

export function SpacesWelcomeTitle() {
  return (
    <div className="flex flex-col items-center gap-5">
      <h1 className="text-6xl font-semibold tracking-tight text-foreground">
        Spaces <span className="text-2xl font-normal">Alpha</span>
      </h1>
      <img
        alt="by symmitri"
        className="h-6 w-auto dark:invert"
        src="/symmitri-wordmark.svg"
      />
    </div>
  );
}
