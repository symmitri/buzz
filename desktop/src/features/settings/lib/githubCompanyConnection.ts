export interface GitHubSetupSession {
  id: string;
  phase:
    | "registration"
    | "converting"
    | "vaulting"
    | "installation"
    | "verifying"
    | "completed"
    | "failed"
    | "expired";
  expires_at: string;
  can_resume: boolean;
  agent_access_granted: false;
  provider_read_verified: false;
  connection_id?: string;
  error_code?: string;
}

export interface GitHubSetupView {
  revision: string;
  capability: {
    configured: true;
    administrator_id: string;
    organisation_id: string;
    account_login: string;
    repository_scope: "selected" | "all";
    repositories: string[];
    read_tools: string[];
    in_progress: boolean;
    can_start: boolean;
    session?: GitHubSetupSession;
  };
}

export type GitHubSetupResult =
  | { state: "ready"; view: GitHubSetupView }
  | { state: "opened"; view: GitHubSetupView }
  | { state: "uncertain"; view: GitHubSetupView | null; message: string }
  | {
      state:
        | "conflict"
        | "access_lost"
        | "denied"
        | "unsupported"
        | "unavailable"
        | "invalid";
      message: string;
    };

export function githubSetupStatus(view: GitHubSetupView): string {
  switch (view.capability.session?.phase) {
    case "registration":
      return "Waiting for GitHub App registration";
    case "converting":
    case "vaulting":
      return "Saving the company App";
    case "installation":
      return "Waiting for repository selection in GitHub";
    case "verifying":
      return "Checking the installation";
    case "completed":
      return "Company connection configured";
    case "expired":
      return "Setup link expired";
    case "failed":
      return "Setup needs attention";
    default:
      return view.capability.in_progress
        ? "Another administrator is completing setup"
        : view.capability.can_start
          ? "Ready to connect"
          : "No setup action is currently available";
  }
}
