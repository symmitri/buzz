import * as React from "react";
import { Plug } from "lucide-react";

import { connectionProviderLogos } from "./connectionProviderLogos";

const normalize = (value: string) =>
  value.trim().toLowerCase().replaceAll("_", "-");

export function ConnectionProviderLogo({
  provider,
  connectorId = "",
}: {
  provider: string;
  connectorId?: string;
}) {
  const mark =
    connectionProviderLogos.get(normalize(provider)) ??
    connectionProviderLogos.get(normalize(connectorId));
  const [failed, setFailed] = React.useState<string | null>(null);
  const available = mark && failed !== mark.name;

  return (
    <span
      aria-hidden="true"
      className="grid h-7 w-7 shrink-0 place-items-center"
      data-provider-logo={available ? mark.name : "unknown"}
    >
      {available ? (
        <>
          <img
            alt=""
            className={`h-6 w-6 object-contain ${mark.dark ? "dark:hidden" : mark.monochrome ? "dark:invert" : ""}`}
            data-logo-theme={mark.dark ? "light" : "any"}
            onError={() => setFailed(mark.name)}
            src={mark.light}
          />
          {mark.dark ? (
            <img
              alt=""
              className="hidden h-6 w-6 object-contain dark:block"
              data-logo-theme="dark"
              onError={() => setFailed(mark.name)}
              src={mark.dark}
            />
          ) : null}
        </>
      ) : (
        <Plug className="h-5 w-5 text-muted-foreground" />
      )}
    </span>
  );
}
